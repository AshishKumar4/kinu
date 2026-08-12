/**
 * Approval gating at the execution seam — the two places a command actually
 * reaches a shell: the `run` tool's workspace shortcut (a raw `Shell`) and
 * every `ExecutorProvider`'s `exec`/`startProcess` tool (workspace, sandbox,
 * nimbus, laptop — reached both by `run`'s router dispatch AND by codemode's
 * `<name>.exec()` namespace calls inside `execute_tools`).
 *
 * Before this, the gate lived inside the `run` TOOL's own executor — one
 * call site out of the many that reach the same shells. `execute_tools`
 * calling `workspace.exec()` / `nimbus.exec()` / `sandbox.exec()` /
 * `laptop.exec()` skipped it entirely: same shell, same permissions, no
 * review. Moving the gate here closes that hole with ONE implementation
 * (safety/approval-gate.ts's `gateExec`) applied at construction, not N
 * copies re-derived at each call site.
 *
 * `workspace` is gated once, at its `Shell` (withApprovalGatedShell) —
 * `createInlineExecutor`'s `exec` tool is a thin wrapper over that same
 * `Shell.exec`, so it inherits the gate for free and `gateProviderExec`
 * below explicitly skips it to avoid reviewing the command twice. Every
 * other executor kind has no shared primitive underneath it (sandbox/nimbus
 * talk to a remote SDK, laptop forwards over a device-tunnel RPC), so those
 * are gated at the ExecutorProvider boundary instead — the ExecutionRouter's
 * `register()` calls `gateProviderExec` for everything it accepts, so a
 * future executor kind is covered automatically, not by remembering to wrap
 * it.
 */

import { gateExec, STRICT_NO_CHANNEL_POLICY, type ShellApprovalPolicy } from '../safety/approval-gate.js';
import type { ExecutorProvider } from './types.js';
import type { Shell, ShellExecOptions } from '../types/primitives.js';

/**
 * Gate a `Shell`'s `exec` — the primitive the `run` tool's workspace branch
 * calls directly and `createInlineExecutor`'s `workspace.exec()` calls
 * underneath it. A denial is shaped as a failed command
 * (`exitCode: 1`, the message on stderr) rather than thrown, so it renders
 * through the same `formatExecResult` every caller already applies and reads
 * as a normal (failing) tool result to the model.
 */
export function withApprovalGatedShell(
  shell: Shell,
  policy: ShellApprovalPolicy = STRICT_NO_CHANNEL_POLICY,
): Shell {
  return {
    exec: gateExec(
      (command, ...rest) => shell.exec(command, rest[0] as string | ShellExecOptions | undefined),
      (message) => ({ stdout: '', stderr: message, exitCode: 1 }),
      policy,
    ),
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
const GATED_EXECUTES = new WeakSet<(...args: unknown[]) => Promise<unknown>>();

/**
 * Gate an ExecutorProvider's shell-reaching tools with the live approval
 * policy. Called by `ExecutionRouter.register()` for every provider it
 * accepts, so `run`'s router dispatch and every codemode `<name>.exec()`
 * call reach the identical decision — see the module doc for why `workspace`
 * is excluded and why re-registration of the same provider is a no-op.
 */
export function gateProviderExec(provider: ExecutorProvider, policy: ShellApprovalPolicy): ExecutorProvider {
  if (provider.kind === 'workspace') return provider;
  let changed = false;
  const tools = { ...provider.tools };
  for (const name of GATED_TOOL_NAMES) {
    const entry = provider.tools[name];
    if (!entry || GATED_EXECUTES.has(entry.execute)) continue;
    const gated = gateExec(
      (command, ...rest) => entry.execute(command, ...rest),
      (message) => message,
      policy,
    );
    GATED_EXECUTES.add(gated);
    tools[name] = { ...entry, execute: gated };
    changed = true;
  }
  return changed ? { ...provider, tools } : provider;
}
