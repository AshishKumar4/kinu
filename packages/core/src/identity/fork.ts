/**
 * Workspace fork — the storage half, shared by every backend.
 *
 * Forks a source workspace's SQLite state into a target workspace's (a fork is
 * a NEW workspace by a new name). The semantics are "clean-slate messages-only":
 *
 *   Copy:   SOUL.md, the cut message's ancestry in the session tree,
 *           memory/* VFS rows + memory_chunks, crafted_tools, agent_config
 *   Reset:  search_nodes, scaffold_versions, task_history, craft_scores,
 *           fibers, evolution_events, executor_output, activity_log,
 *           agent_tasks, scaffold/* VFS rows
 *   Rewrite: workspace_identity (new id/name/created_at)
 *   Insert: fork_lineage (single row)
 *
 * "Ancestry" and not "everything older than the cut" is the whole difference
 * between forking a tree and forking a list. A prefix cut cannot express a
 * second child of the same message, and on the Cloudflare backend it could not
 * even find the boundary: the SDK's store stamps whole seconds, and a turn
 * emits several messages inside one. See `identity/session-tree.ts`.
 *
 * The read and the write are separable on purpose. A fork often crosses a
 * process boundary — on Cloudflare the source and the target are two different
 * Durable Objects and there is no cross-DO SQL — so the source materializes a
 * {@link ForkSnapshot} and ships it. That snapshot IS the source view: the copy
 * is defined once here, over the query set core owns, rather than a second
 * hand-maintained transcription of it living in whichever backend has to send
 * it across.
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
import type { SqlExecutor, VFS } from '../types/primitives.js';
import { SOUL_PATH, summarizeSoul } from './soul.js';
import { CHAT_SESSION_ID, chatPaneAncestry, sessionTreeAncestry } from './session-tree.js';

/** One row of each table the copy reads. Everything is JSON-serializable, so a
 *  snapshot survives a transport that only carries structured clones. */
export interface ForkSnapshot {
  /** The source workspace's identity — the fork's lineage parent. */
  source: { workspaceId: string; workspaceName: string };
  /** The message the fork is cut at, and its timestamp. */
  cut: { messageId: string; createdAtMs: number };
  /** The cut message's ancestry, root first. `session_id` is not carried: the
   *  chain is by definition the chat session's, and the write stamps it. */
  messages: Array<{
    id: string; parent_id: string | null;
    role: string; content: string; created_at: number;
  }>;
  /** The same chain in the SDK's own store — the table the chat pane hydrates
   *  from, whose serialized UI messages `messages.content` cannot rebuild.
   *  `created_at` is a datetime string, carried verbatim. */
  assistantMessages: Array<{
    id: string; session_id: string; parent_id: string | null;
    role: string; content: string; created_at: string;
  }>;
  /** The files a fork inherits — SOUL.md and `memory/`, read through the
   *  workspace filesystem rather than lifted out of its tables, so a fork
   *  carries FILES and not one storage engine's row encoding. */
  files: Array<{ path: string; content: string }>;
  memoryChunks: Array<{
    id: string; path: string; start_line: number; end_line: number;
    hash: string; text: string; updated_at: number;
  }>;
  craftedTools: Array<{
    name: string; description: string; params: string | null; code: string;
    scope: string; created_at: number; updated_at: number;
  }>;
  agentConfig: Array<{ key: string; value: string }>;
}

export interface ForkOpts {
  /** Message id from source's `messages` table; the fork includes messages
   *  with created_at <= this message's created_at. Throws if not found. */
  untilMessageId: string;
  /** New target workspace's id (usually `ctx.id.toString()` on the fork DO). */
  targetWorkspaceId: string;
  /** New target workspace's human name. */
  targetWorkspaceName: string;
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
 * resolved against was a turn-end summary that had never recorded it.
 * `reconcileSessionTree` is what closed that gap; this cut assumes it has run.
 */
export async function snapshotWorkspaceForFork(
  source: SqlExecutor, sourceVfs: VFS, untilMessageId: string,
): Promise<ForkSnapshot> {
  const messages = sessionTreeAncestry(source, untilMessageId);
  if (messages.length === 0) {
    throw new Error(`fork point not found: message id "${untilMessageId}" does not exist in source`);
  }
  const forkPointMs = messages[messages.length - 1]!.created_at;

  const identity = source<{ id: string; name: string }>`
    SELECT id, name FROM workspace_identity LIMIT 1
  `;
  // The chat pane hydrates from the SDK's store, so a fork without these rows
  // shows an empty pane despite a populated `messages` table.
  const assistantMessages = chatPaneAncestry(source, untilMessageId);
  // The scaffold is deliberately excluded so the fork re-bootstraps v0 fresh.
  const files = await readForkFiles(sourceVfs);
  // The FTS content table (agent-utils MemoryStore), created for every
  // workspace by initWorkspaceSchema. A read failure here is a real fault and
  // must not be mistaken for a workspace that has indexed nothing.
  const memoryChunks = source<ForkSnapshot['memoryChunks'][number]>`
    SELECT id, path, start_line, end_line, hash, text, updated_at FROM memory_chunks
  `;
  const craftedTools = source<ForkSnapshot['craftedTools'][number]>`
    SELECT name, description, params, code, scope, created_at, updated_at FROM crafted_tools
  `;
  const agentConfig = source<ForkSnapshot['agentConfig'][number]>`SELECT key, value FROM agent_config`;

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

/**
 * Land a snapshot in the target workspace. Caller handles atomicity (wrap in
 * `ctx.storage.transactionSync` on CF; bun:sqlite exec each stmt in tests where
 * per-statement failure is acceptable).
 */
export async function writeForkSnapshot(
  target: SqlExecutor,
  targetVfs: VFS,
  snapshot: ForkSnapshot,
  opts: {
    workspaceId: string; workspaceName: string; now?: number;
    /** Hosted workspaces establish their owner before the external VFS copy;
     *  carry it through the identity rewrite so the row and file namespace
     *  cannot diverge. Local backends omit it. */
    ownerUserId?: string;
    /** Hosted workspaces use their owner-only filesystem writer for SOUL.md;
     *  every other inherited file remains an ordinary workspace write. */
    writeSoulFile?: (content: string) => Promise<void>;
    /**
     * Runs the ROW half atomically. Files are written outside it and cannot be
     * inside it: a host transaction is synchronous, and the filesystem is not —
     * it runs each write in a transaction of its own. Splitting them is what
     * that fact requires, and the split is safe because the file half is a set
     * of idempotent overwrites that a retry simply repeats.
     */
    transaction?: (rows: () => void) => void;
  },
): Promise<ForkResult> {
  const now = opts.now ?? Date.now();
  const forkPointMs = snapshot.cut.createdAtMs;

  // The files first, outside any transaction the caller is holding. They
  // overwrite whatever the target's own bootstrap seeded, which is also what
  // replaces the default SOUL.md.
  for (const f of snapshot.files) {
    const dir = f.path.slice(0, f.path.lastIndexOf('/'));
    if (dir) await targetVfs.mkdir(dir, { recursive: true });
    if (f.path === SOUL_PATH && opts.writeSoulFile) await opts.writeSoulFile(f.content);
    else await targetVfs.writeFile(f.path, f.content);
  }

  const rows = (): void => {
  // 1. Replace every copied row set. The target is reserved but not exposed
  //    until this operation succeeds, so a repeated delivery must converge on
  //    the same snapshot rather than duplicate conversation rows or retain a
  //    partial attempt.
  void target`DELETE FROM messages`;
  void target`DELETE FROM crafted_tools`;
  void target`DELETE FROM memory_chunks`;
  void target`DELETE FROM agent_config`;
  // assistant_messages is purged in step 4, after the CREATE that guarantees it.
  void target`DELETE FROM fork_lineage`;
  void target`DELETE FROM workspace_identity`;

  // 2. Rewrite workspace_identity — new id, new name, fresh created_at.
  if (opts.ownerUserId) {
    void target`
      INSERT INTO workspace_identity (id, name, owner_user_id, created_at)
      VALUES (${opts.workspaceId}, ${opts.workspaceName}, ${opts.ownerUserId}, ${now})
    `;
  } else {
    void target`
      INSERT INTO workspace_identity (id, name, created_at)
      VALUES (${opts.workspaceId}, ${opts.workspaceName}, ${now})
    `;
  }

  // 3. Messages, PKs and parent edges preserved — the chain IS the tree.
  for (const m of snapshot.messages) {
    void target`
      INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${m.id}, ${CHAT_SESSION_ID}, ${m.parent_id}, ${m.role}, ${m.content}, ${m.created_at})
    `;
  }

  // 4. assistant_messages. The agents SDK's session provider creates this table
  //    on its first append, so a target that has not run a turn does not have
  //    it yet — created here with the SDK's own definition (agents,
  //    src/experimental/memory/session/providers/agent.ts) so the copy cannot
  //    be skipped. Purged here rather than in step 1 for that reason.
  void target`
    CREATE TABLE IF NOT EXISTS assistant_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL DEFAULT '',
      parent_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;
  void target`CREATE INDEX IF NOT EXISTS idx_assistant_msg_parent  ON assistant_messages(parent_id)`;
  void target`CREATE INDEX IF NOT EXISTS idx_assistant_msg_session ON assistant_messages(session_id)`;
  void target`DELETE FROM assistant_messages`;
  for (const m of snapshot.assistantMessages) {
    void target`
      INSERT OR IGNORE INTO assistant_messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${m.id}, ${m.session_id}, ${m.parent_id}, ${m.role}, ${m.content}, ${m.created_at})
    `;
  }

  // 5. SOUL.md + memory/* are FILES and are written before this, outside the
  //    row transaction — see writeForkFiles at the top of this function.
  void target`UPDATE workspace_identity SET mission = ${
    summarizeSoul(snapshot.files.find((f) => f.path === SOUL_PATH)?.content ?? '')
  }`;

  // 6. memory_chunks — the table is part of every workspace's schema, so a
  //    failure here means the fork lost the parent's memory index, not that
  //    there was nothing to copy.
  for (const c of snapshot.memoryChunks) {
    void target`
      INSERT OR REPLACE INTO memory_chunks (id, path, start_line, end_line, hash, text, updated_at)
      VALUES (${c.id}, ${c.path}, ${c.start_line}, ${c.end_line}, ${c.hash}, ${c.text}, ${c.updated_at})
    `;
  }

  // 7. crafted_tools (snapshot — independent evolution from this point).
  for (const t of snapshot.craftedTools) {
    void target`
      INSERT OR REPLACE INTO crafted_tools
      (name, description, params, code, scope, created_at, updated_at)
      VALUES (${t.name}, ${t.description}, ${t.params}, ${t.code}, ${t.scope}, ${t.created_at}, ${t.updated_at})
    `;
  }

  // 8. agent_config, with display_name overwritten so the UI shows the fork.
  for (const row of snapshot.agentConfig) {
    void target`INSERT OR REPLACE INTO agent_config (key, value) VALUES (${row.key}, ${row.value})`;
  }
  void target`INSERT OR REPLACE INTO agent_config (key, value) VALUES ('display_name', ${opts.workspaceName})`;

  // 9. Lineage — single row.
  void target`
    INSERT INTO fork_lineage
    (id, source_workspace_id, source_workspace_name, source_message_id, source_message_created_at, forked_at)
    VALUES
    (1, ${snapshot.source.workspaceId}, ${snapshot.source.workspaceName},
     ${snapshot.cut.messageId}, ${forkPointMs}, ${now})
  `;

  // 10. The fork marker: one system-role message parented on the cut point, so
  //     the chat pane shows a visible boundary between inherited history and the
  //     fork's own future turns, and the next model turn reads it as part of the
  //     transcript it already reads. It is a node of the session tree and
  //     nothing else — there is no second copy anywhere, because a copy the
  //     model never reads is not context, it is a row.
  const syntheticText =
    `You were forked from workspace "${snapshot.source.workspaceName}" at message ${snapshot.cut.messageId} on `
    + `${new Date(now).toISOString()}. The conversation above happened before the fork. `
    + `Your current tool set and memory are authoritative; ignore any tools or context `
    + `referenced before the fork that you don't see in your active tool list.`;
  const markerId = `fork-marker-${opts.workspaceId.slice(0, 8)}-${now}`;
  // Parented on the cut point, so an ancestry walk from the marker reaches the
  // whole inherited chain and the marker is the fork's latest leaf.
  void target`
    INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
    VALUES (${markerId}, ${CHAT_SESSION_ID}, ${snapshot.cut.messageId}, ${'system'},
            ${syntheticText}, ${forkPointMs + 1})
  `;
  // Mirrored into the SDK's store only when the fork actually carried pane rows.
  // Seeding a lone marker into an otherwise-empty pane store would make that
  // store claim a tree it does not have, and an ancestry walk would stop at the
  // marker instead of falling through to the chain in `messages`.
  if (snapshot.assistantMessages.length > 0) {
    const markerContent = JSON.stringify({
      id: markerId,
      role: 'system',
      parts: [{ type: 'text', text: syntheticText }],
    });
    // The SDK's store stamps `YYYY-MM-DD HH:MM:SS`; write the same shape.
    const markerCreatedAt = new Date(forkPointMs + 1).toISOString().replace('T', ' ').slice(0, 19);
    void target`
      INSERT OR IGNORE INTO assistant_messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${markerId}, ${''}, ${snapshot.cut.messageId}, ${'system'}, ${markerContent}, ${markerCreatedAt})
    `;
  }
  };

  if (opts.transaction) opts.transaction(rows);
  else rows();

  return {
    forkPointMs,
    messagesCopied: snapshot.messages.length,
    craftedToolsCopied: snapshot.craftedTools.length,
  };
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
 * The files a fork inherits: SOUL.md, and everything under `memory/`.
 *
 * A directory walk rather than a table scan — the fork carries what the agent
 * can see, so a store that chunks or compresses differently cannot change what
 * a fork means.
 */
async function readForkFiles(vfs: VFS): Promise<ForkSnapshot['files']> {
  const out: ForkSnapshot['files'] = [];
  const readText = async (path: string): Promise<void> => {
    const content = v.parse(v.string(), await vfs.readFile(path, { encoding: 'utf8' }));
    out.push({ path, content });
  };
  if (await vfs.exists(SOUL_PATH)) await readText(SOUL_PATH);
  const walk = async (dir: string): Promise<void> => {
    for (const name of await vfs.readdir(dir)) {
      const full = `${dir}/${name}`;
      const st = await vfs.stat(full);
      if (st?.isDir) await walk(full);
      else if (st) await readText(full);
    }
  };
  if (await vfs.exists('memory')) await walk('memory');
  return out;
}
