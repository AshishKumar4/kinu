/**
 * Agent fork — storage-layer helper shared by CF and CLI backends.
 *
 * Forks a source agent's SQLite state into a target agent's SQLite state.
 * The fork semantics are "clean-slate messages-only" (per plan doc §6):
 *
 *   Copy:   agent_soul, messages+conversation_history (≤ forkPointMs),
 *           memory/* VFS rows + memory_chunks, crafted_tools, agent_config
 *   Reset:  search_nodes, scaffold_versions, task_history, craft_scores,
 *           fibers, evolution_events, executor_output, activity_log,
 *           scaffold/* VFS rows
 *   Rewrite: agent_identity (new id/name/created_at)
 *   Insert: fork_lineage (single row)
 *
 * The target DB MUST already have been initialized via initAllTables() — the
 * caller is responsible for that (typically via Think's onStart path, which
 * auto-bootstraps a default soul/identity that this helper then overwrites).
 *
 * This helper is backend-agnostic: it uses only SqlExecutor tagged-template
 * queries, no DO-specific APIs. The CF backend drives it from inside a
 * transactionSync() for atomicity; tests drive it directly against two
 * bun:sqlite handles.
 *
 * Formal spec + rationale: docs/THINK-UPGRADE-AND-FORKING.md §6.
 */

import type { SqlExecutor } from '../types/primitives.js';

export interface ForkOpts {
  /** Message id from source's `messages` table; the fork includes messages
   *  with created_at <= this message's created_at. Throws if not found. */
  untilMessageId: string;
  /** New target agent's id (usually `ctx.id.toString()` on the fork DO). */
  targetAgentId: string;
  /** New target agent's human name. */
  targetAgentName: string;
  /** Optional clock override for tests. Defaults to Date.now(). */
  now?: number;
}

export interface ForkResult {
  forkPointMs: number;
  messagesCopied: number;
  craftedToolsCopied: number;
}

/**
 * Copy selected rows from `source` into `target`. Caller handles atomicity
 * (wrap in `ctx.storage.transactionSync` on CF; bun:sqlite exec each stmt
 * in tests where per-statement failure is acceptable).
 *
 * Throws if `untilMessageId` does not exist in source's `messages` table.
 */
export function forkAgentStorage(
  source: SqlExecutor,
  target: SqlExecutor,
  opts: ForkOpts,
): ForkResult {
  const now = opts.now ?? Date.now();

  // 1. Resolve the fork cut point.
  const hit = source<{ created_at: number }>`
    SELECT created_at FROM messages WHERE id = ${opts.untilMessageId} AND session_id = 'default'
  `;
  if (hit.length === 0) {
    throw new Error(`fork point not found: message id "${opts.untilMessageId}" does not exist in source`);
  }
  const forkPointMs = hit[0]!.created_at;

  // 2. Purge any default-bootstrap soul/identity rows the target's onStart
  //    may have inserted. This makes the helper idempotent across retries.
  target`DELETE FROM agent_soul`;
  target`DELETE FROM agent_identity`;

  // 3. Rewrite agent_identity — new id, new name, fresh created_at.
  target`
    INSERT INTO agent_identity (id, name, created_at)
    VALUES (${opts.targetAgentId}, ${opts.targetAgentName}, ${now})
  `;

  // 4. Copy agent_soul verbatim.
  const soul = source<{ purpose: string; created_at: number }>`
    SELECT purpose, created_at FROM agent_soul LIMIT 1
  `;
  if (soul.length > 0) {
    target`
      INSERT INTO agent_soul (purpose, created_at)
      VALUES (${soul[0]!.purpose}, ${soul[0]!.created_at})
    `;
  }

  // 5. Copy messages <= forkPointMs, preserving PKs.
  const msgs = source<{
    id: string; session_id: string; parent_id: string | null;
    role: string; content: string; created_at: number;
  }>`
    SELECT id, session_id, parent_id, role, content, created_at
    FROM messages
    WHERE created_at <= ${forkPointMs} AND session_id = 'default'
    ORDER BY created_at ASC
  `;
  for (const m of msgs) {
    target`
      INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${m.id}, ${m.session_id}, ${m.parent_id}, ${m.role}, ${m.content}, ${m.created_at})
    `;
  }

  // 6. Copy conversation_history <= forkPointMs. `id` is auto-increment so
  //    fresh rowids are fine; role/message/created_at preserved.
  const conv = source<{ session_id: string; role: string; message: string; created_at: number }>`
    SELECT session_id, role, message, created_at
    FROM conversation_history
    WHERE created_at <= ${forkPointMs} AND session_id = 'default'
    ORDER BY id ASC
  `;
  for (const c of conv) {
    target`
      INSERT INTO conversation_history (session_id, role, message, created_at)
      VALUES (${c.session_id}, ${c.role}, ${c.message}, ${c.created_at})
    `;
  }

  // 7. Copy memory/* VFS rows. Scaffold rows are intentionally excluded so
  //    the fork's onStart re-bootstraps v0 scaffold fresh.
  const vfs = source<{
    path: string; chunk_index: number; parent_path: string; data: unknown;
    is_dir: number; size: number; mtime: number;
  }>`
    SELECT path, chunk_index, parent_path, data, is_dir, size, mtime
    FROM vfs_files
    WHERE path LIKE 'memory/%' OR (path = 'memory' AND is_dir = 1)
  `;
  for (const f of vfs) {
    target`
      INSERT OR REPLACE INTO vfs_files
      (path, chunk_index, parent_path, data, is_dir, size, mtime)
      VALUES
      (${f.path}, ${f.chunk_index}, ${f.parent_path}, ${f.data as never}, ${f.is_dir}, ${f.size}, ${f.mtime})
    `;
  }

  // 8. Copy memory_chunks (FTS content table). Schema is owned by MemoryStore
  //    in agent-utils — if the target hasn't called ensureSchema() yet, we
  //    skip silently (the copy is an optimization; the text itself lives in
  //    vfs_files/memory/*.md already, so reindexing on next write will rebuild).
  try {
    const chunks = source<{
      id: string; path: string; start_line: number; end_line: number;
      hash: string; text: string; updated_at: number;
    }>`
      SELECT id, path, start_line, end_line, hash, text, updated_at FROM memory_chunks
    `;
    for (const c of chunks) {
      target`
        INSERT OR REPLACE INTO memory_chunks (id, path, start_line, end_line, hash, text, updated_at)
        VALUES (${c.id}, ${c.path}, ${c.start_line}, ${c.end_line}, ${c.hash}, ${c.text}, ${c.updated_at})
      `;
    }
  } catch { /* target has no memory_chunks yet — non-fatal */ }

  // 9. Copy crafted_tools (snapshot — independent evolution from this point).
  const tools = source<{
    name: string; description: string; params: string | null; code: string;
    scope: string; created_at: number; updated_at: number;
  }>`
    SELECT name, description, params, code, scope, created_at, updated_at FROM crafted_tools
  `;
  for (const t of tools) {
    target`
      INSERT OR REPLACE INTO crafted_tools
      (name, description, params, code, scope, created_at, updated_at)
      VALUES (${t.name}, ${t.description}, ${t.params}, ${t.code}, ${t.scope}, ${t.created_at}, ${t.updated_at})
    `;
  }

  // 10. Copy agent_config (model preference, MCTS knobs, etc). Overwrite
  //     display_name with the fork's name so the UI shows the fork identity.
  try {
    const cfg = source<{ key: string; value: string }>`
      SELECT key, value FROM agent_config
    `;
    for (const row of cfg) {
      target`INSERT OR REPLACE INTO agent_config (key, value) VALUES (${row.key}, ${row.value})`;
    }
    target`INSERT OR REPLACE INTO agent_config (key, value) VALUES ('display_name', ${opts.targetAgentName})`;
  } catch { /* agent_config may not exist in source — non-fatal */ }

  // 11. Lineage — single row.
  const srcIdent = source<{ id: string; name: string }>`
    SELECT id, name FROM agent_identity LIMIT 1
  `;
  const srcId = srcIdent[0]?.id ?? '';
  const srcName = srcIdent[0]?.name ?? '';
  target`DELETE FROM fork_lineage WHERE id = 1`;
  target`
    INSERT INTO fork_lineage
    (id, source_agent_id, source_agent_name, source_message_id, source_message_created_at, forked_at)
    VALUES
    (1, ${srcId}, ${srcName}, ${opts.untilMessageId}, ${forkPointMs}, ${now})
  `;

  // 12. Synthetic system-role row at conversation_history to notify the LLM
  //     of the fork. Keeps model behavior coherent after fork despite the
  //     clean-slate MCTS/evolution state.
  const syntheticMessage = JSON.stringify({
    role: 'system',
    content:
      `You were forked from agent "${srcName}" at message ${opts.untilMessageId} on ` +
      `${new Date(now).toISOString()}. The conversation above happened before the fork. ` +
      `Your current tool set and memory are authoritative; ignore any tools or context ` +
      `referenced before the fork that you don't see in your active tool list.`,
  });
  target`
    INSERT INTO conversation_history (session_id, role, message, created_at)
    VALUES ('default', 'system', ${syntheticMessage}, ${forkPointMs + 1})
  `;

  return {
    forkPointMs,
    messagesCopied: msgs.length,
    craftedToolsCopied: tools.length,
  };
}

/** Shape of what getForkLineage returns (null when not a fork). */
export interface ForkLineageRow {
  sourceAgentId: string;
  sourceAgentName: string;
  sourceMessageId: string;
  sourceMessageCreatedAt: number;
  forkedAt: number;
}

/** Read the single-row fork_lineage. Returns null when not a fork. */
export function readForkLineage(sql: SqlExecutor): ForkLineageRow | null {
  try {
    const rows = sql<{
      source_agent_id: string; source_agent_name: string;
      source_message_id: string; source_message_created_at: number;
      forked_at: number;
    }>`SELECT source_agent_id, source_agent_name, source_message_id,
              source_message_created_at, forked_at
       FROM fork_lineage WHERE id = 1 LIMIT 1`;
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      sourceAgentId: r.source_agent_id,
      sourceAgentName: r.source_agent_name,
      sourceMessageId: r.source_message_id,
      sourceMessageCreatedAt: r.source_message_created_at,
      forkedAt: r.forked_at,
    };
  } catch {
    return null;
  }
}
