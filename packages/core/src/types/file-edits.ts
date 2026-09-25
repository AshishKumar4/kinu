import { KinuError } from '../obs/error';

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
