/**
 * Fork transfer staging — the durable state of the ONE unpublished fork transfer
 * a target workspace is receiving.
 *
 * WHY THIS IS A TABLE AND NOT INSTANCE STATE. A hosted fork is a SEQUENCE of
 * RPCs into a Durable Object, and an activation is not the transfer's lifetime:
 * the runtime can reset the isolate between two frames while the source keeps
 * sending. So everything the write and the wire decide with — the head the
 * publication needs, the mission the inherited SOUL.md carried, how many rows of
 * each section landed, which frame is next, the rolling digest of the frames that
 * arrived, whether the fork already published — lives in the same SQLite the
 * staged rows do and is committed by the same write that stages them. Held in
 * fields instead, every one of them is gone after a reset, the next frame is
 * refused for belonging to no open transfer, and the source's only answer to a
 * refusal is to destroy the half-built target.
 *
 * Its own module rather than a section of `identity/fork.ts` because both halves
 * of the fork use it — the write half there and the wire in
 * `identity/fork-transfer.ts` — and neither owns it. The DDL lives with every
 * other workspace table, in `identity/schema.ts`.
 */

import type { SqlExecutor } from '../types/primitives';
// Type-only, so this module has no runtime edge back to the two that use it.
import type { ForkSnapshotHead, ForkStagedCounts } from './fork';

/** One unpublished transfer's staging state, as the target stores it. */
export interface ForkStaging {
  /** Declared by the `begin` frame. Null until one arrives, which is what makes
   *  a publication without a head impossible rather than merely wrong. */
  head: ForkSnapshotHead | null;
  mission: string;
  /** The pane table did not exist and staging created it. A plain target must
   *  not KEEP one: it exists only to resolve elided text. */
  paneTableCreated: boolean;
  staged: ForkStagedCounts;
  transferId: string | null;
  expectedSeq: number;
  sectionCursor: number;
  /** The rolling digest over every frame that has arrived. */
  stream: string;
  /** The file whose ranges are still arriving, and how many of its bytes the
   *  sink has taken. */
  filePath: string | null;
  fileBytes: number;
  /** What the source said was coming, checked against `staged` at the commit. */
  declared: ForkStagedCounts;
  published: boolean;
}

interface ForkStagingRow {
  head_declared: number;
  head_source_id: string;
  head_source_name: string;
  head_cut_message_id: string;
  head_cut_created_at: number;
  mission: string;
  pane_table_created: number;
  staged_agent_config: number;
  staged_crafted_tools: number;
  staged_memory_chunks: number;
  staged_pane_messages: number;
  staged_messages: number;
  staged_files: number;
  transfer_id: string | null;
  expected_seq: number;
  section_cursor: number;
  stream: string;
  file_path: string | null;
  file_bytes: number;
  want_agent_config: number;
  want_crafted_tools: number;
  want_memory_chunks: number;
  want_pane_messages: number;
  want_messages: number;
  want_files: number;
  published: number;
}

/**
 * One transfer's staged state, read and written a column at a time.
 *
 * THE COLUMNS ARE OWNED. `ForkTargetWriter` writes the head, the mission, the
 * pane-table flag, the `staged_*` tally and the staged file paths;
 * `ForkTransferReceiver` writes the transfer id, the cursor, the rolling digest,
 * the file in flight, the declared `want_*` counts and the publication flag. No
 * update here rewrites the whole row, so the two halves cannot clobber each
 * other across an await.
 */
export class ForkStagingState {
  constructor(private readonly sql: SqlExecutor) {}

  /** The staged transfer, or null on a workspace that is not mid-fork. */
  read(): ForkStaging | null {
    const row = this.sql<ForkStagingRow>`
      SELECT head_declared, head_source_id, head_source_name,
             head_cut_message_id, head_cut_created_at, mission, pane_table_created,
             staged_agent_config, staged_crafted_tools, staged_memory_chunks,
             staged_pane_messages, staged_messages, staged_files,
             transfer_id, expected_seq, section_cursor, stream, file_path, file_bytes,
             want_agent_config, want_crafted_tools, want_memory_chunks,
             want_pane_messages, want_messages, want_files, published
      FROM fork_transfer WHERE id = 1 LIMIT 1
    `[0];
    if (row === undefined) return null;
    return {
      head: row.head_declared === 0 ? null : {
        source: { workspaceId: row.head_source_id, workspaceName: row.head_source_name },
        cut: { messageId: row.head_cut_message_id, createdAtMs: row.head_cut_created_at },
      },
      mission: row.mission,
      paneTableCreated: row.pane_table_created === 1,
      staged: {
        agentConfig: row.staged_agent_config,
        craftedTools: row.staged_crafted_tools,
        memoryChunks: row.staged_memory_chunks,
        assistantMessages: row.staged_pane_messages,
        messages: row.staged_messages,
        files: row.staged_files,
      },
      transferId: row.transfer_id,
      expectedSeq: row.expected_seq,
      sectionCursor: row.section_cursor,
      stream: row.stream,
      filePath: row.file_path,
      fileBytes: row.file_bytes,
      declared: {
        agentConfig: row.want_agent_config,
        craftedTools: row.want_crafted_tools,
        memoryChunks: row.want_memory_chunks,
        assistantMessages: row.want_pane_messages,
        messages: row.want_messages,
        files: row.want_files,
      },
      published: row.published === 1,
    };
  }

  /**
   * This row now belongs to THIS fork, and nothing has been taken.
   *
   * Every other column falls back to its declared default, so one statement is
   * the whole reset — including the publication flag, which is what makes a
   * replacement transfer start from an unpublished target.
   */
  begin(head: ForkSnapshotHead): void {
    void this.sql`INSERT OR REPLACE INTO fork_transfer
      (id, head_declared, head_source_id, head_source_name, head_cut_message_id, head_cut_created_at)
      VALUES (1, 1, ${head.source.workspaceId}, ${head.source.workspaceName},
              ${head.cut.messageId}, ${head.cut.createdAtMs})`;
  }

  /** The wire's half of the same reset: which transfer this is, what it said was
   *  coming, and a cursor at the frame after the `begin`. */
  declare(input: { transferId: string; declared: ForkStagedCounts; expectedSeq: number; stream: string }): void {
    void this.sql`UPDATE fork_transfer SET
      transfer_id = ${input.transferId}, expected_seq = ${input.expectedSeq}, stream = ${input.stream},
      want_agent_config = ${input.declared.agentConfig}, want_crafted_tools = ${input.declared.craftedTools},
      want_memory_chunks = ${input.declared.memoryChunks}, want_pane_messages = ${input.declared.assistantMessages},
      want_messages = ${input.declared.messages}, want_files = ${input.declared.files}
      WHERE id = 1`;
  }

  /** One accepted frame: the next seq, the section it left the cursor at, and
   *  the rolling digest folded through it. */
  advance(input: { expectedSeq: number; sectionCursor: number; stream: string }): void {
    void this.sql`UPDATE fork_transfer SET
      expected_seq = ${input.expectedSeq}, section_cursor = ${input.sectionCursor}, stream = ${input.stream}
      WHERE id = 1`;
  }

  /** The file in flight, or null once its last range has been committed. */
  file(path: string | null, bytes: number): void {
    void this.sql`UPDATE fork_transfer SET file_path = ${path}, file_bytes = ${bytes} WHERE id = 1`;
  }

  /** Rows this write has taken, added to what it had taken before. One statement
   *  over every section, because a column name cannot be bound. */
  count(delta: Partial<ForkStagedCounts>): void {
    void this.sql`UPDATE fork_transfer SET
      staged_agent_config  = staged_agent_config  + ${delta.agentConfig ?? 0},
      staged_crafted_tools = staged_crafted_tools + ${delta.craftedTools ?? 0},
      staged_memory_chunks = staged_memory_chunks + ${delta.memoryChunks ?? 0},
      staged_pane_messages = staged_pane_messages + ${delta.assistantMessages ?? 0},
      staged_messages      = staged_messages      + ${delta.messages ?? 0},
      staged_files         = staged_files         + ${delta.files ?? 0}
      WHERE id = 1`;
  }

  /** The mission SOUL carried, taken while its bytes were in hand. */
  mission(mission: string): void {
    void this.sql`UPDATE fork_transfer SET mission = ${mission} WHERE id = 1`;
  }

  paneTableCreated(): void {
    void this.sql`UPDATE fork_transfer SET pane_table_created = 1 WHERE id = 1`;
  }

  /** The transfer landed. The row OUTLIVES the publication on purpose: it is
   *  what answers a frame re-delivered after the source lost the reply. */
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
