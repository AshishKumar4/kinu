/** Command result projection and display formatting. Invocation status never comes from text. */

import * as v from 'valibot';
import { ERROR_CODES, refusalOf, KinuError, type Refusal } from '../obs/index';
import type { JsonValue } from '../utils/json';
import { FILE_REFUSAL_REASONS } from '../types/file-edits';
import type { PreviewRouteCheck } from './types';

const RefusalSchema = v.object({
  reason: v.picklist(ERROR_CODES),
  error: v.string(),
  execution: v.optional(v.object({ exitCode: v.number() })),
});

/** A file-plane verdict (`tools/file-tool.ts` `failure()`): unmet precondition, not an error class. */
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
  if (error instanceof KinuError) return JSON.stringify(refusalOf(error));

  const refusal = { reason: error.reason, error: error.error };

  return JSON.stringify(error.execution === undefined ? refusal : { ...refusal, execution: error.execution });
}


/**
 * The refusal a codemode member answered with, or null for a value. Only two object shapes count: an `ErrorCode`
 * refusal (`refusalOf`) and a file-plane verdict (`bad_input`). Strings are never read: file content may spell a refusal.
 */
export function answeredRefusal(payload: JsonValue): Refusal | null {
  const classified = v.safeParse(RefusalSchema, payload);

  if (classified.success) return classified.output;
  const verdict = v.safeParse(FileVerdictSchema, payload);

  if (verdict.success) return { reason: 'bad_input', error: `${verdict.output.reason}: ${verdict.output.error}` };

  return null;
}

/** Command data stays text; execution failures retain their producer's class. */
export const CommandResultSchema = v.union([v.string(), RefusalSchema]);

export type CommandResult = v.InferOutput<typeof CommandResultSchema>;

export const COMMAND_RESULT_TYPE = 'string | { reason: '
  + ERROR_CODES.map((code) => JSON.stringify(code)).join(' | ') + '; error: string; execution?: { exitCode: number } }';

export function commandResult(result: ExecOutcome): CommandResult {
  if (result.refusal !== undefined) return result.refusal;
  const output = formatExecResult(result);

  return (result.exitCode ?? 0) === 0 ? output : { reason: 'io', error: output, execution: { exitCode: result.exitCode ?? 0 } };
}

export function exposedPortText(url: string, port: number, route: PreviewRouteCheck): string {
  return route.reached
    ? `${url}\nverified: a request to this URL reaches the server on port ${String(port)}`
    : `${url}\nnot reached: the preview route's ${route.gate} gate refused: ${route.detail}`;
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

