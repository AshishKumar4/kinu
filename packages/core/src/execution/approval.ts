/**
 * Approval gating at the two places a command reaches a shell: the workspace `Shell` (withApprovalGatedShell)
 * and every other ExecutorProvider's `exec`/`startProcess`, gated on `ExecutionRouter.register()`.
 */

import { gateExec, STRICT_NO_CHANNEL_POLICY, type ShellApprovalPolicy } from '../safety/approval-gate';
import * as v from 'valibot';
import { answeredRefusal } from './exec-result';
import type { ExecutorProvider, ExecutorTool, ExecutorToolResult } from './types';
import type { Shell, ShellExecOptions, ShellExecResult } from '../types/primitives';
import { requireBuild } from './work-mode';
import { refusalOf } from '../obs/error';

const ShellExecOptionsSchema: v.GenericSchema<ShellExecOptions | undefined> = v.optional(v.object({
  stdin: v.optional(v.string()),
  signal: v.optional(v.instance(AbortSignal)),
}));

function parseShellExecOptions(input: { value: unknown }): string | ShellExecOptions | undefined {
  const text = v.safeParse(v.string(), input.value);

  if (text.success) return text.output;
  const options = v.safeParse(ShellExecOptionsSchema, input.value);

  return options.success ? options.output : undefined;
}

/**
 * A refusal is shaped as a command that did not run: exit 1, message on stderr, classification in `refusal`.
 * `refusalCode` reads only that classification; a spent grant is refunded only if the command never started.
 */
export function withApprovalGatedShell(
  shell: Shell,
  policy: ShellApprovalPolicy = STRICT_NO_CHANNEL_POLICY,
): Shell {
  // 'workspace' only: gateProviderExec skips the workspace `exec` because it is gated here.
  const execute = gateExec<ShellExecResult>(
    (command, ...rest) => shell.exec(command, parseShellExecOptions({ value: rest[0] })),
    (error) => ({ stdout: '', stderr: error.message, exitCode: 1, refusal: refusalOf(error) }),
    'workspace',
    { policy, refusalCode: (result) => result.refusal?.reason ?? null },
  );

  return {
    exec: (command, stdinOrOptions) => {
      requireBuild('Workspace shell execution');

      return execute(command, stdinOrOptions);
    },
  };
}

/** Tools taking a raw shell command as first argument; VFS-shaped tools are out of scope. */
const SHELL_COMMAND_MEMBERS = ['exec', 'startProcess'] as const;

/** Already-wrapped executes, so a provider shared across routers is gated once (idempotent). */
const GATED_EXECUTES = new WeakSet<ExecutorTool['execute']>();

/** Gate an ExecutorProvider's shell-reaching tools; no-op on re-registration. */
export function gateProviderExec(provider: ExecutorProvider, policy: ShellApprovalPolicy): ExecutorProvider {
  let changed = false;
  const tools = { ...provider.tools };

  for (const name of SHELL_COMMAND_MEMBERS) {
    if (provider.kind === 'workspace' && name === 'exec') continue;
    const entry = provider.tools[name];

    if (!entry || GATED_EXECUTES.has(entry.execute)) continue;

    // Keyed on `name`, not `kind`: standing grants are written against the executor name.
    const gated = gateExec<ExecutorToolResult>(
      (command, ...rest) => entry.execute(command, ...rest),
      (error) => refusalOf(error),
      provider.name,
      { policy, refusalCode: (result) => result === undefined ? null : answeredRefusal(result)?.reason ?? null },
    );

    const execute: ExecutorTool['execute'] = (...args) => {
      requireBuild(provider.name + '.' + name);

      return gated(...args);
    };

    GATED_EXECUTES.add(execute);
    tools[name] = { ...entry, execute };
    changed = true;
  }

  return changed ? { ...provider, tools } : provider;
}
