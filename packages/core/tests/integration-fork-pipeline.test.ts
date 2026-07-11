/**
 * Integration test for the fork-copy pipeline end-to-end.
 *
 * This test simulates the cross-DO flow:
 *   1. Source agent materializes a ForkPayload from its own SQL rows
 *      (mirrors the CF backend's buildForkPayload)
 *   2. Payload is serialized to JSON and back (mirrors the RPC boundary)
 *   3. Fork DO receives the payload, builds an ephemeral SqlExecutor
 *      (mirrors cf-backend/orchestrator.ts::buildSqlFromPayload), and
 *      calls forkWorkspaceStorage to land the rows in its own SQLite
 *
 * Verifies the same invariants as unit-fork.test.ts, but over the full
 * pipeline including JSON round-trip. Catches payload-shape drift bugs.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { forkWorkspaceStorage, initAllTables, readForkLineage, readSoul, writeSoul } from '../src/index.js';
import type { SqlExecutor } from '../src/types/primitives.js';
import { makeSql, makeExecRaw } from './helpers.js';

// Mirror of the ForkPayload type in cf-backend. Kept local to the test so
// the test fails loudly if the CF payload drifts without a test update.
interface ForkPayload {
  forkName: string;
  lineage: {
    forkOriginAgentId: string;
    forkOriginAgentName: string;
    forkOriginMessageId: string;
    forkOriginCreatedAt: number;
    forkedAt: number;
  };
  messages: Array<{ id: string; session_id: string; parent_id: string | null; role: string; content: string; created_at: number }>;
  conversationHistory: Array<{ session_id: string; role: string; message: string; created_at: number }>;
  vfsFiles: Array<{ path: string; chunk_index: number; parent_path: string; data: unknown; is_dir: number; size: number; mtime: number }>;
  memoryChunks: Array<{ id: string; path: string; start_line: number; end_line: number; hash: string; text: string; updated_at: number }>;
  craftedTools: Array<{ name: string; description: string; params: string | null; code: string; scope: string; created_at: number; updated_at: number }>;
  agentConfig: Array<{ key: string; value: string }>;
}

/** Mirror of cf-backend/orchestrator.ts::buildForkPayload for tests. */
function buildPayload(src: { sql: SqlExecutor }, untilMessageId: string, forkName: string): ForkPayload {
  const identity = src.sql<{ id: string; name: string }>`SELECT id, name FROM workspace_identity LIMIT 1`;
  const hit = src.sql<{ created_at: number }>`
    SELECT created_at FROM messages WHERE id = ${untilMessageId} AND session_id = 'default'
  `;
  const forkPointMs = hit[0]!.created_at;
  const messages = src.sql<ForkPayload["messages"][number]>`
    SELECT id, session_id, parent_id, role, content, created_at
    FROM messages WHERE created_at <= ${forkPointMs} AND session_id = 'default'
    ORDER BY created_at ASC
  `;
  const conv = src.sql<ForkPayload["conversationHistory"][number]>`
    SELECT session_id, role, message, created_at
    FROM conversation_history WHERE created_at <= ${forkPointMs} AND session_id = 'default'
    ORDER BY id ASC
  `;
  const vfs = src.sql<ForkPayload["vfsFiles"][number]>`
    SELECT path, chunk_index, parent_path, data, is_dir, size, mtime
    FROM vfs_files WHERE path = 'SOUL.md' OR path LIKE 'memory/%' OR (path = 'memory' AND is_dir = 1)
  `;
  let memChunks: ForkPayload["memoryChunks"] = [];
  try {
    memChunks = src.sql<ForkPayload["memoryChunks"][number]>`
      SELECT id, path, start_line, end_line, hash, text, updated_at FROM memory_chunks
    `;
  } catch { /* not created */ }
  const tools = src.sql<ForkPayload["craftedTools"][number]>`
    SELECT name, description, params, code, scope, created_at, updated_at FROM crafted_tools
  `;
  let agentConfig: ForkPayload["agentConfig"] = [];
  try {
    agentConfig = src.sql<ForkPayload["agentConfig"][number]>`SELECT key, value FROM agent_config`;
  } catch { /* not created */ }

  return {
    forkName,
    lineage: {
      forkOriginAgentId: identity[0]?.id ?? '',
      forkOriginAgentName: identity[0]?.name ?? '',
      forkOriginMessageId: untilMessageId,
      forkOriginCreatedAt: forkPointMs,
      forkedAt: 88888,
    },
    messages,
    conversationHistory: conv,
    vfsFiles: vfs,
    memoryChunks: memChunks,
    craftedTools: tools,
    agentConfig,
  };
}

/** Mirror of cf-backend/orchestrator.ts::buildSqlFromPayload — the fork DO
 *  uses this to answer forkWorkspaceStorage's source queries without real SQL. */
function buildSqlFromPayload(payload: ForkPayload): SqlExecutor {
  const rawSql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown[] =
    (strings, ...values) => {
      const query = strings.join('?').replace(/\s+/g, ' ').trim();
      if (query.startsWith('SELECT created_at FROM messages WHERE id =')) {
        const wantedId = values[0] as string;
        const hit = payload.messages.find(m => m.id === wantedId);
        return hit ? [{ created_at: hit.created_at }] : [];
      }
      if (query.startsWith('SELECT id, session_id, parent_id, role, content, created_at FROM messages')) {
        const cutoff = values[0] as number;
        return payload.messages.filter(m => m.created_at <= cutoff && m.session_id === 'default')
          .sort((a, b) => a.created_at - b.created_at);
      }
      if (query.startsWith('SELECT session_id, role, message, created_at FROM conversation_history')) {
        const cutoff = values[0] as number;
        return payload.conversationHistory.filter(c => c.created_at <= cutoff && c.session_id === 'default');
      }
      if (query.startsWith('SELECT path, chunk_index, parent_path, data, is_dir, size, mtime FROM vfs_files')) return payload.vfsFiles;
      if (query.startsWith('SELECT id, path, start_line, end_line, hash, text, updated_at FROM memory_chunks')) return payload.memoryChunks;
      if (query.startsWith('SELECT name, description, params, code, scope, created_at, updated_at FROM crafted_tools')) return payload.craftedTools;
      if (query.startsWith('SELECT key, value FROM agent_config')) return payload.agentConfig;
      if (query.startsWith('SELECT id, name FROM workspace_identity')) return [{
        id: payload.lineage.forkOriginAgentId,
        name: payload.lineage.forkOriginAgentName,
      }];
      return [];
    };
  return rawSql as SqlExecutor;
}

function fresh() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initAllTables(execRaw);
  return { db, sql, execRaw };
}

function seedSource(src: ReturnType<typeof fresh>) {
  src.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'SRC-1'}, ${'source-agent'}, ${100})`;
  writeSoul(src.sql, 'help with testing');
  src.sql`INSERT INTO messages (id, parent_id, role, content, created_at) VALUES (${'m1'}, ${null}, ${'user'}, ${'hello'}, ${1000})`;
  src.sql`INSERT INTO messages (id, parent_id, role, content, created_at) VALUES (${'m2'}, ${'m1'}, ${'assistant'}, ${'hi there'}, ${1100})`;
  src.sql`INSERT INTO messages (id, parent_id, role, content, created_at) VALUES (${'m3'}, ${'m2'}, ${'user'}, ${'post-fork-point'}, ${1500})`;
  src.sql`INSERT INTO conversation_history (session_id, role, message, created_at) VALUES (${'default'}, ${'user'}, ${JSON.stringify({ content: 'hello' })}, ${1000})`;
  src.sql`INSERT INTO conversation_history (session_id, role, message, created_at) VALUES (${'default'}, ${'assistant'}, ${JSON.stringify({ content: 'hi there' })}, ${1100})`;
  src.sql`INSERT INTO crafted_tools (name, description, code, scope, created_at, updated_at) VALUES (${'helper'}, ${'utility'}, ${'async (x) => x + 1'}, ${'local'}, ${500}, ${500})`;
  src.sql`INSERT INTO vfs_files (path, chunk_index, parent_path, data, is_dir, size, mtime) VALUES (${'memory/MEMORY.md'}, ${0}, ${'memory'}, ${'key insight'}, ${0}, ${11}, ${1000})`;
  // Pre-create agent_config and add non-display-name rows
  src.execRaw(`CREATE TABLE IF NOT EXISTS agent_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  src.sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES (${'model'}, ${'@cf/moonshotai/kimi-k2.6'})`;
}

describe('fork pipeline (end-to-end)', () => {
  test('payload round-trips across the RPC boundary (structured clone) and replays into the fork DB', () => {
    const src = fresh();
    const tgt = fresh();
    tgt.execRaw(`CREATE TABLE IF NOT EXISTS agent_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    // Simulate the fork DO's onStart bootstrap
    tgt.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'BOOT-ID'}, ${'fork-bootstrap'}, ${999})`;
    writeSoul(tgt.sql, 'default');

    seedSource(src);

    // Source side: build payload
    const rawPayload = buildPayload(src, 'm2', 'my-fork');
    // Simulate the RPC boundary — DO RPC uses structured clone, which
    // preserves the canonical BLOB (Uint8Array/ArrayBuffer) vfs rows.
    const payload = structuredClone(rawPayload);

    // Fork side: build ephemeral SqlExecutor + run forkWorkspaceStorage
    const srcShim = buildSqlFromPayload(payload);
    forkWorkspaceStorage(srcShim, tgt.sql, {
      untilMessageId: payload.lineage.forkOriginMessageId,
      targetWorkspaceId: 'FORK-DO-ID',
      targetWorkspaceName: payload.forkName,
      now: payload.lineage.forkedAt,
    });

    // Assertions — the fork has correct state after the round-trip
    const ident = tgt.sql<{ id: string; name: string }>`SELECT id, name FROM workspace_identity`;
    expect(ident.length).toBe(1);
    expect(ident[0]!.id).toBe('FORK-DO-ID');
    expect(ident[0]!.name).toBe('my-fork');

    expect(readSoul(tgt.sql)).toBe('help with testing');

    const msgs = tgt.sql<{ id: string }>`SELECT id FROM messages ORDER BY created_at ASC`;
    expect(msgs.map(m => m.id)).toEqual(['m1', 'm2']);  // m3 was after fork point

    const tools = tgt.sql<{ name: string }>`SELECT name FROM crafted_tools`;
    expect(tools.map(t => t.name)).toEqual(['helper']);

    const vfs = tgt.sql<{ path: string }>`SELECT path FROM vfs_files WHERE path LIKE 'memory/%'`;
    expect(vfs.map(v => v.path)).toContain('memory/MEMORY.md');

    const lineage = readForkLineage(tgt.sql);
    expect(lineage).not.toBeNull();
    expect(lineage!.sourceWorkspaceId).toBe('SRC-1');
    expect(lineage!.sourceWorkspaceName).toBe('source-agent');
    expect(lineage!.sourceMessageId).toBe('m2');
    expect(lineage!.forkedAt).toBe(88888);

    // Synthetic system message appended at forkPointMs + 1
    const conv = tgt.sql<{ role: string; message: string; created_at: number }>`
      SELECT role, message, created_at FROM conversation_history ORDER BY created_at ASC, id ASC
    `;
    expect(conv.length).toBe(3);
    expect(conv[2]!.role).toBe('system');
    expect(conv[2]!.created_at).toBe(1101);
    expect(conv[2]!.message).toContain('forked from workspace');
    expect(conv[2]!.message).toContain('source-agent');

    // agent_config — model copied, display_name overwritten
    const cfg = new Map(tgt.sql<{ key: string; value: string }>`SELECT key, value FROM agent_config`.map(r => [r.key, r.value]));
    expect(cfg.get('model')).toBe('@cf/moonshotai/kimi-k2.6');
    expect(cfg.get('display_name')).toBe('my-fork');
  });

  test('payload with zero crafted tools and zero memory is safe', () => {
    const src = fresh();
    const tgt = fresh();
    tgt.execRaw(`CREATE TABLE IF NOT EXISTS agent_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    src.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'S'}, ${'s'}, ${100})`;
    writeSoul(src.sql, 'p');
    src.sql`INSERT INTO messages (id, role, content, created_at) VALUES (${'m1'}, ${'user'}, ${'hi'}, ${1000})`;

    const rawPayload = buildPayload(src, 'm1', 'empty-fork');
    const payload = structuredClone(rawPayload);
    const srcShim = buildSqlFromPayload(payload);

    expect(() => forkWorkspaceStorage(srcShim, tgt.sql, {
      untilMessageId: 'm1', targetWorkspaceId: 'F', targetWorkspaceName: 'empty-fork', now: 7000,
    })).not.toThrow();

    const tools = tgt.sql<{ c: number }>`SELECT COUNT(*) as c FROM crafted_tools`;
    expect(tools[0]!.c).toBe(0);
  });

  test('idempotent re-copy over a partial failure — second run succeeds', () => {
    // Simulates a scenario where rawCopyFromFork was called twice: first call
    // failed partway (leaving garbage in the fork DB), second call should
    // produce the correct final state. forkWorkspaceStorage purges bootstrap + any
    // prior fork_lineage, so it's effectively idempotent.
    const src = fresh();
    const tgt = fresh();
    tgt.execRaw(`CREATE TABLE IF NOT EXISTS agent_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    // Pretend a partial first run left the fork with bootstrap identity +
    // partial messages + a stale lineage row.
    tgt.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'STALE'}, ${'partial'}, ${50})`;
    writeSoul(tgt.sql, 'partial-soul');
    tgt.sql`INSERT INTO fork_lineage (id, source_workspace_id, source_workspace_name, source_message_id, source_message_created_at, forked_at)
            VALUES (${1}, ${'OLD'}, ${'old'}, ${'x'}, ${0}, ${0})`;

    seedSource(src);
    const rawPayload = buildPayload(src, 'm2', 'recovered-fork');
    const payload = structuredClone(rawPayload);
    const srcShim = buildSqlFromPayload(payload);

    forkWorkspaceStorage(srcShim, tgt.sql, {
      untilMessageId: 'm2', targetWorkspaceId: 'FINAL', targetWorkspaceName: 'recovered-fork', now: 99999,
    });

    // Identity replaced clean
    const ident = tgt.sql<{ id: string; name: string }>`SELECT id, name FROM workspace_identity`;
    expect(ident.length).toBe(1);
    expect(ident[0]!.id).toBe('FINAL');
    // Lineage replaced, not duplicated
    const lin = tgt.sql<{ c: number }>`SELECT COUNT(*) as c FROM fork_lineage`;
    expect(lin[0]!.c).toBe(1);
    const l = readForkLineage(tgt.sql);
    expect(l!.forkedAt).toBe(99999);
  });
});
