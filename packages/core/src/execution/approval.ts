/**
 * Approval gating at the execution seam — the two places a command actually
 * reaches a shell: the `run` tool's workspace shortcut (a raw `Shell`) and
 * every `ExecutorProvider`'s `exec`/`startProcess` tool (workspace, sandbox,
 * laptop — reached both by `run`'s router dispatch AND by codemode's
 * `<name>.exec()` namespace calls inside `execute_tools`).
 *
 * Before this, the gate lived inside the `run` TOOL's own executor — one
 * call site out of the many that reach the same shells. `execute_tools`
 * calling `workspace.exec()` / `sandbox.exec()` /
 * `laptop.exec()` skipped it entirely: same shell, same permissions, no
 * review. Moving the gate here closes that hole with ONE implementation
 * (safety/approval-gate.ts's `gateExec`) applied at construction, not N
 * copies re-derived at each call site.
 *
 * `workspace.exec` is gated once, at its `Shell` (withApprovalGatedShell) —
 * `createInlineExecutor` is a thin wrapper over that same `Shell.exec`, so
 * the provider gate skips that tool to avoid reviewing the command twice.
 * A hosted workspace's `startProcess` reaches the remote session directly,
 * however, and is gated here like every other background process surface.
 * Every other executor kind has no shared primitive underneath it (sandbox
 * talk to a remote SDK, laptop forwards over a device-tunnel RPC), so those
 * are gated at the ExecutorProvider boundary instead — the ExecutionRouter's
 * `register()` calls `gateProviderExec` for everything it accepts, so a
 * future executor kind is covered automatically, not by remembering to wrap
 * it.
 */

import { gateExec, STRICT_NO_CHANNEL_POLICY, type ShellApprovalPolicy } from '../safety/approval-gate';
import { parseRefusal } from './exec-result';
import * as v from 'valibot';
import type { ExecutorProvider, ExecutorTool, ExecutorToolResult } from './types';
import type { Shell, ShellExecOptions, ShellExecResult } from '../types/primitives';

const ShellExecOptionsSchema: v.GenericSchema<ShellExecOptions | undefined> = v.optional(v.object({
  stdin: v.optional(v.string()),
  signal: v.optional(v.instance(AbortSignal)),
}));

/** An executor tool's result on its STRING channel — the only shape a
 *  classified refusal can arrive on (`execution/exec-result.ts`). */
const ResultTextSchema = v.string();

function parseShellExecOptions(input: { value: unknown }): string | ShellExecOptions | undefined {
  const text = v.safeParse(v.string(), input.value);
  if (text.success) return text.output;
  const options = v.safeParse(ShellExecOptionsSchema, input.value);
  return options.success ? options.output : undefined;
}

/**
 * Gate a `Shell`'s `exec` — the primitive the `run` tool's workspace branch
 * calls directly and `createInlineExecutor`'s `workspace.exec()` calls
 * underneath it. A denial is shaped as a failed command
 * (`exitCode: 1`, the message on stderr) rather than thrown, so it renders
 * through the same `formatExecResult` every caller already applies and reads
 * as a normal (failing) tool result to the model.
 *
 * No `refusalCode` reader is passed, and that is a statement about the shape
 * rather than an omission: `ShellExecResult` is three fields of a process that
 * ran, with no channel for a classification, and no `Shell` in this tree writes
 * a refusal payload onto one. A reader here would have to read PROSE off
 * stderr, which is a command's own output and not a classification. So a
 * deferred grant spent on the workspace shell is consumed whatever happens —
 * which is also the case the refund was never for: the workspace is the agent's
 * own box, always attached, and "the executor was not there" cannot arise.
 */
export function withApprovalGatedShell(
  shell: Shell,
  policy: ShellApprovalPolicy = STRICT_NO_CHANNEL_POLICY,
): Shell {
  // 'workspace': this wrapper exists for the workspace shell specifically —
  // the one executor gateProviderExec skips, because it is gated here instead.
  // Nothing else may be wrapped with it; another machine's shell reaches the
  // gate through its own ExecutorProvider, under that provider's own name.
  const execute = gateExec<ShellExecResult>(
    (command, ...rest) => shell.exec(command, parseShellExecOptions({ value: rest[0] })),
    (message) => ({ stdout: '', stderr: message, exitCode: 1 }),
    'workspace',
    policy,
  );
  return {
    exec: (command, stdinOrOptions) => execute(command, stdinOrOptions),
  };
}

/** Tool names that take a raw shell command as their first argument and hand
 *  it to a real process — the surface `reviewCommand`'s regex ruleset was
 *  written for. Every ExecutorProvider kind names its synchronous runner
 *  `exec`; Nimbus additionally exposes `startProcess` (the same risk,
 *  backgrounded) — see execution/nimbus.ts. VFS-shaped tools (`readFile`,
 *  `writeFile`, `readdir`, ...) are a different capability and out of scope
 *  for a shell-command reviewer. */
const GATED_TOOL_NAMES = ['exec', 'startProcess'] as const;

/** Functions this module has already wrapped, keyed by the wrapped
 *  reference itself — not the provider object. A CLI head runtime reuses the
 *  parent's `laptop` ExecutorProvider verbatim (same real device, same
 *  transport) across two ExecutionRouter instances; without this, the
 *  second router's `register()` would wrap an already-gated `execute` again,
 *  reviewing the command twice and consulting the approval channel twice.
 *  Checking the INCOMING `execute` reference against this set makes
 *  `gateProviderExec` idempotent no matter how many routers see the same
 *  provider object. */
const GATED_EXECUTES = new WeakSet<ExecutorTool['execute']>();

/**
 * Gate an ExecutorProvider's shell-reaching tools with the live approval
 * policy. Called by `ExecutionRouter.register()` for every provider it
 * accepts, so `run`'s router dispatch and every codemode `<name>.exec()`
 * call reach the identical decision — see the module doc for why `workspace`
 * is excluded and why re-registration of the same provider is a no-op.
 */
export function gateProviderExec(provider: ExecutorProvider, policy: ShellApprovalPolicy): ExecutorProvider {
  let changed = false;
  const tools = { ...provider.tools };
  for (const name of GATED_TOOL_NAMES) {
    if (provider.kind === 'workspace' && name === 'exec') continue;
    const entry = provider.tools[name];
    if (!entry || GATED_EXECUTES.has(entry.execute)) continue;
    // Keyed on `name`, not `kind`: the name is this executor's identity
    // everywhere else the owner and the model meet it — the `runtime:` value,
    // the codemode namespace, the executor a standing grant is written
    // against — so the gate must not answer to a different word than the one
    // the grant is spelled with.
    const gated = gateExec<ExecutorToolResult>(
      (command, ...rest) => entry.execute(command, ...rest),
      (message) => message,
      provider.name,
      policy,
      // The classification an executor tool already answers with. Every kind of
      // provider — laptop, sandbox, Nimbus, a hosted workspace's startProcess —
      // renders a classified failure through the ONE refusal payload
      // `execution/exec-result.ts` defines, so reading it here covers all of
      // them at once and no executor has to remember to opt in. A result that
      // is not that payload carries no classification, which is the honest
      // answer for a command's own output.
      (result) => {
        const text = v.safeParse(ResultTextSchema, result);
        return text.success ? parseRefusal(text.output)?.reason ?? null : null;
      },
    );
    GATED_EXECUTES.add(gated);
    tools[name] = { ...entry, execute: gated };
    changed = true;
  }
  return changed ? { ...provider, tools } : provider;
}
