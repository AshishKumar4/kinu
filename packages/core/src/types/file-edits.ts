import { KinuError } from '../obs/error';

/** Lines one `file` read shows by default, as Claude Code's Read and pi's read do. */
export const FILE_READ_LINES = 2_000;

/** Characters one read shows at most, its footer included: about 12,500 tokens, pi's and oh-my-pi's 50 KB. */
export const FILE_READ_MAX_CHARS = 50_000;

/** Characters of one line a read shows; the rest is counted, so a minified line cannot fill the window. */
export const FILE_READ_LINE_CHARS = 2_000;

/** One replacement in the original text's UTF-16 offsets, end exclusive; `inserted` is its new text's length. */
export interface EditedSpan {
  readonly start: number;
  readonly end: number;
  readonly inserted: number;
}

/** Durable counter keys in the `file_edit` run event. */
export type FileEditFailure =
  | 'empty_anchor'
  | 'not_found'
  /** old_text appears more than once. */
  | 'ambiguous'
  | 'overlap'
  /** Every replacement produced the text it replaced. */
  | 'no_change';

/**
 * The file plane's own refusal verdicts; `missing`, `denied` and `io` are shared `ErrorCode`s
 * instead.
 */
export const FILE_REFUSAL_REASONS = [
  'empty_anchor', 'not_found', 'ambiguous', 'overlap', 'no_change', 'unread', 'stale',
] as const satisfies readonly (FileEditFailure | 'unread' | 'stale')[];

export class FileRefusalError extends KinuError {
  constructor(readonly verdict: (typeof FILE_REFUSAL_REASONS)[number], message: string) {
    super('bad_input', message);
  }
}

export type FileEditOutcomeReason =
  | FileEditFailure
  /** The file was never read this turn. */
  | 'unread'
  /** The file changed after the read this turn. */
  | 'stale'
  | 'missing'
  | 'denied'
  | 'io';

/** `attempts`/`applied` count calls; `recoveredPaths`/`abandonedPaths` count paths. */
export interface FileEditSnapshot {
  attempts: number;
  applied: number;
  failures: Partial<Record<FileEditOutcomeReason, number>>;
  /** Paths that failed an edit and then landed one in the same turn. */
  recoveredPaths: number;
  abandonedPaths: number;
}
