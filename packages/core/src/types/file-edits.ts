/** Why an edit did not land. Durable counter keys in the `file_edit` run event,
 *  so a benchmark can report exact-match failures by kind. */
export type FileEditFailure =
  /** old_text was empty — an empty anchor matches everywhere. */
  | 'empty_anchor'
  /** old_text is not in the file. */
  | 'not_found'
  /** old_text appears more than once, so the target is a guess. */
  | 'ambiguous'
  /** Two edits in the call cover overlapping text. */
  | 'overlap'
  /** Every replacement produced the text it replaced. */
  | 'no_change';

/**
 * The file plane's own refusal reasons — verdicts the tool reached, not error
 * classes: the anchor failures above plus the two the turn ledger raises, a write
 * over contents the caller has not read (`unread`) or read before they changed
 * (`stale`). `missing`, `denied` and `io` are NOT here; they are `ErrorCode`s
 * shared with every other tool. Declared on this leaf so the reader in
 * `execution/exec-result.ts` and the census in `read-models/tool-failures.ts`
 * take one list without either importing the ledger.
 */
export const FILE_REFUSAL_REASONS = [
  'empty_anchor', 'not_found', 'ambiguous', 'overlap', 'no_change', 'unread', 'stale',
] as const satisfies readonly (FileEditFailure | 'unread' | 'stale')[];

/** Why an edit attempt did not land. The text-surgery failures plus the two the
 *  ledger itself raises and the I/O ones the VFS raises. */
export type FileEditOutcomeReason =
  | FileEditFailure
  /** The file was never read this turn. */
  | 'unread'
  /** The file changed after the read this turn. */
  | 'stale'
  /** The path does not exist, or is not a file. */
  | 'missing'
  /** The caller's own credential may not read or write the path. */
  | 'denied'
  /** The filesystem refused the read or the write for another reason. */
  | 'io';

/** What one turn's edits did. Absent counters never happened.
 *  `attempts`/`applied` count CALLS; `recoveredPaths`/`abandonedPaths` count
 *  PATHS, because recovery is a property of a file, not of a call. */
export interface FileEditSnapshot {
  /** Edit calls attempted. */
  attempts: number;
  /** Edit calls that changed a file. */
  applied: number;
  /** Failed attempts by reason. */
  failures: Partial<Record<FileEditOutcomeReason, number>>;
  /** Paths that failed an edit and then landed one in the same turn. */
  recoveredPaths: number;
  /** Paths that failed an edit and never landed one. */
  abandonedPaths: number;
}
