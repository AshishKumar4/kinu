import { KinuError } from '../obs/error';
import * as v from 'valibot';

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

/** The persisted counters and the ledger's vocabulary are the same contract. */
export const FileEditFailuresSchema = v.object({
  empty_anchor: v.optional(v.number()), not_found: v.optional(v.number()),
  ambiguous: v.optional(v.number()), overlap: v.optional(v.number()),
  no_change: v.optional(v.number()), unread: v.optional(v.number()),
  stale: v.optional(v.number()), missing: v.optional(v.number()),
  denied: v.optional(v.number()), io: v.optional(v.number()),
});

export type FileEditOutcomeReason = keyof v.InferOutput<typeof FileEditFailuresSchema>;

/** `attempts`/`applied` count calls; `recoveredPaths`/`abandonedPaths` count paths. */
export interface FileEditSnapshot {
  attempts: number;
  applied: number;
  failures: v.InferOutput<typeof FileEditFailuresSchema>;
  /** Paths that failed an edit and then landed one in the same turn. */
  recoveredPaths: number;
  abandonedPaths: number;
}
