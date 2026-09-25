/** Approval gating where a command reaches a shell: the workspace `Shell`, and every other provider's shell-reaching
 *  tools on `ExecutionRouter.register()`. */

import {
  commandFilesOwner, gateExec, nextShellCwd, reviewCommand, reviewProgram, reviewShellCommand, sessionAt, STRICT_NO_CHANNEL_POLICY,
  type ApprovalResult, type FilesOwner, type ShellApprovalPolicy, type ShellCwd,
} from '../safety/approval-gate';
import * as v from 'valibot';
import { answeredRefusal } from './exec-result';
import type { ExecutionRouter, ExecutorProvider, ExecutorTool, ExecutorToolResult } from './types';
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

/** What a workspace shell's commands reach. */
export interface ShellReach {
  readonly filesOwner: FilesOwner;
  readonly userRoots: () => readonly string[];
  /** Where a session starts and `cd` returns. */
  readonly home: string;
  /** Whether `cd` carries to the next command (a hosted node's box pins each call's cwd). */
  readonly keepsCwd: boolean;
}

/** A refusal is shaped as a command that did not run: exit 1, message on stderr, classification in `refusal`,
 *  which alone `refusalCode` reads; a spent grant is refunded only if the command never started. */
export function withApprovalGatedShell(
  shell: Shell,
  reach: ShellReach,
  policy: ShellApprovalPolicy = STRICT_NO_CHANNEL_POLICY,
): Shell {
  let session: ShellCwd = { cwd: reach.home, home: reach.home, mayBeUsers: false };

  // 'workspace' only: gateProviderExec skips the workspace `exec` because it is gated here.
  const execute = gateExec<ShellExecResult>(
    (command, ...rest) => shell.exec(command, parseShellExecOptions({ value: rest[0] })),
    (error) => ({ stdout: '', stderr: error.message, exitCode: 1, refusal: refusalOf(error) }),
    { name: 'workspace', filesOwner: reach.filesOwner, userRoots: reach.userRoots, session: () => session },
    { policy, refusalCode: (result) => result.refusal?.reason ?? null },
  );

  return {
    exec: (command, stdinOrOptions) => {
      requireBuild('Workspace shell execution');

      return execute(command, stdinOrOptions).then((result) => {
        if (reach.keepsCwd && result.refusal === undefined) {
          session = nextShellCwd(session, command, result.exitCode, reach.userRoots());
        }

        return result;
      });
    },
  };
}

/** An unregistered executor's command is reviewed as the user's. */
export function declaredReview(router: ExecutionRouter | undefined, executor: string, command: string): ApprovalResult {
  const provider = router?.getProvider(executor);

  return provider === undefined ? reviewCommand(command, 'user') : reviewShellCommand(provider, command);
}

/** Tools taking a shell command or a program first; VFS-shaped tools are out of scope. */
const SHELL_COMMAND_MEMBERS = ['exec', 'startProcess', 'runCode'] as const;

const CallOptionsSchema = v.object({ cwd: v.optional(v.string()), language: v.optional(v.string()) });

/** `runCode` is a shell command only in the shell language. */
async function reviewCall(provider: ExecutorProvider, member: string, command: string, rest: readonly unknown[]): Promise<ApprovalResult> {
  const parsed = v.safeParse(CallOptionsSchema, rest[0]);
  const options = parsed.success ? parsed.output : {};
  const mounted = provider.filesOwner === 'agent' && provider.userRoots !== undefined;
  const session = mounted ? sessionAt(await provider.homeDir(), options.cwd) : undefined;

  return member === 'runCode' && options.language !== 'shell'
    ? reviewProgram(command, commandFilesOwner(provider, command, session))
    : reviewShellCommand(provider, command, session);
}

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

    // Grants name the executor; the call picks the rules.
    const gated = gateExec<ExecutorToolResult>(
      (command, ...rest) => entry.execute(command, ...rest),
      (error) => refusalOf(error),
      provider,
      {
        policy,
        refusalCode: (result) => result === undefined ? null : answeredRefusal(result)?.reason ?? null,
        review: (command, rest) => reviewCall(provider, name, command, rest),
      },
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
