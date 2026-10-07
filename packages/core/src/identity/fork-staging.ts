/**
 * Durable state of the one unpublished fork transfer a target is receiving. Kept in SQLite, not instance
 * fields: the DO isolate can reset between frames, and lost state makes the source destroy the target.
 */

import type { SqlExecutor } from '../types/primitives';
// Type-only, so this module has no runtime edge back to the two that use it.
import type { ForkSnapshotHead } from './fork-rows';
import type { ForkStagedCounts } from './fork-writer';
import { FORK_ROW_SECTIONS, perSection, type ForkRowSection } from './fork-sections';

export interface ForkStaging {
  /** Declared by the `begin` frame; null until then, so a publication without a head is impossible. */
  head: ForkSnapshotHead | null;
  staged: ForkStagedCounts;
  transferId: string | null;
  expectedSeq: number;
  sectionCursor: number;
  stream: string;
  /** The import whose pages are still arriving, by destination. */
  importing: string | null;
  /** What the source declared, checked against `staged` at the commit. */
  declared: ForkStagedCounts;
  published: boolean;
}

interface ForkStagingRow {
  head_declared: number;
  head_source_id: string;
  head_source_name: string;
  head_cut_message_id: string;
  head_cut_created_at: number;
  staged_files: number;
  transfer_id: string | null;
  expected_seq: number;
  section_cursor: number;
  stream: string;
  import_path: string | null;
  want_files: number;
  published: number;
}

/**
 * One transfer's staged state, updated a column at a time. `ForkTargetWriter` and `ForkTransferReceiver`
 * own disjoint columns and no update rewrites the whole row, so they cannot clobber each other across an await.
 */
export class ForkStagingState {
  constructor(private readonly sql: SqlExecutor) {}

  /** The staged transfer, or null on a workspace that is not mid-fork. */
  read(): ForkStaging | null {
    const row = this.sql<ForkStagingRow>`
      SELECT head_declared, head_source_id, head_source_name, head_cut_message_id, head_cut_created_at,
             (SELECT COUNT(*) FROM fork_staged_files) AS staged_files,
             transfer_id, expected_seq, section_cursor, stream, import_path, want_files, published
      FROM fork_transfer WHERE id = 1 LIMIT 1
    `[0];

    if (row === undefined) return null;

    const counts = new Map(this.sql<{ section: string; declared: number; staged: number }>`
      SELECT section, declared, staged FROM fork_transfer_counts
    `.map((count) => [count.section, count] as const));

    return {
      head: row.head_declared === 0 ? null : {
        source: { workspaceId: row.head_source_id, workspaceName: row.head_source_name },
        cut: { messageId: row.head_cut_message_id, createdAtMs: row.head_cut_created_at },
      },
      staged: { ...perSection((section) => counts.get(section)?.staged ?? 0), files: row.staged_files },
      transferId: row.transfer_id,
      expectedSeq: row.expected_seq,
      sectionCursor: row.section_cursor,
      stream: row.stream,
      importing: row.import_path,
      declared: { ...perSection((section) => counts.get(section)?.declared ?? 0), files: row.want_files },
      published: row.published === 1,
    };
  }

  /** Claim the row for this fork; every other column (including the publication flag) resets to its default. */
  begin(head: ForkSnapshotHead): void {
    void this.sql`DELETE FROM fork_transfer_counts`;
    void this.sql`INSERT OR REPLACE INTO fork_transfer
      (id, head_declared, head_source_id, head_source_name, head_cut_message_id, head_cut_created_at)
      VALUES (1, 1, ${head.source.workspaceId}, ${head.source.workspaceName},
              ${head.cut.messageId}, ${head.cut.createdAtMs})`;
  }

  /** The wire's half of the reset: transfer id, declared counts, cursor after `begin`. */
  declare(input: { transferId: string; declared: ForkStagedCounts; expectedSeq: number; stream: string }): void {
    void this.sql`UPDATE fork_transfer SET
      transfer_id = ${input.transferId}, expected_seq = ${input.expectedSeq}, stream = ${input.stream},
      want_files = ${input.declared.files}
      WHERE id = 1`;

    for (const section of FORK_ROW_SECTIONS) {
      void this.sql`
        INSERT INTO fork_transfer_counts (section, declared) VALUES (${section}, ${input.declared[section]})
        ON CONFLICT (section) DO UPDATE SET declared = excluded.declared
      `;
    }
  }

  advance(input: { expectedSeq: number; sectionCursor: number; stream: string }): void {
    void this.sql`UPDATE fork_transfer SET
      expected_seq = ${input.expectedSeq}, section_cursor = ${input.sectionCursor}, stream = ${input.stream}
      WHERE id = 1`;
  }

  /** The import in flight, or null once its last page has been imported. */
  importing(dst: string | null): void {
    void this.sql`UPDATE fork_transfer SET import_path = ${dst} WHERE id = 1`;
  }

  /** Add rows a section took. */
  count(section: ForkRowSection, rows: number): void {
    void this.sql`
      INSERT INTO fork_transfer_counts (section, staged) VALUES (${section}, ${rows})
      ON CONFLICT (section) DO UPDATE SET staged = staged + excluded.staged
    `;
  }

  /** The transfer landed. The row outlives publication to answer a frame re-delivered after a lost reply. */
  markPublished(): void {
    void this.sql`UPDATE fork_transfer SET published = 1 WHERE id = 1`;
  }

  addFile(path: string): void {
    void this.sql`INSERT OR IGNORE INTO fork_staged_files (path) VALUES (${path})`;
  }

  files(): string[] {
    return this.sql<{ path: string }>`SELECT path FROM fork_staged_files ORDER BY path`
      .map((row) => row.path);
  }

  dropFiles(): void {
    void this.sql`DELETE FROM fork_staged_files`;
  }
}
