/**
 * Workspace fork — the storage half, shared by every backend.
 *
 * Forks a source workspace's SQLite state into a target workspace's (a fork is
 * a NEW workspace by a new name). The semantics are "clean-slate messages-only":
 *
 *   Copy:   SOUL.md, messages+conversation_history (≤ forkPointMs),
 *           memory/* VFS rows + memory_chunks, crafted_tools, agent_config
 *   Reset:  search_nodes, scaffold_versions, task_history, craft_scores,
 *           fibers, evolution_events, executor_output, activity_log,
 *           scaffold/* VFS rows
 *   Rewrite: workspace_identity (new id/name/created_at)
 *   Insert: fork_lineage (single row)
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

import type { SqlExecutor } from '../types/primitives.js';
import { SOUL_PATH } from './soul.js';

/** One row of each table the copy reads. Everything is JSON-serializable, so a
 *  snapshot survives a transport that only carries structured clones. */
export interface ForkSnapshot {
  /** The source workspace's identity — the fork's lineage parent. */
  source: { workspaceId: string; workspaceName: string };
  /** The message the fork is cut at, and its timestamp. */
  cut: { messageId: string; createdAtMs: number };
  messages: Array<{
    id: string; session_id: string; parent_id: string | null;
    role: string; content: string; created_at: number;
  }>;
  conversationHistory: Array<{
    session_id: string; role: string; message: string; created_at: number;
  }>;
  /** Think/Session-owned rows — the table the chat UI actually hydrates from.
   *  `created_at` is a datetime string, carried verbatim. Already time-filtered
   *  by the snapshot, so the write inserts them all. */
  assistantMessages: Array<{
    id: string; session_id: string; parent_id: string | null;
    role: string; content: string; created_at: string;
  }>;
  vfsFiles: Array<{
    path: string; chunk_index: number; parent_path: string;
    data: unknown; is_dir: number; size: number; mtime: number;
  }>;
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
 * Throws if `untilMessageId` does not exist in the source's `messages` table —
 * the one failure worth surfacing before a target workspace is created.
 */
export function snapshotWorkspaceForFork(source: SqlExecutor, untilMessageId: string): ForkSnapshot {
  const hit = source<{ created_at: number }>`
    SELECT created_at FROM messages WHERE id = ${untilMessageId} AND session_id = 'default'
  `;
  if (hit.length === 0) {
    throw new Error(`fork point not found: message id "${untilMessageId}" does not exist in source`);
  }
  const forkPointMs = hit[0]!.created_at;

  const identity = source<{ id: string; name: string }>`
    SELECT id, name FROM workspace_identity LIMIT 1
  `;
  const messages = source<ForkSnapshot['messages'][number]>`
    SELECT id, session_id, parent_id, role, content, created_at
    FROM messages
    WHERE created_at <= ${forkPointMs} AND session_id = 'default'
    ORDER BY created_at ASC
  `;
  const conversationHistory = source<ForkSnapshot['conversationHistory'][number]>`
    SELECT session_id, role, message, created_at
    FROM conversation_history
    WHERE created_at <= ${forkPointMs} AND session_id = 'default'
    ORDER BY id ASC
  `;
  // Think's Session persists UIMessages here (via appendMessage) and the chat
  // UI hydrates from it, so a fork without these rows shows an empty pane
  // despite a populated `messages` table. Created lazily on first append, so a
  // source that never ran a turn has no such table. `parent_id` edges are
  // carried so getHistory()'s recursive CTE walks correctly.
  let assistantMessages: ForkSnapshot['assistantMessages'] = [];
  try {
    assistantMessages = source<ForkSnapshot['assistantMessages'][number]>`
      SELECT id, session_id, parent_id, role, content, created_at
      FROM assistant_messages
      WHERE strftime('%s', created_at) * 1000 <= ${forkPointMs}
      ORDER BY created_at ASC
    `;
  } catch { /* Session may never have appended — non-fatal */ }
  // Scaffold rows are deliberately excluded so the fork re-bootstraps v0 fresh.
  const vfsFiles = source<ForkSnapshot['vfsFiles'][number]>`
    SELECT path, chunk_index, parent_path, data, is_dir, size, mtime
    FROM vfs_files
    WHERE path = ${SOUL_PATH} OR path LIKE 'memory/%' OR (path = 'memory' AND is_dir = 1)
  `;
  // The FTS content table (agent-utils MemoryStore). Copying it is an
  // optimization — the text itself is in vfs_files/memory/*.md, so a missing
  // table just means the fork reindexes on next write.
  let memoryChunks: ForkSnapshot['memoryChunks'] = [];
  try {
    memoryChunks = source<ForkSnapshot['memoryChunks'][number]>`
      SELECT id, path, start_line, end_line, hash, text, updated_at FROM memory_chunks
    `;
  } catch { /* source has no memory_chunks yet — non-fatal */ }
  const craftedTools = source<ForkSnapshot['craftedTools'][number]>`
    SELECT name, description, params, code, scope, created_at, updated_at FROM crafted_tools
  `;
  let agentConfig: ForkSnapshot['agentConfig'] = [];
  try {
    agentConfig = source<ForkSnapshot['agentConfig'][number]>`SELECT key, value FROM agent_config`;
  } catch { /* agent_config may not exist in source — non-fatal */ }

  return {
    source: {
      workspaceId: identity[0]?.id ?? '',
      workspaceName: identity[0]?.name ?? '',
    },
    cut: { messageId: untilMessageId, createdAtMs: forkPointMs },
    messages,
    conversationHistory,
    assistantMessages,
    vfsFiles,
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
export function writeForkSnapshot(
  target: SqlExecutor,
  snapshot: ForkSnapshot,
  opts: { workspaceId: string; workspaceName: string; now?: number },
): ForkResult {
  const now = opts.now ?? Date.now();
  const forkPointMs = snapshot.cut.createdAtMs;

  // 1. Purge any default-bootstrap identity/SOUL.md rows the target's boot path
  //    may have inserted. This makes the write idempotent across retries.
  target`DELETE FROM workspace_identity`;
  target`DELETE FROM vfs_files WHERE path = ${SOUL_PATH}`;

  // 2. Rewrite workspace_identity — new id, new name, fresh created_at.
  target`
    INSERT INTO workspace_identity (id, name, created_at)
    VALUES (${opts.workspaceId}, ${opts.workspaceName}, ${now})
  `;

  // 3. Messages, PKs preserved.
  for (const m of snapshot.messages) {
    target`
      INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${m.id}, ${m.session_id}, ${m.parent_id}, ${m.role}, ${m.content}, ${m.created_at})
    `;
  }

  // 4. conversation_history. `id` is auto-increment so fresh rowids are fine.
  for (const c of snapshot.conversationHistory) {
    target`
      INSERT INTO conversation_history (session_id, role, message, created_at)
      VALUES (${c.session_id}, ${c.role}, ${c.message}, ${c.created_at})
    `;
  }

  // 5. assistant_messages. The table is created lazily by Session.ensureTable()
  //    on first append, so ensure it exists before inserting (idempotent).
  try {
    target`
      CREATE TABLE IF NOT EXISTS assistant_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL DEFAULT '',
        parent_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
    target`CREATE INDEX IF NOT EXISTS idx_assistant_msg_parent  ON assistant_messages(parent_id)`;
    target`CREATE INDEX IF NOT EXISTS idx_assistant_msg_session ON assistant_messages(session_id)`;
    for (const m of snapshot.assistantMessages) {
      target`
        INSERT OR IGNORE INTO assistant_messages (id, session_id, parent_id, role, content, created_at)
        VALUES (${m.id}, ${m.session_id}, ${m.parent_id}, ${m.role}, ${m.content}, ${m.created_at})
      `;
    }
  } catch { /* pure-test targets may lack the table — non-fatal */ }

  // 6. SOUL.md + memory/* VFS rows.
  for (const f of snapshot.vfsFiles) {
    target`
      INSERT OR REPLACE INTO vfs_files
      (path, chunk_index, parent_path, data, is_dir, size, mtime)
      VALUES
      (${f.path}, ${f.chunk_index}, ${f.parent_path}, ${f.data as never}, ${f.is_dir}, ${f.size}, ${f.mtime})
    `;
  }

  // 7. memory_chunks — skipped silently when the target has no such table yet.
  try {
    for (const c of snapshot.memoryChunks) {
      target`
        INSERT OR REPLACE INTO memory_chunks (id, path, start_line, end_line, hash, text, updated_at)
        VALUES (${c.id}, ${c.path}, ${c.start_line}, ${c.end_line}, ${c.hash}, ${c.text}, ${c.updated_at})
      `;
    }
  } catch { /* target has no memory_chunks yet — non-fatal */ }

  // 8. crafted_tools (snapshot — independent evolution from this point).
  for (const t of snapshot.craftedTools) {
    target`
      INSERT OR REPLACE INTO crafted_tools
      (name, description, params, code, scope, created_at, updated_at)
      VALUES (${t.name}, ${t.description}, ${t.params}, ${t.code}, ${t.scope}, ${t.created_at}, ${t.updated_at})
    `;
  }

  // 9. agent_config, with display_name overwritten so the UI shows the fork.
  try {
    for (const row of snapshot.agentConfig) {
      target`INSERT OR REPLACE INTO agent_config (key, value) VALUES (${row.key}, ${row.value})`;
    }
    target`INSERT OR REPLACE INTO agent_config (key, value) VALUES ('display_name', ${opts.workspaceName})`;
  } catch { /* agent_config may not exist in target — non-fatal */ }

  // 10. Lineage — single row.
  target`DELETE FROM fork_lineage WHERE id = 1`;
  target`
    INSERT INTO fork_lineage
    (id, source_workspace_id, source_workspace_name, source_message_id, source_message_created_at, forked_at)
    VALUES
    (1, ${snapshot.source.workspaceId}, ${snapshot.source.workspaceName},
     ${snapshot.cut.messageId}, ${forkPointMs}, ${now})
  `;

  // 11. Synthetic system-role message at the fork point. Two purposes:
  //     (a) LLM coherence — written to conversation_history so the next model
  //         turn sees the fork context and knows to ignore tools/state that
  //         existed before the fork and no longer exist.
  //     (b) UI surface — also written to assistant_messages so the chat pane
  //         shows a visible "Forked from …" marker between the copied history
  //         and the fork's own future turns.
  const syntheticText =
    `You were forked from workspace "${snapshot.source.workspaceName}" at message ${snapshot.cut.messageId} on `
    + `${new Date(now).toISOString()}. The conversation above happened before the fork. `
    + `Your current tool set and memory are authoritative; ignore any tools or context `
    + `referenced before the fork that you don't see in your active tool list.`;

  target`
    INSERT INTO conversation_history (session_id, role, message, created_at)
    VALUES ('default', 'system', ${JSON.stringify({ role: 'system', content: syntheticText })}, ${forkPointMs + 1})
  `;

  // Mirrored as a system-role UIMessage, parented on the cut-point message so
  // getHistory()'s recursive CTE walks marker → copied history → root.
  try {
    const syntheticId = `fork-marker-${opts.workspaceId.slice(0, 8)}-${now}`;
    const syntheticContent = JSON.stringify({
      id: syntheticId,
      role: 'system',
      parts: [{ type: 'text', text: syntheticText }],
    });
    // ISO8601 with ms, one ms after the cut point — guaranteed to be the latest
    // leaf in the fork's session tree.
    const syntheticCreatedAt = new Date(forkPointMs + 1).toISOString().replace('T', ' ').replace('Z', '');
    target`
      INSERT OR IGNORE INTO assistant_messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${syntheticId}, ${''}, ${snapshot.cut.messageId}, ${'system'}, ${syntheticContent}, ${syntheticCreatedAt})
    `;
  } catch { /* assistant_messages was already guarded above — non-fatal */ }

  return {
    forkPointMs,
    messagesCopied: snapshot.messages.length,
    craftedToolsCopied: snapshot.craftedTools.length,
  };
}

/** Read a source workspace and land it in a target, in one call — the shape a
 *  backend uses when both databases are open in the same process. */
export function forkWorkspaceStorage(
  source: SqlExecutor,
  target: SqlExecutor,
  opts: ForkOpts,
): ForkResult {
  return writeForkSnapshot(target, snapshotWorkspaceForFork(source, opts.untilMessageId), {
    workspaceId: opts.targetWorkspaceId,
    workspaceName: opts.targetWorkspaceName,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
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

/** Read the single-row fork_lineage. Returns null when not a fork. */
export function readForkLineage(sql: SqlExecutor): ForkLineageRow | null {
  try {
    const rows = sql<{
      source_workspace_id: string; source_workspace_name: string;
      source_message_id: string; source_message_created_at: number;
      forked_at: number;
    }>`SELECT source_workspace_id, source_workspace_name, source_message_id,
              source_message_created_at, forked_at
       FROM fork_lineage WHERE id = 1 LIMIT 1`;
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      sourceWorkspaceId: r.source_workspace_id,
      sourceWorkspaceName: r.source_workspace_name,
      sourceMessageId: r.source_message_id,
      sourceMessageCreatedAt: r.source_message_created_at,
      forkedAt: r.forked_at,
    };
  } catch {
    return null;
  }
}
