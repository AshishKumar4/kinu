/**
 * Workspace fork — the write, and the accounting it publishes on.
 *
 * The target DB MUST already have been initialized (initWorkspaceSchema) — the
 * caller is responsible for that (typically via the boot path, which
 * auto-bootstraps a default identity that this helper then overwrites).
 */

import type { SqlExecutor, VFS } from '../types/primitives';
import { SOUL_PATH, summarizeSoul } from './soul';
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
  ForkSnapshot,
  ForkSnapshotHead,
} from './fork-rows';

/** The revision the target's fresh context is published at. The fork's context
 *  is a restoration of the cut revision's membership, not a continuation of the
 *  source's revision history, so it starts at one revision of its own. */
const FORK_CONTEXT_REVISION = 1;

export interface ForkResult {
  forkPointMs: number;
  messagesCopied: number;
  craftedToolsCopied: number;
}

/** Where a fork lands, and how. */
export interface ForkWriteTarget {
  workspaceId: string;
  workspaceName: string;
  /** Where the TARGET actor's payload files live. Carried payload references
   *  and carried payload FILES are re-rooted here, so the fork reads its own
   *  plane rather than the workspace it came from. */
  artifactDirectory: string;
  now?: number;
  /** Hosted workspaces establish their owner before the external VFS copy;
   *  carry it through the identity rewrite so the row and file namespace
   *  cannot diverge. Local backends omit it. */
  ownerUserId?: string;
  /** Hosted workspaces use their owner-only filesystem writer for SOUL.md;
   *  every other inherited file remains an ordinary workspace write. */
  writeSoulFile?: (content: string) => Promise<void>;
  /**
   * Runs the PUBLICATION atomically.
   *
   * Staged rows and files are written outside it and cannot be inside it: a
   * host transaction is synchronous, and the filesystem is not. What has to be
   * atomic is the moment the target BECOMES the fork — identity, lineage,
   * marker, display name — because that is the only state anything else
   * observes. Everything before it is staging in a workspace nothing can reach.
   */
  transaction?: (rows: () => void) => void;
}

/** How much a writer has taken. The wire checks this against what the source
 *  declared before it publishes. */
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
 * The fork write, as stage-then-publish.
 *
 * A hosted fork arrives as bounded batches over a wire (see
 * `identity/fork-transfer.ts`), so the write cannot be one call over one value.
 * It is {@link ForkTargetWriter.begin}, a `stage` call per batch, then
 * {@link ForkTargetWriter.publish} — and the target is not a fork until
 * `publish` runs. Before it there is no lineage, no fork marker, no mission and
 * no display name, so `readForkLineage` answers null and nothing downstream
 * treats the workspace as forked.
 *
 * THE STAGE ORDER IS THE FOREIGN-KEY ORDER. Messages precede the entries that
 * reference them, entries precede their part references, and the context
 * membership lands last — so each statement commits against rows that already
 * exist. Nothing here relies on a deferred
 * constraint, because a hosted transfer stages one frame per RPC and has no
 * transaction spanning the sections.
 *
 * The in-process fork drives the same methods over a whole snapshot; see
 * {@link writeForkSnapshot}. There is one write, driven two ways.
 */
/** The one system-role message a fork lands on its cut point: who owns it,
 *  what it says, and where in the chain it sits. */
interface ForkMarker {
  readonly actorId: string;
  readonly markerId: string;
  readonly parentId: string;
  readonly text: string;
  readonly recordedAt: number;
}

export class ForkTargetWriter {
  private readonly now: number;
  /**
   * Everything this write remembers about the transfer in progress.
   *
   * A hosted fork's frames arrive on several activations of one Durable Object,
   * so the accounting, the head and the mission are read back out of the target
   * rather than held in fields — see {@link ForkStagingState}. Readable because
   * the wire's receiver owns its own columns of the same row and there is one
   * accessor onto it, not two.
   */
  readonly staging: ForkStagingState;

  constructor(
    private readonly target: SqlExecutor,
    private readonly targetVfs: VFS,
    private readonly opts: ForkWriteTarget,
  ) {
    this.now = opts.now ?? Date.now();
    this.staging = new ForkStagingState(target);
  }

  /**
   * The target's own main actor.
   *
   * Resolved on demand rather than captured in the constructor: {@link begin}
   * is what CREATES this actor on a target that had no identity yet, so a field
   * read at construction would name an actor that does not exist.
   */
  private get actorId(): string {
    return openWorkspaceMainActor(this.target).actorId;
  }

  /** The target-side destination of one carried payload file. The receiver
   *  resolves an artifact frame's relative path through this, so the staging
   *  list, the sink and the SQL references all name one path. */
  artifactPath(relative: string): string {
    return forkArtifactPath(relative, this.opts.artifactDirectory);
  }

  /**
   * Record which fork this is, and reset what this write has taken.
   *
   * One row, one statement. The destructive half is {@link clearStagedRows},
   * and the two are separate because they belong at different moments:
   * accounting has to be reset before the first FILE lands, and the rows a
   * previous attempt left have to be deleted where the caller's transaction can
   * still roll the deletion back.
   */
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
   * Delete every row this write owns, so a retry self-heals: an abandoned
   * staging state from an earlier attempt is gone before a row of this one
   * lands, and nothing has to detect that it was there.
   *
   * Children before parents, and the one edge that points FORWARD — an entry's
   * parent into another entry — is released first, so the deletion needs no
   * deferred constraint either.
   *
   * `workspace_identity` is deliberately NOT cleared. On a hosted target the
   * owner row is the precondition for the target's own file plane — the Nimbus
   * namespace is derived from it — so it exists before staging and is rewritten
   * in {@link ForkTargetWriter.publishRows}, the moment the target becomes a
   * fork.
   */
  clearStagedRows(): void {
    const actorId = this.actorId;
    void this.target`DELETE FROM crafted_tools`;
    void this.target`DELETE FROM memory_chunks`;
    void this.target`DELETE FROM actor_config WHERE actor_id = ${actorId}`;
    void this.target`DELETE FROM fork_lineage`;
    void this.target`DELETE FROM conversation_heads WHERE actor_id = ${actorId}`;
    void this.target`DELETE FROM conversation_entry_parts WHERE actor_id = ${actorId}`;
    // The chain is a tree of rows referencing each other, and one DELETE removes
    // them in storage order: a parent can go before its child. Releasing the
    // edges first is what makes the deletion legal without a deferred check.
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

  /** The FTS content table behind memory search. Part of every workspace's
   *  schema, so a failure here means the fork lost the parent's memory index,
   *  not that there was nothing to copy. */
  stageMemoryChunks(rows: readonly ForkMemoryChunkRow[]): void {
    for (const c of rows) {
      void this.target`
        INSERT OR REPLACE INTO memory_chunks (id, path, start_line, end_line, hash, text, updated_at)
        VALUES (${c.id}, ${c.path}, ${c.start_line}, ${c.end_line}, ${c.hash}, ${c.text}, ${c.updated_at})
      `;
    }

    this.staging.count({ memoryChunks: rows.length });
  }

  /** Carried messages, whole, under THIS target's actor. The execution
   *  identity of the source turn does not cross: no request, no output slot, no
   *  ingress id. A content path is re-rooted under the target's artifact
   *  directory. */
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

  /** The public chain, root first — the tree carried verbatim under this
   *  target's actor. The context columns stay null here; the publication points
   *  the cut entry at the fork's own context. */
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

  /** The restored working context: one revision of one fresh context, whose
   *  membership is what the cut entry's revision selected, in its positions. */
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

  /**
   * One inherited file, whole.
   *
   * Whole rather than ranged because {@link VFS} has no append — `writeFile` is
   * the only write there is. So the caller assembles ONE file at a time and the
   * peak is that file, never the snapshot. SOUL.md also yields the fork mission
   * here, taken while the content is in hand rather than by reading the file
   * back at publish.
   *
   * `artifact` names a carried payload file, whose path is relative to the
   * artifact directory that owns it — the same flag the wire's file frame
   * carries, so one staging path serves both kinds.
   */
  async stageFile(path: string, content: string, artifact = false): Promise<void> {
    const destination = artifact ? this.artifactPath(path) : path;
    this.staging.addFile(destination);
    const dir = destination.slice(0, destination.lastIndexOf('/'));

    if (dir) await this.targetVfs.mkdir(dir, { recursive: true });

    if (!artifact && destination === SOUL_PATH) this.staging.mission(summarizeSoul(content));

    if (!artifact && destination === SOUL_PATH && this.opts.writeSoulFile) await this.opts.writeSoulFile(content);
    else await this.targetVfs.writeFile(destination, content);
    this.staging.count({ files: 1 });
  }

  /**
   * Record an inherited file that a fork-specific native sink already published.
   *
   * The streamed receiver never materializes ordinary files merely to hand them
   * back to this writer. SOUL is deliberately excluded: its protected writer
   * returns the mission after it has accepted the file.
   */
  stageCommittedFile(path: string, mission?: string): void {
    if (path === SOUL_PATH) {
      if (mission === undefined) throw new Error('fork transfer committed SOUL.md without its protected write');
      this.staging.mission(mission);
    }

    this.staging.addFile(path);
    this.staging.count({ files: 1 });
  }

  /**
   * Remove the exact files a prior unpublished transfer staged.
   *
   * The receiver calls this before a replacement `begin`. The list is the
   * target's own `fork_staged_files` rows, so it survives the activation that
   * wrote them: an abandoned attempt's files are removed by the transfer that
   * replaces it, whichever isolate that one runs in.
   */
  async clearStagedFiles(): Promise<void> {
    for (const path of this.staging.files()) {
      if (await this.targetVfs.exists(path)) await this.targetVfs.unlink(path);
    }

    this.staging.dropFiles();
  }

  /** How much has been taken, for the completeness check the wire performs
   *  before it publishes. Read from the target, so it counts what LANDED rather
   *  than what one activation happened to see. */
  get staged(): ForkStagedCounts {
    return this.staging.read()?.staged ?? {
      agentConfig: 0, craftedTools: 0, memoryChunks: 0,
      sessionMessages: 0, conversationEntries: 0, conversationEntryParts: 0, contextMembers: 0,
      files: 0,
    };
  }

  /** The fork this target has ALREADY published, if it has. The wire answers a
   *  re-delivered frame with this rather than refusing one that is already
   *  correct — including on an activation that never saw the commit. */
  get published(): ForkResult | null {
    const staged = this.staging.read();

    return staged === null || !staged.published || staged.head === null
      ? null
      : forkResultOf(staged.head, staged.staged);
  }

  /** Publish, atomically. Everything staged becomes a fork here and nowhere
   *  else. */
  async publish(): Promise<ForkResult> {
    if (!this.opts.transaction) return this.publishRows();
    let result: ForkResult | null = null;
    this.opts.transaction(() => { result = this.publishRows(); });

    if (result === null) throw new Error('fork publication transaction produced no result');

    return result;
  }

  /**
   * The publication, as one synchronous unit — what a caller wraps in a host
   * transaction. Public because the in-process write puts the staging AND the
   * publication inside one transaction, which is what makes a mid-write failure
   * there leave no fork at all.
   */
  publishRows(): ForkResult {
    const staged = this.staging.read();
    const head = staged?.head ?? null;

    if (staged === null || head === null) {
      throw new Error('fork publication attempted before the transfer declared its head');
    }

    const forkPointMs = head.cut.createdAtMs;
    const actorId = this.actorId;

    // Every plan's carried chain ends in the cut entry, so a target that does
    // not hold it received an incomplete transfer; publishing anyway would
    // root the marker on nothing and leave the lineage naming an entry the
    // fork cannot read. Asked before the first write, so a refusal leaves the
    // target exactly as staged.
    const cut = this.target<{ id: string }>`
      SELECT id FROM conversation_entries
      WHERE actor_id = ${actorId} AND session_id = ${CHAT_SESSION_ID} AND id = ${head.cut.messageId}
    `[0]?.id;

    if (cut === undefined) {
      throw new KinuError('missing', `fork publication has no cut entry ${JSON.stringify(head.cut.messageId)} in the transferred chain`);
    }

    // 1. Identity: new id, new name, fresh created_at. The owner carries through
    //    so the row and the file namespace cannot diverge.
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

    // 2. The derived search index keyed on the OLD rows is stale by
    //    construction — purged and reseeded at equal counts is exactly what its
    //    rowid watermark cannot see. Invalidate deterministically; the next
    //    search rebuilds.
    invalidateConversationSearchIndex(this.target);

    // 3. display_name, so the UI shows the fork rather than the bootstrap.
    openWorkspaceMainActor(this.target).config.setDisplayName(this.opts.workspaceName);

    // 4. Lineage — single row, and the thing that makes this workspace a fork.
    void this.target`
      INSERT INTO fork_lineage
      (id, source_workspace_id, source_workspace_name, source_message_id, source_message_created_at, forked_at)
      VALUES
      (1, ${head.source.workspaceId}, ${head.source.workspaceName},
       ${head.cut.messageId}, ${forkPointMs}, ${this.now})
    `;

    // 5. The working context this fork starts from. Always present: an actor
    //    without a selected context has nothing to read, and a fork whose cut
    //    recorded no context starts from an empty one rather than from none.
    const contextId = this.forkContext(actorId);

    // The cut entry names the fork's context, so a fork taken AT this
    // boundary later restores the same membership rather than walking past it.
    void this.target`
      UPDATE conversation_entries SET context_id = ${contextId}, context_revision = ${FORK_CONTEXT_REVISION}
      WHERE actor_id = ${actorId} AND session_id = ${CHAT_SESSION_ID} AND id = ${head.cut.messageId}
    `;

    // 6. The fork marker: one system-role entry parented on the cut point, so
    //    the chat shows a visible boundary between inherited history and the
    //    fork's own future turns. It is a node of the public chain and nothing
    //    else — it is deliberately not a context member, because a copy the
    //    model never reads is not context, it is a row.
    const syntheticText =
      `You were forked from workspace "${head.source.workspaceName}" at message ${head.cut.messageId} on `
      + `${new Date(this.now).toISOString()}. The conversation above happened before the fork. `
      + `Your current tool set and memory are authoritative; ignore any tools or context `
      + `referenced before the fork that you don't see in your active tool list.`;

    const markerId = `fork-marker-${this.opts.workspaceId.slice(0, 8)}-${this.now}`;
    this.writeForkMarker({
      actorId, markerId, parentId: cut, text: syntheticText, recordedAt: forkPointMs + 1,
    });
    // The marker is the chain's end: the fork's first turn chains from it.
    void this.target`INSERT INTO conversation_heads (actor_id, session_id, entry_id) VALUES (${actorId}, ${CHAT_SESSION_ID}, ${markerId})`;

    // The staged files are the fork's files now, so the cleanup list is spent.
    // The transfer row is NOT: it is what answers a frame re-delivered after the
    // source lost the reply, and it is dropped by the next `begin`.
    this.staging.dropFiles();
    this.staging.markPublished();

    return forkResultOf(head, staged.staged);
  }

  /**
   * The marker, as canonical rows: one sealed message with one text part, and
   * one entry referencing that part.
   *
   * Written through SQL rather than through the session stores because the
   * publication is synchronous by contract — a host transaction cannot await —
   * and the marker's text is small enough to be an inline payload, so nothing
   * here needs the filesystem.
   */
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

  /**
   * The fork's own context, created once and read back afterwards.
   *
   * Read back rather than remembered in a field: the membership arrives on one
   * activation and the publication may run on another, and both have to name
   * the same context. An existing selection that predates this transfer is
   * adopted and given this revision, so a target whose boot initialized a
   * context does not end up with two.
   */
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

/** One transfer's result, from the state the target stored. The wire returns it
 *  at the publication and again for every frame re-delivered afterwards, so it
 *  is derived in ONE place from ONE authority. */
function forkResultOf(head: ForkSnapshotHead, counts: ForkStagedCounts): ForkResult {
  return {
    forkPointMs: head.cut.createdAtMs,
    messagesCopied: counts.conversationEntries,
    craftedToolsCopied: counts.craftedTools,
  };
}

/**
 * Land a whole snapshot in the target workspace — the in-process fork, where
 * both databases are open at once and there is no wire to bound.
 *
 * The same {@link ForkTargetWriter} the streamed fork drives, in one call. Files
 * go first and outside any transaction the caller holds, because a host
 * transaction is synchronous and the filesystem is not; the staging and the
 * publication then go inside ONE transaction, so a mid-write failure here
 * leaves no fork rather than a half-copied one.
 */
export async function writeForkSnapshot(
  target: SqlExecutor,
  targetVfs: VFS,
  snapshot: ForkSnapshot,
  opts: ForkWriteTarget,
): Promise<ForkResult> {
  const writer = new ForkTargetWriter(target, targetVfs, opts);
  // The head and the counters are established before the first staged FILE, so
  // a file records its mission and its count against THIS transfer. The row
  // deletion stays inside the caller's transaction below, where a failed
  // publication rolls it back with everything else.
  writer.begin({ source: snapshot.source, cut: snapshot.cut });

  for (const file of snapshot.files) await writer.stageFile(file.path, file.content);

  for (const artifact of snapshot.artifacts) await writer.stageFile(artifact.path, artifact.content, true);

  const rows = (): ForkResult => {
    writer.clearStagedRows();
    writer.stageAgentConfig(snapshot.agentConfig);
    writer.stageCraftedTools(snapshot.craftedTools);
    writer.stageMemoryChunks(snapshot.memoryChunks);
    writer.stageSessionMessages(snapshot.sessionMessages);
    writer.stageConversationEntries(snapshot.conversationEntries);
    writer.stageConversationEntryParts(snapshot.conversationEntryParts);
    writer.stageContextMembers(snapshot.contextMembers);

    return writer.publishRows();
  };

  let result: ForkResult | null = null;

  if (opts.transaction) opts.transaction(() => { result = rows(); });
  else result = rows();

  if (result === null) throw new Error('fork write transaction produced no result');

  return result;
}
