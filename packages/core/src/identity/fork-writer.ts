/** Workspace fork write and its accounting. The target DB must already be initialized (initWorkspaceSchema). */

import type { SqlExecutor, VFS } from '../types/primitives';
import { SOUL_PATH } from './soul';
import { CHAT_SESSION_ID } from '../session/transcript-schema';
import { ForkStagingState } from './fork-staging';
import { invalidateConversationSearchIndex } from '../memory/conversation-search';
import { openWorkspaceMainActor, WorkspaceActorDirectory } from './workspace-actors';
import { KinuError } from '../obs/error';
import { forkArtifactPath } from './fork-plan';
import type {
  ForkConfigRow,
  ForkContextMemberRow,
  ForkConversationEntryPartRow,
  ForkConversationEntryRow,
  ForkCraftedToolRow,
  ForkMemoryChunkRow,
  ForkSessionMessageRow,
  ForkSnapshotHead,
} from './fork-rows';

/** Revision of the target's fresh context: a restoration of the cut membership, not a continuation. */
const FORK_CONTEXT_REVISION = 1;

export interface ForkResult {
  forkPointMs: number;
  messagesCopied: number;
  craftedToolsCopied: number;
}

export interface ForkWriteTarget {
  workspaceId: string;
  workspaceName: string;
  /** Target actor payload directory; carried payload references and files are re-rooted here. */
  artifactDirectory: string;
  now?: number;
  /** Hosted owner, carried through the identity rewrite so row and file namespace cannot diverge. Local backends omit it. */
  ownerUserId?: string;
  /** Runs the publication atomically. Staging happens outside it: a host transaction is
     *  synchronous and the filesystem is not. */
  transaction?: (rows: () => void) => void;
}

/** How much a writer has taken; checked against the source's declaration before publishing. */
export interface ForkStagedCounts {
  agentConfig: number;
  craftedTools: number;
  memoryChunks: number;
  sessionMessages: number;
  conversationEntries: number;
  conversationEntryParts: number;
  contextMembers: number;
  files: number;
}

/**
 * The fork write: `begin`, a `stage` per batch, then `publish`; the target is not a fork until publish.
 * Stage order is foreign-key order (messages, entries, parts, context) since no transaction spans a hosted transfer.
 */
/** The one system-role message a fork lands on its cut point. */
interface ForkMarker {
  readonly actorId: string;
  readonly markerId: string;
  readonly parentId: string;
  readonly text: string;
  readonly recordedAt: number;
}

export class ForkTargetWriter {
  private readonly now: number;
  /** Transfer state, read back from the target since frames arrive on several DO activations ({@link ForkStagingState}). */
  readonly staging: ForkStagingState;

  constructor(
    private readonly target: SqlExecutor,
    private readonly targetVfs: VFS,
    private readonly opts: ForkWriteTarget,
  ) {
    this.now = opts.now ?? Date.now();
    this.staging = new ForkStagingState(target);
  }

  /** The target's main actor, resolved on demand: {@link begin} creates it on a target with no identity yet. */
  private get actorId(): string {
    return openWorkspaceMainActor(this.target).actorId;
  }

  /** Target-side destination of one carried payload file, shared by staging list, sink and SQL references. */
  artifactPath(relative: string): string {
    return forkArtifactPath(relative, this.opts.artifactDirectory);
  }

  /** Record which fork this is and reset accounting. Separate from {@link clearStagedRows} so row
     *  deletion can run where the caller's transaction can roll it back. */
  begin(head: ForkSnapshotHead): void {
    const current = this.target<{ id: string; owner_user_id: string }>`SELECT id, owner_user_id FROM workspace_identity`[0];

    if (!current) {
      void this.target`INSERT INTO workspace_identity(id,name,owner_user_id,created_at) VALUES (${this.opts.workspaceId},${this.opts.workspaceName},${this.opts.ownerUserId ?? ''},${this.now})`;
      new WorkspaceActorDirectory(this.target, { workspaceId: this.opts.workspaceId, ownerUserId: this.opts.ownerUserId ?? '' }).createMain({ name: this.opts.workspaceName });
    } else {
      if (current.id !== this.opts.workspaceId) throw new KinuError('denied', 'The fork target does not match its durable workspace identity.');
      openWorkspaceMainActor(this.target);
    }

    this.staging.begin(head);
  }

  /**
     * Delete every row this write owns so a retry self-heals; children first, entry-parent edges released first.
     * `workspace_identity` is kept: a hosted target's file namespace derives from its owner row.
     */
  clearStagedRows(): void {
    const actorId = this.actorId;
    void this.target`DELETE FROM crafted_tools`;
    void this.target`DELETE FROM memory_chunks`;
    void this.target`DELETE FROM actor_config WHERE actor_id = ${actorId}`;
    void this.target`DELETE FROM fork_lineage`;
    void this.target`DELETE FROM conversation_heads WHERE actor_id = ${actorId}`;
    void this.target`DELETE FROM conversation_entry_parts WHERE actor_id = ${actorId}`;
    // Release parent edges first; one DELETE may remove a parent before its child.
    void this.target`UPDATE conversation_entries SET parent_id = ${null} WHERE actor_id = ${actorId}`;
    void this.target`DELETE FROM conversation_entries WHERE actor_id = ${actorId}`;
    void this.target`DELETE FROM context_memberships WHERE actor_id = ${actorId}`;
    void this.target`DELETE FROM actor_context_selection WHERE actor_id = ${actorId}`;
    void this.target`UPDATE actor_contexts SET fork_context_id = ${null}, fork_revision = ${null} WHERE actor_id = ${actorId}`;
    void this.target`DELETE FROM context_revisions WHERE actor_id = ${actorId}`;
    void this.target`DELETE FROM actor_contexts WHERE actor_id = ${actorId}`;
    void this.target`DELETE FROM stream_parts WHERE actor_id = ${actorId}`;
    void this.target`DELETE FROM session_messages WHERE actor_id = ${actorId}`;
  }

  stageAgentConfig(rows: readonly ForkConfigRow[]): void {
    const config = openWorkspaceMainActor(this.target).config;

    for (const row of rows) config.set(row.key, row.value);
    this.staging.count({ agentConfig: rows.length });
  }

  stageCraftedTools(rows: readonly ForkCraftedToolRow[]): void {
    for (const t of rows) {
      void this.target`
        INSERT OR REPLACE INTO crafted_tools
        (name, description, params, code, scope, created_at, updated_at)
        VALUES (${t.name}, ${t.description}, ${t.params}, ${t.code}, ${t.scope}, ${t.created_at}, ${t.updated_at})
      `;
    }

    this.staging.count({ craftedTools: rows.length });
  }

  /** FTS content table behind memory search; a failure means the fork lost the parent's index. */
  stageMemoryChunks(rows: readonly ForkMemoryChunkRow[]): void {
    for (const c of rows) {
      void this.target`
        INSERT OR REPLACE INTO memory_chunks (id, path, start_line, end_line, hash, text, updated_at)
        VALUES (${c.id}, ${c.path}, ${c.start_line}, ${c.end_line}, ${c.hash}, ${c.text}, ${c.updated_at})
      `;
    }

    this.staging.count({ memoryChunks: rows.length });
  }

  /** Carried messages under this target's actor; request, output slot and ingress id do not cross. */
  stageSessionMessages(rows: readonly ForkSessionMessageRow[]): void {
    const actorId = this.actorId;

    for (const row of rows) {
      void this.target`
        INSERT INTO session_messages
        (actor_id, message_id, role, native_content_kind, origin, request_id, output_slot, ingress_id, recorded_at,
         envelope_json, sealed_at, content_json, content_path, content_digest)
        VALUES (${actorId}, ${row.message_id}, ${row.role}, ${row.native_content_kind}, ${row.origin},
                ${null}, ${null}, ${null}, ${row.recorded_at},
                ${row.envelope_json}, ${row.sealed_at}, ${row.content_json},
                ${row.content_path === null ? null : this.artifactPath(row.content_path)}, ${row.content_digest})
      `;
    }

    this.staging.count({ sessionMessages: rows.length });
  }

  /** The public chain, root first; context columns stay null until publication. */
  stageConversationEntries(rows: readonly ForkConversationEntryRow[]): void {
    const actorId = this.actorId;

    for (const row of rows) {
      void this.target`
        INSERT INTO conversation_entries
        (actor_id, session_id, id, parent_id, role, turn_id, run_id,
         metadata_json, metadata_path, metadata_digest, recorded_at, context_id, context_revision)
        VALUES (${actorId}, ${CHAT_SESSION_ID}, ${row.id}, ${row.parent_id}, ${row.role},
                ${row.turn_id}, ${row.run_id}, ${row.metadata_json},
                ${row.metadata_path === null ? null : this.artifactPath(row.metadata_path)},
                ${row.metadata_digest}, ${row.recorded_at}, ${null}, ${null})
      `;
    }

    this.staging.count({ conversationEntries: rows.length });
  }

  stageConversationEntryParts(rows: readonly ForkConversationEntryPartRow[]): void {
    const actorId = this.actorId;

    for (const row of rows) {
      void this.target`
        INSERT INTO conversation_entry_parts
        (actor_id, session_id, entry_id, position, message_id, part_no, text_start, text_length)
        VALUES (${actorId}, ${CHAT_SESSION_ID}, ${row.entry_id}, ${row.position}, ${row.message_id},
                ${row.part_no}, ${row.text_start}, ${row.text_length})
      `;
    }

    this.staging.count({ conversationEntryParts: rows.length });
  }

  /** The restored working context: one revision of a fresh context with the cut revision's membership. */
  stageContextMembers(rows: readonly ForkContextMemberRow[]): void {
    const actorId = this.actorId;
    const contextId = this.forkContext(actorId);

    for (const row of rows) {
      void this.target`
        INSERT INTO context_memberships
        (actor_id, context_id, entry_id, from_revision, to_revision, position, message_id)
        VALUES (${actorId}, ${contextId}, ${row.entry_id}, ${FORK_CONTEXT_REVISION}, ${null},
                ${row.position}, ${row.message_id})
      `;
    }

    this.staging.count({ contextMembers: rows.length });
  }

  /** Record an inherited file a native sink already published. SOUL is excluded: its protected writer returns the mission. */
  stageCommittedFile(path: string, mission?: string): void {
    if (path === SOUL_PATH) {
      if (mission === undefined) throw new Error('fork transfer committed SOUL.md without its protected write');
      this.staging.mission(mission);
    }

    this.staging.addFile(path);
    this.staging.count({ files: 1 });
  }

  /** Remove files a prior unpublished transfer staged, per the target's `fork_staged_files` rows. */
  async clearStagedFiles(): Promise<void> {
    for (const path of this.staging.files()) {
      if (await this.targetVfs.exists(path)) await this.targetVfs.unlink(path);
    }

    this.staging.dropFiles();
  }

  /** How much has landed, read from the target, for the wire's completeness check. */
  get staged(): ForkStagedCounts {
    return this.staging.read()?.staged ?? {
      agentConfig: 0, craftedTools: 0, memoryChunks: 0,
      sessionMessages: 0, conversationEntries: 0, conversationEntryParts: 0, contextMembers: 0,
      files: 0,
    };
  }

  /** The fork already published, if any; answers a re-delivered frame on any activation. */
  get published(): ForkResult | null {
    const staged = this.staging.read();

    return staged === null || !staged.published || staged.head === null
      ? null
      : forkResultOf(staged.head, staged.staged);
  }

  async publish(): Promise<ForkResult> {
    if (!this.opts.transaction) return this.publishRows();
    let result: ForkResult | null = null;
    this.opts.transaction(() => { result = this.publishRows(); });

    if (result === null) throw new Error('fork publication transaction produced no result');

    return result;
  }

  /** The publication as one synchronous unit, for a caller's host transaction. */
  publishRows(): ForkResult {
    const staged = this.staging.read();
    const head = staged?.head ?? null;

    if (staged === null || head === null) {
      throw new Error('fork publication attempted before the transfer declared its head');
    }

    const forkPointMs = head.cut.createdAtMs;
    const actorId = this.actorId;

    // A target without the cut entry got an incomplete transfer; refuse before the first write.
    const cut = this.target<{ id: string }>`
      SELECT id FROM conversation_entries
      WHERE actor_id = ${actorId} AND session_id = ${CHAT_SESSION_ID} AND id = ${head.cut.messageId}
    `[0]?.id;

    if (cut === undefined) {
      throw new KinuError('missing', `fork publication has no cut entry ${JSON.stringify(head.cut.messageId)} in the transferred chain`);
    }

    // Identity: new id, name, created_at; owner carries through.
    void this.target`DELETE FROM workspace_identity`;

    if (this.opts.ownerUserId) {
      void this.target`
        INSERT INTO workspace_identity (id, name, owner_user_id, created_at)
        VALUES (${this.opts.workspaceId}, ${this.opts.workspaceName}, ${this.opts.ownerUserId}, ${this.now})
      `;
    } else {
      void this.target`
        INSERT INTO workspace_identity (id, name, created_at)
        VALUES (${this.opts.workspaceId}, ${this.opts.workspaceName}, ${this.now})
      `;
    }

    void this.target`UPDATE workspace_identity SET mission = ${staged.mission}`;

    // The search index keyed on old rows is stale (equal counts evade its rowid watermark); invalidate it.
    invalidateConversationSearchIndex(this.target);

    openWorkspaceMainActor(this.target).config.setDisplayName(this.opts.workspaceName);

    // Lineage: what makes this workspace a fork.
    void this.target`
      INSERT INTO fork_lineage
      (id, source_workspace_id, source_workspace_name, source_message_id, source_message_created_at, forked_at)
      VALUES
      (1, ${head.source.workspaceId}, ${head.source.workspaceName},
       ${head.cut.messageId}, ${forkPointMs}, ${this.now})
    `;

    // The fork's working context; always present, empty if the cut recorded none.
    const contextId = this.forkContext(actorId);

    // The cut entry names the fork's context so a later fork at this boundary restores the same membership.
    void this.target`
      UPDATE conversation_entries SET context_id = ${contextId}, context_revision = ${FORK_CONTEXT_REVISION}
      WHERE actor_id = ${actorId} AND session_id = ${CHAT_SESSION_ID} AND id = ${head.cut.messageId}
    `;

    // Fork marker: a system entry on the cut point; a chain node only, deliberately not a context member.
    const syntheticText =
      `You were forked from workspace "${head.source.workspaceName}" at message ${head.cut.messageId} on `
      + `${new Date(this.now).toISOString()}. The conversation above happened before the fork. `
      + `Your current tool set and memory are authoritative; ignore any tools or context `
      + `referenced before the fork that you don't see in your active tool list.`;

    const markerId = `fork-marker-${this.opts.workspaceId.slice(0, 8)}-${this.now}`;
    this.writeForkMarker({
      actorId, markerId, parentId: cut, text: syntheticText, recordedAt: forkPointMs + 1,
    });
    void this.target`INSERT INTO conversation_heads (actor_id, session_id, entry_id) VALUES (${actorId}, ${CHAT_SESSION_ID}, ${markerId})`;

    // Staged files are the fork's now. The transfer row stays to answer re-delivered frames until the next `begin`.
    this.staging.dropFiles();
    this.staging.markPublished();

    return forkResultOf(head, staged.staged);
  }

  /** The marker as canonical rows, written via SQL because publication is synchronous;
     *  its text is small enough to be an inline payload. */
  private writeForkMarker(marker: ForkMarker): void {
    const { actorId, markerId, parentId, text, recordedAt } = marker;

    const content = JSON.stringify([{ partNo: 0, kind: 'text', streamOrder: 0, replyTo: null, value: { type: 'text', text } }]);
    void this.target`
      INSERT INTO session_messages
      (actor_id, message_id, role, native_content_kind, origin, request_id, output_slot, ingress_id, recorded_at,
       envelope_json, sealed_at, content_json, content_path, content_digest)
      VALUES (${actorId}, ${markerId}, ${'system'}, ${'string'}, ${'edit'}, ${null}, ${null}, ${null}, ${recordedAt},
              ${'{}'}, ${recordedAt}, ${content}, ${null}, ${null})
    `;

    void this.target`
      INSERT INTO conversation_entries
      (actor_id, session_id, id, parent_id, role, turn_id, run_id,
       metadata_json, metadata_path, metadata_digest, recorded_at, context_id, context_revision)
      VALUES (${actorId}, ${CHAT_SESSION_ID}, ${markerId}, ${parentId}, ${'system'}, ${null}, ${null},
              ${null}, ${null}, ${null}, ${recordedAt}, ${null}, ${null})
    `;

    void this.target`
      INSERT INTO conversation_entry_parts
      (actor_id, session_id, entry_id, position, message_id, part_no, text_start, text_length)
      VALUES (${actorId}, ${CHAT_SESSION_ID}, ${markerId}, ${0}, ${markerId}, ${0}, ${null}, ${null})
    `;
  }

  /** The fork's own context, created once and read back (membership and publication may run on different
     *  activations). An existing selection is adopted so the target never has two. */
  private forkContext(actorId: string): string {
    const selected = this.target<{ context_id: string }>`
      SELECT context_id FROM actor_context_selection WHERE actor_id = ${actorId}
    `[0]?.context_id;

    const contextId = selected ?? crypto.randomUUID();

    if (selected === undefined) {
      void this.target`
        INSERT INTO actor_contexts (actor_id, context_id, fork_context_id, fork_revision)
        VALUES (${actorId}, ${contextId}, ${null}, ${null})
      `;
    }

    const revision = this.target<{ revision: number }>`
      SELECT revision FROM context_revisions
      WHERE actor_id = ${actorId} AND context_id = ${contextId} AND revision = ${FORK_CONTEXT_REVISION}
    `[0];

    if (revision === undefined) {
      void this.target`
        INSERT INTO context_revisions (actor_id, context_id, revision, author, cause, turn_id, proposal_id, recorded_at)
        VALUES (${actorId}, ${contextId}, ${FORK_CONTEXT_REVISION}, ${actorId}, ${'fork'}, ${null}, ${null}, ${this.now})
      `;
    }

    if (selected === undefined) {
      void this.target`INSERT INTO actor_context_selection (actor_id, context_id) VALUES (${actorId}, ${contextId})`;
    }

    return contextId;
  }
}

/** One transfer's result from stored state; returned at publication and for every re-delivered frame. */
function forkResultOf(head: ForkSnapshotHead, counts: ForkStagedCounts): ForkResult {
  return {
    forkPointMs: head.cut.createdAtMs,
    messagesCopied: counts.conversationEntries,
    craftedToolsCopied: counts.craftedTools,
  };
}
