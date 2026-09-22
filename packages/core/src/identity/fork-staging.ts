/**
 * Durable state of the one unpublished fork transfer a target is receiving. Kept in SQLite, not instance
 * fields: the DO isolate can reset between frames, and lost state makes the source destroy the target.
 */

import type { SqlExecutor } from '../types/primitives';
// Type-only, so this module has no runtime edge back to the two that use it.
import type { ForkSnapshotHead } from './fork-rows';
import type { ForkStagedCounts } from './fork-writer';

export interface ForkStaging {
  /** Declared by the `begin` frame; null until then, so a publication without a head is impossible. */
  head: ForkSnapshotHead | null;
  mission: string;
  staged: ForkStagedCounts;
  transferId: string | null;
  expectedSeq: number;
  sectionCursor: number;
  stream: string;
  /** The file whose ranges are still arriving, and how many bytes the sink has taken. */
  filePath: string | null;
  fileBytes: number;
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
  mission: string;
  staged_agent_config: number;
  staged_crafted_tools: number;
  staged_memory_chunks: number;
  staged_session_messages: number;
  staged_conversation_entries: number;
  staged_conversation_entry_parts: number;
  staged_context_members: number;
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
  want_session_messages: number;
  want_conversation_entries: number;
  want_conversation_entry_parts: number;
  want_context_members: number;
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
      SELECT head_declared, head_source_id, head_source_name,
             head_cut_message_id, head_cut_created_at, mission,
             staged_agent_config, staged_crafted_tools, staged_memory_chunks,
             staged_session_messages,
             staged_conversation_entries, staged_conversation_entry_parts, staged_context_members,
             staged_files,
             transfer_id, expected_seq, section_cursor, stream, file_path, file_bytes,
             want_agent_config, want_crafted_tools, want_memory_chunks,
             want_session_messages,
             want_conversation_entries, want_conversation_entry_parts, want_context_members,
             want_files, published
      FROM fork_transfer WHERE id = 1 LIMIT 1
    `[0];

    if (row === undefined) return null;

    return {
      head: row.head_declared === 0 ? null : {
        source: { workspaceId: row.head_source_id, workspaceName: row.head_source_name },
        cut: { messageId: row.head_cut_message_id, createdAtMs: row.head_cut_created_at },
      },
      mission: row.mission,
      staged: {
        agentConfig: row.staged_agent_config,
        craftedTools: row.staged_crafted_tools,
        memoryChunks: row.staged_memory_chunks,
        sessionMessages: row.staged_session_messages,
        conversationEntries: row.staged_conversation_entries,
        conversationEntryParts: row.staged_conversation_entry_parts,
        contextMembers: row.staged_context_members,
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
        sessionMessages: row.want_session_messages,
        conversationEntries: row.want_conversation_entries,
        conversationEntryParts: row.want_conversation_entry_parts,
        contextMembers: row.want_context_members,
        files: row.want_files,
      },
      published: row.published === 1,
    };
  }

  /** Claim the row for this fork; every other column (including the publication flag) resets to its default. */
  begin(head: ForkSnapshotHead): void {
    void this.sql`INSERT OR REPLACE INTO fork_transfer
      (id, head_declared, head_source_id, head_source_name, head_cut_message_id, head_cut_created_at)
      VALUES (1, 1, ${head.source.workspaceId}, ${head.source.workspaceName},
              ${head.cut.messageId}, ${head.cut.createdAtMs})`;
  }

  /** The wire's half of the reset: transfer id, declared counts, cursor after `begin`. */
  declare(input: { transferId: string; declared: ForkStagedCounts; expectedSeq: number; stream: string }): void {
    void this.sql`UPDATE fork_transfer SET
      transfer_id = ${input.transferId}, expected_seq = ${input.expectedSeq}, stream = ${input.stream},
      want_agent_config = ${input.declared.agentConfig}, want_crafted_tools = ${input.declared.craftedTools},
      want_memory_chunks = ${input.declared.memoryChunks},
      want_session_messages = ${input.declared.sessionMessages},
      want_conversation_entries = ${input.declared.conversationEntries},
      want_conversation_entry_parts = ${input.declared.conversationEntryParts},
      want_context_members = ${input.declared.contextMembers},
      want_files = ${input.declared.files}
      WHERE id = 1`;
  }

  advance(input: { expectedSeq: number; sectionCursor: number; stream: string }): void {
    void this.sql`UPDATE fork_transfer SET
      expected_seq = ${input.expectedSeq}, section_cursor = ${input.sectionCursor}, stream = ${input.stream}
      WHERE id = 1`;
  }

  /** The file in flight, or null once its last range has been committed. */
  file(path: string | null, bytes: number): void {
    void this.sql`UPDATE fork_transfer SET file_path = ${path}, file_bytes = ${bytes} WHERE id = 1`;
  }

  /** Add taken rows for every section in one statement (a column name cannot be bound). */
  count(delta: Partial<ForkStagedCounts>): void {
    void this.sql`UPDATE fork_transfer SET
      staged_agent_config             = staged_agent_config             + ${delta.agentConfig ?? 0},
      staged_crafted_tools            = staged_crafted_tools            + ${delta.craftedTools ?? 0},
      staged_memory_chunks            = staged_memory_chunks            + ${delta.memoryChunks ?? 0},
      staged_session_messages         = staged_session_messages         + ${delta.sessionMessages ?? 0},
      staged_conversation_entries     = staged_conversation_entries     + ${delta.conversationEntries ?? 0},
      staged_conversation_entry_parts = staged_conversation_entry_parts + ${delta.conversationEntryParts ?? 0},
      staged_context_members          = staged_context_members          + ${delta.contextMembers ?? 0},
      staged_files                    = staged_files                    + ${delta.files ?? 0}
      WHERE id = 1`;
  }

  /** The mission SOUL carried, taken while its bytes were in hand. */
  mission(mission: string): void {
    void this.sql`UPDATE fork_transfer SET mission = ${mission} WHERE id = 1`;
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
