/**
 * Workspace fork — the storage half, shared by every backend.
 *
 * Forks a source workspace's SQLite state into a target workspace's (a fork is
 * a NEW workspace by a new name). The semantics are "clean-slate messages-only":
 *
 *   Copy:   SOUL.md, the cut message's ancestry in the session tree,
 *           memory/* VFS rows + memory_chunks, crafted_tools, agent_config
 *           EXCEPT the shell-approval authority rows — see the snapshot below
 *   Reset:  search_nodes, scaffold_versions, task_history, craft quality,
 *           fibers, evolution_events, executor_output, activity_log,
 *           agent_tasks, scaffold/* VFS rows
 *   Rewrite: workspace_identity (new id/name/created_at)
 *   Insert: fork_lineage (single row)
 *
 * "Ancestry" and not "everything older than the cut" is the whole difference
 * between forking a tree and forking a list. A prefix cut cannot express a
 * second child of the same message, and on the Cloudflare backend it could not
 * even find the boundary: the SDK's store stamps whole seconds, and a turn
 * emits several messages inside one. See `identity/conversation-store.ts`.
 *
 * The read and the write are separable on purpose. A fork often crosses a
 * process boundary — on Cloudflare the source and the target are two different
 * Durable Objects and there is no cross-DO SQL — so the source materializes a
 * {@link ForkSnapshot} and ships it. That snapshot IS the source view: the copy
 * is defined once here, over the query set core owns, rather than a second
 * hand-maintained transcription of it living in whichever backend has to send
 * it across.
 *
 * On that boundary the snapshot does not cross as one value: one serialized
 * RPC argument is capped (`do.facet.rpc_bytes`) and a workspace's history is
 * not. `identity/fork-transfer.ts` owns that wire — bounded batches of rows and
 * bounded ranges of files, staged straight into the target's own storage. No
 * total size is refused; a bigger workspace is more frames.
 *
 * The target DB MUST already have been initialized (initWorkspaceSchema) — the
 * caller is responsible for that (typically via the boot path, which
 * auto-bootstraps a default identity that this helper then overwrites).
 *
 * Backend-agnostic: only SqlExecutor tagged-template queries, no DO-specific
 * APIs. The CF backend drives the write inside a transactionSync() for
 * atomicity; tests drive both halves against two bun:sqlite handles.
 *
 * Formal spec + rationale: docs/WORKSPACES.md.
 */

import * as v from 'valibot';
import type { SqlExecutor, VFS } from '../types/primitives';
import { SOUL_PATH, summarizeSoul } from './soul';
import { SHELL_APPROVAL_AUTHORITY_KEYS } from '../config/store';
import { CHAT_SESSION_ID, forkAncestry, hasPaneStore } from './conversation-store';
import { ForkStagingState } from './fork-staging';
import { invalidateConversationSearchIndex } from '../memory/conversation-search';
import { uiMessageText } from '../utils/ui-message';

/** The serialized UI message form of one stored row — what the SDK's pane
 *  store renders and therefore what a pane-shaped write must land. */
function encodeUiMessage(id: string, role: string, text: string): string {
  return JSON.stringify({ id, role, parts: [{ type: 'text', text }] });
}

/** The pane stamp shape for a millisecond value. Whole seconds are what
 *  `CURRENT_TIMESTAMP` writes, but the SDK's DDL happily stores the fraction —
 *  and the marker's cut-point-plus-one needs it to stay distinct. */
function paneStampOf(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)}`;
}

/**
 * What a fork copies, as valibot schemas.
 *
 * These are the CANONICAL declaration. Every TypeScript type below is inferred
 * from them, and `identity/fork-transfer.ts` builds its frame union out of the
 * same row schemas — so the rows a fork reads, the rows it puts on a wire and
 * the rows it writes are one authority with no second transcription to drift.
 *
 * Everything is JSON-serializable, so a snapshot also survives a transport that
 * only carries structured clones.
 */

/** The source workspace's identity and the message the fork is cut at — the
 *  fork's lineage parent, and its boundary. */
export const ForkSnapshotHeadSchema = v.object({
  source: v.object({ workspaceId: v.string(), workspaceName: v.string() }),
  cut: v.object({ messageId: v.string(), createdAtMs: v.number() }),
});

/**
 * One row of the cut message's ancestry, root first.
 *
 * `session_id` is not carried: the chain is by definition the chat session's,
 * and the write stamps it. `content` is null wherever a pane row under the same
 * id carries the same text — see `identity/conversation-store.ts`'s
 * `forkAncestry` — so one conversation crosses the transport once, not twice.
 * The write reconstructs it from the twin, which is why the pane section
 * crosses first.
 */
export const ForkMessageRowSchema = v.object({
  id: v.string(),
  parent_id: v.nullable(v.string()),
  role: v.string(),
  content: v.nullable(v.string()),
  created_at: v.number(),
});

/** The same chain in the SDK's own store — the table the chat pane hydrates
 *  from, whose serialized UI messages `messages.content` cannot rebuild.
 *  `created_at` is a datetime string, carried verbatim. */
export const ForkPaneRowSchema = v.object({
  id: v.string(),
  session_id: v.string(),
  parent_id: v.nullable(v.string()),
  role: v.string(),
  content: v.string(),
  created_at: v.string(),
});

/** One row of the FTS content table behind memory search. */
export const ForkMemoryChunkRowSchema = v.object({
  id: v.string(),
  path: v.string(),
  start_line: v.number(),
  end_line: v.number(),
  hash: v.string(),
  text: v.string(),
  updated_at: v.number(),
});

/** One crafted tool, snapshotted — the fork evolves it independently. */
export const ForkCraftedToolRowSchema = v.object({
  name: v.string(),
  description: v.string(),
  params: v.nullable(v.string()),
  code: v.string(),
  scope: v.string(),
  created_at: v.number(),
  updated_at: v.number(),
});

/** One agent_config row. The shell-approval authority keys never appear here:
 *  they are withheld at the READ, in {@link snapshotWorkspaceForFork}. */
export const ForkConfigRowSchema = v.object({ key: v.string(), value: v.string() });

/** One inherited file. A fork carries FILES, read through the workspace
 *  filesystem rather than lifted out of one storage engine's row encoding. */
export const ForkFileSchema = v.object({ path: v.string(), content: v.string() });

/**
 * The whole of what a fork copies, in one value.
 *
 * This is what the IN-PROCESS fork uses, where both databases are open in the
 * same process and there is no wire to bound. A hosted fork never materializes
 * it on either side — see `identity/fork-transfer.ts`.
 */
export const ForkSnapshotSchema = v.object({
  ...ForkSnapshotHeadSchema.entries,
  messages: v.array(ForkMessageRowSchema),
  assistantMessages: v.array(ForkPaneRowSchema),
  files: v.array(ForkFileSchema),
  memoryChunks: v.array(ForkMemoryChunkRowSchema),
  craftedTools: v.array(ForkCraftedToolRowSchema),
  agentConfig: v.array(ForkConfigRowSchema),
});

export type ForkSnapshotHead = v.InferOutput<typeof ForkSnapshotHeadSchema>;
export type ForkSnapshot = v.InferOutput<typeof ForkSnapshotSchema>;
export type ForkMessageRow = v.InferOutput<typeof ForkMessageRowSchema>;
export type ForkPaneRow = v.InferOutput<typeof ForkPaneRowSchema>;
export type ForkMemoryChunkRow = v.InferOutput<typeof ForkMemoryChunkRowSchema>;
export type ForkCraftedToolRow = v.InferOutput<typeof ForkCraftedToolRowSchema>;
export type ForkConfigRow = v.InferOutput<typeof ForkConfigRowSchema>;
export type ForkFile = v.InferOutput<typeof ForkFileSchema>;

export interface ForkOpts {
  /** Message id from source's `messages` table; the fork includes messages
   *  with created_at <= this message's created_at. Throws if not found. */
  untilMessageId: string;
  /** New target workspace's id (usually `ctx.id.toString()` on the fork DO). */
  targetWorkspaceId: string;
  /** New target workspace's human name. */
  targetWorkspaceName: string;
  /** Which store the target's default chat lives in. A local process answers
   *  to `messages` — the default here; a hosted caller may declare `'pane'`.
   *  See {@link writeForkSnapshot}'s option of the same name. */
  targetAuthority?: 'pane' | 'plain';
  /** Optional clock override for tests. Defaults to Date.now(). */
  now?: number;
}

export interface ForkResult {
  forkPointMs: number;
  messagesCopied: number;
  craftedToolsCopied: number;
}

/**
 * Materialize everything the fork write will need from the source workspace.
 *
 * Throws if `untilMessageId` is not a node of the source's session tree — the
 * one failure worth surfacing before a target workspace is created, and the
 * failure the operator hit: the id came from the chat pane, and the table this
 * resolved against was a turn-end summary that had never recorded it; the cut
 * now reads the store the pane renders, directly, and needs no projection.
 */
export async function snapshotWorkspaceForFork(
  source: SqlExecutor, sourceVfs: VFS, untilMessageId: string,
): Promise<ForkSnapshot> {
  // Both halves of the chain in one walk, with the plain text elided wherever
  // the pane rows already carry it. The chat pane hydrates from the SDK's store,
  // so a fork without those rows shows an empty pane despite a populated
  // `messages` table.
  const { chain: messages, pane: assistantMessages } = forkAncestry(source, untilMessageId);
  const lastMessage = messages[messages.length - 1];
  if (lastMessage === undefined) {
    throw new Error(`fork point not found: message id "${untilMessageId}" does not exist in source`);
  }
  const forkPointMs = lastMessage.created_at;

  const identity = source<{ id: string; name: string }>`
    SELECT id, name FROM workspace_identity LIMIT 1
  `;
  // The scaffold is deliberately excluded so the fork re-bootstraps v0 fresh.
  const files = await readForkFiles(sourceVfs);
  const craftedTools = source<ForkSnapshot['craftedTools'][number]>`
    SELECT name, description, params, code, scope, created_at, updated_at FROM crafted_tools
  `;
  // Every config row EXCEPT the ones the shell-approval gate reads as live
  // authorization. A remembered "always" and a permissive mode are decisions the
  // owner made about ONE workspace's history; copied into a child they let it
  // run matching commands without ever asking. Withheld at the SNAPSHOT rather
  // than at the write, so the authority never enters the value that crosses
  // between workspaces at all.
  const agentConfig = source<ForkSnapshot['agentConfig'][number]>`SELECT key, value FROM agent_config`
    .filter((row) => !SHELL_APPROVAL_AUTHORITY_KEYS.includes(row.key));

  // The FTS content table (agent-utils MemoryStore), created for every
  // workspace by initWorkspaceSchema. Carrying it is an optimization — the text
  // is in the memory/*.md FILES above, and a fork with no chunks reindexes via
  // FTS5 'rebuild' on its next write — but it is carried, because framing
  // removed the budget that used to make dropping it the cheaper answer.
  const memoryChunks = source<ForkSnapshot['memoryChunks'][number]>`
    SELECT id, path, start_line, end_line, hash, text, updated_at FROM memory_chunks
  `;

  return {
    source: {
      workspaceId: identity[0]?.id ?? '',
      workspaceName: identity[0]?.name ?? '',
    },
    cut: { messageId: untilMessageId, createdAtMs: forkPointMs },
    messages,
    assistantMessages,
    files,
    memoryChunks,
    craftedTools,
    agentConfig,
  };
}

/** Where a fork lands, and how. */
export interface ForkWriteTarget {
  workspaceId: string;
  workspaceName: string;
  now?: number;
  /** Hosted workspaces establish their owner before the external VFS copy;
   *  carry it through the identity rewrite so the row and file namespace
   *  cannot diverge. Local backends omit it. */
  ownerUserId?: string;
  /** Hosted workspaces use their owner-only filesystem writer for SOUL.md;
   *  every other inherited file remains an ordinary workspace write. */
  writeSoulFile?: (content: string) => Promise<void>;
  /**
   * Which store the TARGET's default chat lives in, declared by the caller
   * because presence of `assistant_messages` cannot be inferred from — a hosted
   * target that has not run its first turn does not have the table yet, and an
   * imported workspace must not grow one. Hosted callers pass 'pane'; local
   * callers pass 'plain' (or omit it: local is also what an unset value has
   * always meant).
   */
  targetAuthority?: 'pane' | 'plain';
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
  assistantMessages: number;
  messages: number;
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
 * The in-process fork drives the same methods over a whole snapshot; see
 * {@link writeForkSnapshot}. There is one write, driven two ways.
 */
export class ForkTargetWriter {
  private readonly authority: 'pane' | 'plain';
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
    // The destination is DECLARED, not discovered: a hosted fork target that
    // has not run its first turn does not have the pane table yet, so "whatever
    // table exists" would silently land a cloud fork in the wrong store.
    this.authority = opts.targetAuthority ?? (hasPaneStore(target) ? 'pane' : 'plain');
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
    this.staging.begin(head);
  }

  /**
   * Delete every row this write owns, so a retry self-heals: an abandoned
   * staging state from an earlier attempt is gone before a row of this one
   * lands, and nothing has to detect that it was there.
   *
   * `workspace_identity` is deliberately NOT cleared. On a hosted target the
   * owner row is the precondition for the target's own file plane — the Nimbus
   * namespace is derived from it — so it exists before staging and is rewritten
   * in {@link ForkTargetWriter.publishRows}, the moment the target becomes a
   * fork.
   */
  clearStagedRows(): void {
    void this.target`DELETE FROM messages`;
    void this.target`DELETE FROM crafted_tools`;
    void this.target`DELETE FROM memory_chunks`;
    void this.target`DELETE FROM agent_config`;
    void this.target`DELETE FROM fork_lineage`;
    if (hasPaneStore(this.target)) void this.target`DELETE FROM assistant_messages`;
  }

  stageAgentConfig(rows: readonly ForkConfigRow[]): void {
    for (const row of rows) {
      void this.target`INSERT OR REPLACE INTO agent_config (key, value) VALUES (${row.key}, ${row.value})`;
    }
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

  /** The rich chain, into the store the chat pane hydrates from. Staged before
   *  the plain rows because a plain row whose text was elided for the wire is
   *  reconstructed from its twin here — a SQL read, not a buffered map. */
  stagePaneMessages(rows: readonly ForkPaneRow[]): void {
    if (rows.length === 0) return;
    this.ensurePaneTable();
    for (const m of rows) {
      void this.target`
        INSERT OR IGNORE INTO assistant_messages (id, session_id, parent_id, role, content, created_at)
        VALUES (${m.id}, ${m.session_id}, ${m.parent_id}, ${m.role}, ${m.content}, ${m.created_at})
      `;
    }
    this.staging.count({ assistantMessages: rows.length });
  }

  /**
   * The plain chain. WHERE it lands depends on the authority, and that decision
   * is already complete here because the pane section crosses first.
   *
   * The transcript lands ONCE, in ONE store. Every workspace carries its default
   * chat in exactly one place — the SDK pane store where the source had one,
   * plain `messages` otherwise. Writing both would recreate the mirror the
   * canonical conversation store exists to delete, so a pane-authority target
   * whose rich chain already arrived DROPS these rows rather than writing a
   * second copy of the same conversation.
   */
  stageMessages(rows: readonly ForkMessageRow[]): void {
    const richChainStaged = this.staged.assistantMessages > 0;
    this.staging.count({ messages: rows.length });
    if (this.authority === 'pane') {
      if (richChainStaged) return;
      // A pane-shaped target fed by a plain-sourced snapshot: each flattened
      // row is encoded as the serialized UI message the pane renders.
      this.ensurePaneTable();
      for (const m of rows) {
        const text = this.carriedText(m);
        void this.target`
          INSERT OR IGNORE INTO assistant_messages (id, session_id, parent_id, role, content, created_at)
          VALUES (${m.id}, ${''}, ${m.parent_id}, ${m.role}, ${encodeUiMessage(m.id, m.role, text)},
                  ${paneStampOf(m.created_at)})
        `;
      }
      return;
    }
    // Plain destination: PKs and parent edges preserved — the chain IS the
    // tree, carried verbatim.
    for (const m of rows) {
      void this.target`
        INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
        VALUES (${m.id}, ${CHAT_SESSION_ID}, ${m.parent_id}, ${m.role}, ${this.carriedText(m)}, ${m.created_at})
      `;
    }
  }

  /**
   * One inherited file, whole.
   *
   * Whole rather than ranged because {@link VFS} has no append — `writeFile` is
   * the only write there is. So the caller assembles ONE file at a time and the
   * peak is that file, never the snapshot. SOUL.md also yields the fork mission
   * here, taken while the content is in hand rather than by reading the file
   * back at publish.
   */
  async stageFile(path: string, content: string): Promise<void> {
    this.staging.addFile(path);
    const dir = path.slice(0, path.lastIndexOf('/'));
    if (dir) await this.targetVfs.mkdir(dir, { recursive: true });
    if (path === SOUL_PATH) this.staging.mission(summarizeSoul(content));
    if (path === SOUL_PATH && this.opts.writeSoulFile) await this.opts.writeSoulFile(content);
    else await this.targetVfs.writeFile(path, content);
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
    return this.staging.read()?.staged
      ?? { agentConfig: 0, craftedTools: 0, memoryChunks: 0, assistantMessages: 0, messages: 0, files: 0 };
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
    if (this.authority === 'pane') this.ensurePaneTable();

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
    void this.target`
      INSERT OR REPLACE INTO agent_config (key, value) VALUES ('display_name', ${this.opts.workspaceName})`;

    // 4. Lineage — single row, and the thing that makes this workspace a fork.
    void this.target`
      INSERT INTO fork_lineage
      (id, source_workspace_id, source_workspace_name, source_message_id, source_message_created_at, forked_at)
      VALUES
      (1, ${head.source.workspaceId}, ${head.source.workspaceName},
       ${head.cut.messageId}, ${forkPointMs}, ${this.now})
    `;

    // 5. The fork marker: one system-role message parented on the cut point, so
    //    the chat pane shows a visible boundary between inherited history and
    //    the fork own future turns, and the next model turn reads it as part of
    //    the transcript it already reads. It is a node of the session tree and
    //    nothing else — a copy the model never reads is not context, it is a row.
    const syntheticText =
      `You were forked from workspace "${head.source.workspaceName}" at message ${head.cut.messageId} on `
      + `${new Date(this.now).toISOString()}. The conversation above happened before the fork. `
      + `Your current tool set and memory are authoritative; ignore any tools or context `
      + `referenced before the fork that you don't see in your active tool list.`;
    const markerId = `fork-marker-${this.opts.workspaceId.slice(0, 8)}-${this.now}`;
    if (this.authority === 'pane') {
      void this.target`
        INSERT OR IGNORE INTO assistant_messages (id, session_id, parent_id, role, content, created_at)
        VALUES (${markerId}, ${''}, ${head.cut.messageId}, ${'system'},
                ${encodeUiMessage(markerId, 'system', syntheticText)}, ${paneStampOf(forkPointMs + 1)})
      `;
    } else {
      void this.target`
        INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
        VALUES (${markerId}, ${CHAT_SESSION_ID}, ${head.cut.messageId}, ${'system'},
                ${syntheticText}, ${forkPointMs + 1})
      `;
      // The pane table existed only to resolve elided text on a plain target.
      // Keeping it would leave an imported workspace with a store it never had.
      if (staged.paneTableCreated) void this.target`DROP TABLE assistant_messages`;
    }

    // The staged files are the fork's files now, so the cleanup list is spent.
    // The transfer row is NOT: it is what answers a frame re-delivered after the
    // source lost the reply, and it is dropped by the next `begin`.
    this.staging.dropFiles();
    this.staging.markPublished();
    return forkResultOf(head, staged.staged);
  }

  /**
   * The agents SDK session provider creates this table on its first append, so
   * a target that has not run a hosted turn does not have it yet — created here
   * with the SDK own definition (agents,
   * src/experimental/memory/session/providers/agent.ts) so a hosted target can
   * never come up with an empty pane beside a full `messages`.
   *
   * The DDL runs even when the table already exists, because a target carrying
   * the SDK table need not carry these indexes and the pane ancestry walk is
   * what reads them. The staged `paneTableCreated` flag records only whether the
   * TABLE was absent, which is the one fact {@link ForkTargetWriter.publishRows}
   * needs to decide whether a plain target may keep it.
   */
  private ensurePaneTable(): void {
    if (!hasPaneStore(this.target)) this.staging.paneTableCreated();
    void this.target`
      CREATE TABLE IF NOT EXISTS assistant_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL DEFAULT '',
        parent_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
    void this.target`CREATE INDEX IF NOT EXISTS idx_assistant_msg_parent  ON assistant_messages(parent_id)`;
    void this.target`CREATE INDEX IF NOT EXISTS idx_assistant_msg_session ON assistant_messages(session_id)`;
  }

  /** The text a plain row carries: verbatim, or flattened from the rich twin
   *  already staged under the same id. */
  private carriedText(row: ForkMessageRow): string {
    if (row.content !== null) return row.content;
    const twin = hasPaneStore(this.target)
      ? this.target<{ content: string }>`
          SELECT content FROM assistant_messages WHERE id = ${row.id} LIMIT 1`[0]
      : undefined;
    if (!twin) {
      throw new Error(
        `fork snapshot elided the text of message "${row.id}" but carries no assistant_messages row `
        + `under that id, so the transcript cannot be reconstructed`,
      );
    }
    return uiMessageText(twin.content);
  }
}

/** One transfer's result, from the state the target stored. The wire returns it
 *  at the publication and again for every frame re-delivered afterwards, so it
 *  is derived in ONE place from ONE authority. */
function forkResultOf(head: ForkSnapshotHead, counts: ForkStagedCounts): ForkResult {
  return {
    forkPointMs: head.cut.createdAtMs,
    messagesCopied: counts.messages,
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

  const rows = (): ForkResult => {
    writer.clearStagedRows();
    writer.stageAgentConfig(snapshot.agentConfig);
    writer.stageCraftedTools(snapshot.craftedTools);
    writer.stageMemoryChunks(snapshot.memoryChunks);
    writer.stagePaneMessages(snapshot.assistantMessages);
    writer.stageMessages(snapshot.messages);
    return writer.publishRows();
  };
  let result: ForkResult | null = null;
  if (opts.transaction) opts.transaction(() => { result = rows(); });
  else result = rows();
  if (result === null) throw new Error('fork write transaction produced no result');
  return result;
}

/** Read a source workspace and land it in a target, in one call — the shape a
 *  backend uses when both databases are open in the same process. */
export async function forkWorkspaceStorage(
  source: SqlExecutor,
  sourceVfs: VFS,
  target: SqlExecutor,
  targetVfs: VFS,
  opts: ForkOpts,
): Promise<ForkResult> {
  const snapshot = await snapshotWorkspaceForFork(source, sourceVfs, opts.untilMessageId);
  return writeForkSnapshot(target, targetVfs, snapshot, {
    workspaceId: opts.targetWorkspaceId,
    workspaceName: opts.targetWorkspaceName,
    now: opts.now,
    targetAuthority: opts.targetAuthority ?? 'plain',
  });
}

/** Shape of what getForkLineage returns (null when not a fork). */
export interface ForkLineageRow {
  sourceWorkspaceId: string;
  sourceWorkspaceName: string;
  sourceMessageId: string;
  sourceMessageCreatedAt: number;
  forkedAt: number;
}

/** Read the single-row fork_lineage. Returns null when not a fork.
 *
 *  `fork_lineage` is created by initAllTables on every workspace, and an empty
 *  result already says "not a fork" — so there was never a condition for the
 *  catch that used to wrap this, only the ability to report a broken read as a
 *  workspace with no parent. */
export function readForkLineage(sql: SqlExecutor): ForkLineageRow | null {
  const rows = sql<{
    source_workspace_id: string; source_workspace_name: string;
    source_message_id: string; source_message_created_at: number;
    forked_at: number;
  }>`SELECT source_workspace_id, source_workspace_name, source_message_id,
            source_message_created_at, forked_at
     FROM fork_lineage WHERE id = 1 LIMIT 1`;
  const r = rows[0];
  if (!r) return null;
  return {
    sourceWorkspaceId: r.source_workspace_id,
    sourceWorkspaceName: r.source_workspace_name,
    sourceMessageId: r.source_message_id,
    sourceMessageCreatedAt: r.source_message_created_at,
    forkedAt: r.forked_at,
  };
}

/**
 * The paths a fork inherits, in the order it carries them: SOUL.md, then
 * everything under `memory/`.
 *
 * A directory walk rather than a table scan — the fork carries what the agent
 * can see, so a store that chunks or compresses differently cannot change what
 * a fork means. The scaffold is deliberately absent so a fork re-bootstraps v0
 * fresh.
 *
 * Paths and not contents, so the streaming sender in
 * `identity/fork-transfer.ts` can declare how many files are coming and then
 * read them one at a time. It is the same walk either way: which files a fork
 * carries is decided here, once.
 */
export async function* forkFilePaths(vfs: VFS): AsyncGenerator<string> {
  if (await vfs.exists(SOUL_PATH)) yield SOUL_PATH;
  const walk = async function* (dir: string): AsyncGenerator<string> {
    for (const name of await vfs.readdir(dir)) {
      const full = `${dir}/${name}`;
      const st = await vfs.stat(full);
      if (st?.isDir) yield* walk(full);
      else if (st) yield full;
    }
  };
  if (await vfs.exists('memory')) yield* walk('memory');
}

/** The files a fork inherits, read whole — the in-process shape, over the one
 *  walk {@link forkFilePaths} owns. */
async function readForkFiles(vfs: VFS): Promise<ForkSnapshot['files']> {
  const out: ForkSnapshot['files'] = [];
  for await (const path of forkFilePaths(vfs)) {
    out.push({ path, content: v.parse(v.string(), await vfs.readFile(path, { encoding: 'utf8' })) });
  }
  return out;
}
