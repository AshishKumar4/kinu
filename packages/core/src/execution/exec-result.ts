/** Command result projection and display formatting. Invocation status never comes from text. */

import * as v from 'valibot';
import { ERROR_CODES, refusalOf, KinuError, type Refusal } from '../obs/index';
import type { JsonValue } from '../utils/json';
import { FILE_REFUSAL_REASONS } from '../tools/file-edit';

const RefusalSchema = v.object({ reason: v.picklist(ERROR_CODES), error: v.string() });
/** A verdict the file plane answered with (`tools/file-tool.ts` `failure()`): the
 *  caller did not meet the operation's precondition. Not an error class. */
const FileVerdictSchema = v.object({ reason: v.picklist(FILE_REFUSAL_REASONS), error: v.string() });

/** The shape every transport settles a command into. */
export interface ExecOutcome {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly refusal?: Refusal;
}

export const STDOUT_LABEL = '--- stdout ---';
export const STDERR_LABEL = '--- stderr ---';

/** What a command that wrote nothing anywhere reads as. */
export const NO_OUTPUT = '(no output)';

/** Encode a declared refusal-string channel; never use it to classify arbitrary output. */
export function refusalText(error: KinuError | Refusal): string {
  return JSON.stringify(error instanceof KinuError ? refusalOf(error) : { reason: error.reason, error: error.error });
}


/**
 * The refusal a codemode member ANSWERED with, or null when its answer is a value.
 *
 * A provider member returns rather than throws, so a script can branch;
 * a caller that hands the answer on as a RESULT — a slate binding —
 * must recover the class. Two OBJECT shapes and only two, each the exact payload
 * its producer writes: an `ErrorCode` refusal (`refusalOf`) and a file-plane
 * verdict, which is the caller's own unmet precondition and so `bad_input`. A
 * string is never read here: `readFile` answers file CONTENT as a string, and
 * content that happens to spell a refusal is still content. A value that merely
 * carries `reason`/`error` fields of some other vocabulary is data, and stays data.
 */
export function answeredRefusal(payload: JsonValue): Refusal | null {
  const classified = v.safeParse(RefusalSchema, payload);
  if (classified.success) return { reason: classified.output.reason, error: classified.output.error };
  const verdict = v.safeParse(FileVerdictSchema, payload);
  if (verdict.success) return { reason: 'bad_input', error: `${verdict.output.reason}: ${verdict.output.error}` };
  return null;
}

/** Command data stays text; execution failures retain their producer's class. */
export const CommandResultSchema = v.union([v.string(), v.object({
  ...RefusalSchema.entries,
  execution: v.optional(v.object({ exitCode: v.number() })),
})]);
export type CommandResult = v.InferOutput<typeof CommandResultSchema>;
export const COMMAND_RESULT_TYPE = 'string | { reason: '
  + ERROR_CODES.map((code) => JSON.stringify(code)).join(' | ') + '; error: string; execution?: { exitCode: number } }';

export function commandResult(result: ExecOutcome): CommandResult {
  if (result.refusal !== undefined) return result.refusal;
  const output = formatExecResult(result);
  return (result.exitCode ?? 0) === 0 ? output : { reason: 'io', error: output, execution: { exitCode: result.exitCode ?? 0 } };
}

export function formatExecResult(result: ExecOutcome): string {
  if (result.refusal !== undefined) return refusalText(result.refusal);
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

