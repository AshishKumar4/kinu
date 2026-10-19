/** Command result projection and display formatting. Invocation status never comes from text. */

import * as v from 'valibot';
import { KinuError, refusalOf, RefusalSchema, type Refusal } from '../obs/index';
import type { JsonValue } from '../utils/json';
import { FILE_REFUSAL_REASONS } from '../types/file-edits';
import type { Uncheckpointed } from '../types/primitives';

/** A file-plane verdict (`tools/file-tool.ts` `failure()`): unmet precondition, not an error class. */
const FileVerdictSchema = v.object({ ...RefusalSchema.entries, reason: v.picklist(FILE_REFUSAL_REASONS) });

/** The shape every transport settles a command into. */
export interface ExecOutcome {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly refusal?: Refusal;
  readonly uncheckpointed?: Uncheckpointed;
  /** Where the command started. */
  readonly cwd?: string;
}

const STDOUT_LABEL = '--- stdout ---';

const STDERR_LABEL = '--- stderr ---';

/** What a command that wrote nothing anywhere reads as. */
const NO_OUTPUT = '(no output)';

/**
 * The refusal a codemode member answered with, or null for a value. Only two object shapes count: an `ErrorCode`
 * refusal (`refusalOf`) and a file-plane verdict (`bad_input`). Strings are never read: file content may spell a refusal.
 */
export function answeredRefusal(payload: JsonValue): Refusal | null {
  const classified = v.safeParse(RefusalSchema, payload);

  if (classified.success) return classified.output;
  const verdict = v.safeParse(FileVerdictSchema, payload);

  if (verdict.success) return refusalOf(new KinuError('bad_input', `${verdict.output.reason}: ${verdict.output.error}`));

  return null;
}

/** Command data stays text; execution failures retain their producer's class. */
export const CommandResultSchema = v.union([v.string(), RefusalSchema]);

export type CommandResult = v.InferOutput<typeof CommandResultSchema>;

function commandResult(result: ExecOutcome): CommandResult {
  if (result.refusal !== undefined) return result.refusal;
  const output = formatExecResult(result);

  return (result.exitCode ?? 0) === 0 ? output : refusalOf(new KinuError('io', output, { execution: { exitCode: result.exitCode ?? 0 } }));
}

/** With `reportCwd`, as the shell tool answers the model: a command that ran says first where it started. Without, as
 *  programs read it (`commandResult`). */
export function commandResultAt(result: ExecOutcome, reportCwd: boolean): CommandResult {
  const answer = commandResult(result);

  if (!reportCwd || result.cwd === undefined || result.refusal !== undefined) return answer;

  return v.is(v.string(), answer) ? `cwd: ${result.cwd}\n${answer}` : { ...answer, error: `cwd: ${result.cwd}\n${answer.error}` };
}

/** An exec's options asking for `{ stdout, stderr, exitCode }` instead of the text. */
export const ExecPartsSchema = v.object({ parts: v.literal(true) });

/**
 * A command's answer as its caller asked: with `parts`, `{ stdout, stderr, exitCode }` as the command wrote them, which a
 * program reads and never parses back from the text; else the text (`commandResultAt`).
 */
export function commandAnswer(outcome: ExecOutcome, parts: boolean, reportCwd: boolean): CommandResult | { stdout: string; stderr: string; exitCode: number } {
  return parts && outcome.refusal === undefined
    ? { stdout: outcome.stdout ?? '', stderr: outcome.stderr ?? '', exitCode: outcome.exitCode ?? 0 }
    : commandResultAt(outcome, reportCwd);
}

export function formatExecResult(result: ExecOutcome): string {
  const output = formatOutput(result);

  return result.uncheckpointed === undefined || result.refusal !== undefined
    ? output
    : `${output}\n${uncheckpointedSentence(result.uncheckpointed, 'this command')}`;
}

export function uncheckpointedSentence(uncheckpointed: Uncheckpointed, change: string): string {
  return `No checkpoint covers ${uncheckpointed.dir}: ${uncheckpointed.why}, so undo cannot restore what ${change} changed there.`;
}

function formatOutput(result: ExecOutcome): string {
  if (result.refusal !== undefined) return JSON.stringify(result.refusal);
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const exitCode = result.exitCode ?? 0;

  if (exitCode === 0) {
    if (!stderr.trim()) return stdout || NO_OUTPUT;

    if (!stdout.trim()) return stderr;

    return `${stdout}\n${STDERR_LABEL}\n${stderr}`;
  }

  const sections = [`Error (exit ${exitCode})`];

  if (stdout.trim()) sections.push(`${STDOUT_LABEL}\n${stdout}`);

  if (stderr.trim()) sections.push(`${STDERR_LABEL}\n${stderr}`);

  if (sections.length === 1) sections.push(NO_OUTPUT);

  return sections.join('\n');
}
