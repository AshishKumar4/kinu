/** Head-identity and file-change contracts, declared at the platform layer so
 *  the run-event union and the heads engine share one source. */

import type { FileStatus } from '../vfs/diff';

/** A birth-time snapshot of one parent conversation message. */
export interface SerializedMessage {
  readonly id: string;
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly createdAt: number;
  readonly toolName?: string;
}

/** Opaque head identifier — kebab-case string, globally unique within a turn. */
export type HeadId = string;

/** One file a head changed, as a review would state it. */
export interface HeadFileChange {
  /** The parent workspace's own path — what the parent addresses the file by. */
  readonly path: string;
  readonly status: FileStatus;
  readonly added: number;
  readonly removed: number;
  /** Set when the content is not text, so lines are not a unit for it and the
   *  counts are omitted rather than fabricated from decoded bytes. */
  readonly binary?: boolean;
}

/** One head's change set as the merge payload carries it. Heads that changed
 *  nothing are absent rather than present-and-empty: a fork that touched no
 *  files has nothing to report, and an empty row would still print a heading. */
export interface HeadFileChangeSet {
  readonly id: HeadId;
  readonly changes: readonly HeadFileChange[];
}
