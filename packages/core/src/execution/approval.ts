/** Approval gating where a command reaches a shell: the workspace `Shell`, and every other provider's shell-reaching
 *  tools on `ExecutionRouter.register()`. */

import {
  commandFilesOwner, gateExec, reviewProgram, reviewShellCommand, sessionAt, STRICT_NO_CHANNEL_POLICY,
  type ApprovalResult, type GatedExecutor, type ShellApprovalPolicy, type ShellCwd,
} from '../safety/approval-gate';
import * as v from 'valibot';
import { answeredRefusal, CommandResultSchema } from './exec-result';
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

/** What a workspace shell's commands reach. */
export type ShellReach = Pick<GatedExecutor, 'filesOwner' | 'shellSession'>;

/** A shell's cwd, read ungated; a durable one outlives its process. Null: unreadable. */
export async function shellCwd(shell: Shell): Promise<string | null> {
  const result = await shell.exec('pwd');
  const cwd = result.stdout.trim();

  return result.refusal === undefined && result.exitCode === 0 && cwd.startsWith('/') ? cwd : null;
}

/** A refusal is shaped as a command that did not run: exit 1, message on stderr, classification in `refusal`,
 *  which alone `refusalCode` reads; a spent grant is refunded only if the command never started. */
export function withApprovalGatedShell(
  shell: Shell,
  reach: ShellReach,
  policy: ShellApprovalPolicy = STRICT_NO_CHANNEL_POLICY,
): Shell {
  const session = reach.shellSession;

  // 'workspace' only: gateProviderExec skips the workspace `exec` because it is gated here.
  const execute = gateExec<ShellExecResult>(
    (command, ...rest) => shell.exec(command, parseShellExecOptions({ value: rest[0] })),
    (error) => ({ stdout: '', stderr: error.message, exitCode: 1, refusal: refusalOf(error) }),
    { name: 'workspace', ...reach },
    { policy, refusalCode: (result) => result.refusal?.reason ?? null },
  );

  const run = async (command: string, stdinOrOptions?: string | ShellExecOptions): Promise<ShellExecResult> => {
    const result = await execute(command, stdinOrOptions);

    if (result.refusal === undefined) session?.ran(command, result.exitCode);

    return result;
  };

  return {
    exec: (command, stdinOrOptions) => {
      requireBuild('Workspace shell execution');

      return session === undefined ? run(command, stdinOrOptions) : session.serial(() => run(command, stdinOrOptions));
    },
  };
}

/** Tools taking a shell command or a program first; VFS-shaped tools are out of scope. */
const SHELL_COMMAND_MEMBERS = ['exec', 'startProcess', 'runCode'] as const;

const CallOptionsSchema = v.object({ cwd: v.optional(v.string()), language: v.optional(v.string()) });

function parseCallOptions(input: { value: unknown }): v.InferOutput<typeof CallOptionsSchema> {
  const parsed = v.safeParse(CallOptionsSchema, input.value);

  return parsed.success ? parsed.output : {};
}

/** `runCode` is a shell command only in the shell language. */
async function reviewCall(provider: ExecutorProvider, member: string, command: string, rest: readonly unknown[]): Promise<ApprovalResult> {
  const options = parseCallOptions({ value: rest[0] });
  const session = provider.shellSession;
  let at: ShellCwd | undefined;

  if (session !== undefined) at = options.cwd === undefined ? await session.at() : sessionAt(session.home, options.cwd);

  return member === 'runCode' && options.language !== 'shell'
    ? reviewProgram(command, commandFilesOwner(provider, command, at))
    : reviewShellCommand(provider, command, at);
}

function ranExitCode(result: ExecutorToolResult): number | null {
  const parsed = v.safeParse(CommandResultSchema, result);

  if (!parsed.success) return null;

  return v.is(v.string(), parsed.output) ? 0 : parsed.output.execution?.exitCode ?? null;
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

    const session = provider.shellSession;

    // Nimbus keeps a shell program's `cd`s (withShellState).
    const run = async (...args: unknown[]): Promise<ExecutorToolResult> => {
      const result = await gated(...args);
      const options = parseCallOptions({ value: args[1] });
      const exitCode = name === 'runCode' && options.language === 'shell' && options.cwd === undefined ? ranExitCode(result) : null;

      if (exitCode !== null) session?.ran(String(args[0]), exitCode);

      return result;
    };

    const execute: ExecutorTool['execute'] = (...args) => {
      requireBuild(provider.name + '.' + name);

      return session === undefined ? run(...args) : session.serial(() => run(...args));
    };

    GATED_EXECUTES.add(execute);
    tools[name] = { ...entry, execute };
    changed = true;
  }

  return changed ? { ...provider, tools } : provider;
}
