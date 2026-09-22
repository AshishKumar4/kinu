/** Head-identity and file-change contracts shared by the run-event union and the heads engine. */

import type { FileStatus } from '../vfs/diff';

/** A birth-time snapshot of one parent conversation message. */
export interface SerializedMessage {
  readonly id: string;
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly createdAt: number;
  readonly toolName?: string;
}

/** Kebab-case, unique within a turn. */
export type HeadId = string;

export interface HeadFileChange {
  /** The parent workspace's own path — what the parent addresses the file by. */
  readonly path: string;
  readonly status: FileStatus;
  readonly added: number;
  readonly removed: number;
  /** Content is not text, so line counts are omitted rather than fabricated. */
  readonly binary?: boolean;
  /** A directory: nothing under it was read, so there are no lines to count. */
  readonly directory?: boolean;
  /** The prior content was unreadable, so counts are omitted rather than guessed. */
  readonly unreadable?: boolean;
}

/** Heads that changed nothing are absent, not present-and-empty. */
export interface HeadFileChangeSet {
  readonly id: HeadId;
  readonly changes: readonly HeadFileChange[];
}
