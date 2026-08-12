/**
 * Unit tests for forkWorkspaceStorage — the storage-layer fork helper.
 * Backend-agnostic: drives two bun:sqlite handles in-memory.
 *
 * Schema parity: the canonical initAllTables() DDL from
 * packages/core/src/identity/schema.ts, and the production workspace
 * filesystem — a fork carries FILES, so the test forks real ones.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { forkWorkspaceStorage, readForkLineage, initAllTables, readSoul, writeSoul } from '../src/index.js';
import { makeSql, makeExecRaw, createWorkspaceBundle } from './helpers.js';

/** Build a fresh in-memory DB with the full production schema applied. */
function fresh() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initAllTables(execRaw);
  const vfs = createWorkspaceBundle(db).vfs;
  return { db, sql, execRaw, vfs };
}

/** Seed a source DB with identity, SOUL.md, N messages, and some crafted tools. */
async function seedSource(
  { sql, execRaw, vfs }: ReturnType<typeof fresh>,
  opts: {
    identity: { id: string; name: string };
    purpose: string;
    messages: Array<{ id: string; role: string; content: string; parent_id?: string | null; created_at: number }>;
    craftedTools?: Array<{ name: string; description: string; code: string; scope: string; created_at: number; updated_at: number }>;
  },
) {
  sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${opts.identity.id}, ${opts.identity.name}, ${100})`;
  await writeSoul(vfs, sql, opts.purpose);
  for (const m of opts.messages) {
    sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
        VALUES (${m.id}, ${'default'}, ${m.parent_id ?? null}, ${m.role}, ${m.content}, ${m.created_at})`;
    sql`INSERT INTO conversation_history (session_id, role, message, created_at)
        VALUES (${'default'}, ${m.role}, ${JSON.stringify({ role: m.role, content: m.content })}, ${m.created_at})`;
  }
  for (const t of opts.craftedTools ?? []) {
    sql`INSERT INTO crafted_tools (name, description, params, code, scope, created_at, updated_at)
        VALUES (${t.name}, ${t.description}, ${null}, ${t.code}, ${t.scope}, ${t.created_at}, ${t.updated_at})`;
  }
  // Ensure agent_config table exists (the CF backend creates it at runtime, not
  // in schema.ts). Tests need to exercise the optional-copy path without failing.
  execRaw(`CREATE TABLE IF NOT EXISTS agent_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES (${'model'}, ${'@cf/moonshotai/kimi-k2.6'})`;
  sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES (${'display_name'}, ${opts.identity.name})`;
}

async function seedTargetBootstrap({ sql, execRaw, vfs }: ReturnType<typeof fresh>) {
  // Simulate what the fork DO's onStart path inserts: default SOUL.md + identity.
  // forkWorkspaceStorage should purge these before writing the real fork rows.
  sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'TARGET-BOOTSTRAP-ID'}, ${'target-bootstrap'}, ${200})`;
  await writeSoul(vfs, sql, 'default bootstrap purpose');
  execRaw(`CREATE TABLE IF NOT EXISTS agent_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}

describe('forkWorkspaceStorage', () => {
  test('1. preserves messages 0..N with identical PKs and parent_ids', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedTargetBootstrap(tgt);
    await seedSource(src, {
      identity: { id: 'SRC-ID', name: 'source-agent' },
      purpose: 'original purpose',
      messages: [
        { id: 'msg-1', role: 'user', content: 'hi', parent_id: null, created_at: 1000 },
        { id: 'msg-2', role: 'assistant', content: 'hello', parent_id: 'msg-1', created_at: 1100 },
        { id: 'msg-3', role: 'user', content: 'second', parent_id: 'msg-2', created_at: 1200 },
        { id: 'msg-4', role: 'assistant', content: 'reply', parent_id: 'msg-3', created_at: 1300 },
        { id: 'msg-5', role: 'user', content: 'third', parent_id: 'msg-4', created_at: 1400 },
      ],
    });

    const result = await forkWorkspaceStorage(src.sql, src.vfs, tgt.sql, tgt.vfs, {
      untilMessageId: 'msg-3',
      targetWorkspaceId: 'TGT-ID',
      targetWorkspaceName: 'fork-agent',
      now: 5000,
    });

    expect(result.forkPointMs).toBe(1200);
    expect(result.messagesCopied).toBe(3);

    const targetMsgs = tgt.sql<{ id: string; parent_id: string | null; role: string; content: string }>`
      SELECT id, parent_id, role, content FROM messages ORDER BY created_at ASC
    `;
    expect(targetMsgs.length).toBe(3);
    expect(targetMsgs.map(m => m.id)).toEqual(['msg-1', 'msg-2', 'msg-3']);
    expect(targetMsgs[0]!.parent_id).toBeNull();
    expect(targetMsgs[1]!.parent_id).toBe('msg-1');
    expect(targetMsgs[2]!.parent_id).toBe('msg-2');
    expect(await readSoul(tgt.vfs)).toBe('original purpose');
  });

  test('2. copies crafted_tools verbatim', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedTargetBootstrap(tgt);
    await seedSource(src, {
      identity: { id: 'SRC', name: 'src' },
      purpose: 'p',
      messages: [{ id: 'm1', role: 'user', content: 'hi', created_at: 1000 }],
      craftedTools: [
        { name: 'doubleIt', description: 'doubles', code: 'async (n) => n * 2', scope: 'local', created_at: 500, updated_at: 500 },
        { name: 'tripleIt', description: 'triples', code: 'async (n) => n * 3', scope: 'local', created_at: 600, updated_at: 700 },
      ],
    });

    const res = await forkWorkspaceStorage(src.sql, src.vfs, tgt.sql, tgt.vfs, {
      untilMessageId: 'm1',
      targetWorkspaceId: 'T',
      targetWorkspaceName: 'fork',
    });

    expect(res.craftedToolsCopied).toBe(2);

    const copied = tgt.sql<{ name: string; description: string; code: string; scope: string; created_at: number; updated_at: number }>`
      SELECT name, description, code, scope, created_at, updated_at FROM crafted_tools ORDER BY name
    `;
    expect(copied.length).toBe(2);
    expect(copied[0]!.name).toBe('doubleIt');
    expect(copied[0]!.code).toBe('async (n) => n * 2');
    expect(copied[0]!.created_at).toBe(500);
    expect(copied[1]!.name).toBe('tripleIt');
    expect(copied[1]!.updated_at).toBe(700);
  });

  test('3. resets MCTS and evolution tables', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedTargetBootstrap(tgt);
    await seedSource(src, {
      identity: { id: 'S', name: 's' }, purpose: 'p',
      messages: [{ id: 'm1', role: 'user', content: 'hi', created_at: 1000 }],
    });
    src.sql`INSERT INTO search_nodes (id, task, action, visits, value) VALUES (${'n1'}, ${'t'}, ${'a'}, ${3}, ${0.8})`;
    src.sql`INSERT INTO evolution_events (type, message) VALUES (${'reflection'}, ${'done'})`;

    await forkWorkspaceStorage(src.sql, src.vfs, tgt.sql, tgt.vfs, { untilMessageId: 'm1', targetWorkspaceId: 'T', targetWorkspaceName: 'f' });

    const nodes = tgt.sql<{ c: number }>`SELECT COUNT(*) as c FROM search_nodes`;
    const events = tgt.sql<{ c: number }>`SELECT COUNT(*) as c FROM evolution_events`;
    expect(nodes[0]!.c).toBe(0);
    expect(events[0]!.c).toBe(0);
  });

  test('4. resets craft_scores (fork starts fresh EMA)', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedTargetBootstrap(tgt);
    await seedSource(src, {
      identity: { id: 'S', name: 's' }, purpose: 'p',
      messages: [{ id: 'm1', role: 'user', content: 'hi', created_at: 1000 }],
      craftedTools: [{ name: 'foo', description: 'x', code: '() => 1', scope: 'local', created_at: 500, updated_at: 500 }],
    });
    src.sql`INSERT INTO craft_scores (tool_name, score, uses) VALUES (${'foo'}, ${0.9}, ${12})`;

    await forkWorkspaceStorage(src.sql, src.vfs, tgt.sql, tgt.vfs, { untilMessageId: 'm1', targetWorkspaceId: 'T', targetWorkspaceName: 'f' });

    const scores = tgt.sql<{ c: number }>`SELECT COUNT(*) as c FROM craft_scores`;
    expect(scores[0]!.c).toBe(0);
    // But the tool itself IS copied
    const tools = tgt.sql<{ c: number }>`SELECT COUNT(*) as c FROM crafted_tools WHERE name = ${'foo'}`;
    expect(tools[0]!.c).toBe(1);
  });

  test('5. copies memory files but not the scaffold', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedTargetBootstrap(tgt);
    await seedSource(src, {
      identity: { id: 'S', name: 's' }, purpose: 'p',
      messages: [{ id: 'm1', role: 'user', content: 'hi', created_at: 1000 }],
    });
    await src.vfs.mkdir('memory', { recursive: true });
    await src.vfs.writeFile('memory/MEMORY.md', 'remembered');
    await src.vfs.mkdir('scaffold', { recursive: true });
    await src.vfs.writeFile('scaffold/agent.js', '// scaffold source');

    await forkWorkspaceStorage(src.sql, src.vfs, tgt.sql, tgt.vfs, { untilMessageId: 'm1', targetWorkspaceId: 'T', targetWorkspaceName: 'f' });

    // The memory the fork inherits, and the scaffold it deliberately does not:
    // a fork re-bootstraps v0 rather than carrying its parent's evolution.
    expect(await tgt.vfs.readFile('memory/MEMORY.md', { encoding: 'utf8' })).toBe('remembered');
    expect(await tgt.vfs.exists('scaffold/agent.js')).toBe(false);
  });

  test('6. writes fork_lineage row with correct fields', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedTargetBootstrap(tgt);
    await seedSource(src, {
      identity: { id: 'SRC-UUID-123', name: 'source-alpha' },
      purpose: 'p',
      messages: [{ id: 'msgX', role: 'user', content: 'hi', created_at: 1234 }],
    });

    await forkWorkspaceStorage(src.sql, src.vfs, tgt.sql, tgt.vfs, {
      untilMessageId: 'msgX',
      targetWorkspaceId: 'TGT', targetWorkspaceName: 'fork-beta', now: 9999,
    });

    const lineage = readForkLineage(tgt.sql);
    expect(lineage).not.toBeNull();
    expect(lineage!.sourceWorkspaceId).toBe('SRC-UUID-123');
    expect(lineage!.sourceWorkspaceName).toBe('source-alpha');
    expect(lineage!.sourceMessageId).toBe('msgX');
    expect(lineage!.sourceMessageCreatedAt).toBe(1234);
    expect(lineage!.forkedAt).toBe(9999);
  });

  test('7. fork of a fork — lineage points to immediate parent', async () => {
    const a = fresh();
    const b = fresh();
    const c = fresh();
    await seedTargetBootstrap(b);
    await seedTargetBootstrap(c);
    await seedSource(a, {
      identity: { id: 'A-ID', name: 'agent-A' }, purpose: 'p',
      messages: [
        { id: 'a1', role: 'user', content: 'in A', parent_id: null, created_at: 1000 },
        { id: 'a2', role: 'assistant', content: 'from A', parent_id: 'a1', created_at: 1100 },
      ],
    });

    // Fork A → B
    await forkWorkspaceStorage(a.sql, a.vfs, b.sql, b.vfs, { untilMessageId: 'a2', targetWorkspaceId: 'B-ID', targetWorkspaceName: 'agent-B', now: 5000 });
    // Add a turn in B to differentiate it
    b.sql`INSERT INTO messages (id, parent_id, role, content, created_at)
          VALUES (${'b3'}, ${'a2'}, ${'user'}, ${'in B'}, ${1200})`;
    b.sql`INSERT INTO messages (id, parent_id, role, content, created_at)
          VALUES (${'b4'}, ${'b3'}, ${'assistant'}, ${'from B'}, ${1300})`;

    // Fork B → C
    await forkWorkspaceStorage(b.sql, b.vfs, c.sql, c.vfs, { untilMessageId: 'b4', targetWorkspaceId: 'C-ID', targetWorkspaceName: 'agent-C', now: 7000 });

    // C has all 4 messages (a1, a2, b3, b4)
    const cMsgs = c.sql<{ id: string }>`SELECT id FROM messages ORDER BY created_at ASC`;
    expect(cMsgs.map(m => m.id)).toEqual(['a1', 'a2', 'b3', 'b4']);

    // C's lineage points to B (immediate parent), not A
    const lineage = readForkLineage(c.sql);
    expect(lineage!.sourceWorkspaceId).toBe('B-ID');
    expect(lineage!.sourceWorkspaceName).toBe('agent-B');
    expect(lineage!.sourceMessageId).toBe('b4');
  });

  test('8. unknown untilMessageId throws "fork point not found"', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedTargetBootstrap(tgt);
    await seedSource(src, {
      identity: { id: 'S', name: 's' }, purpose: 'p',
      messages: [{ id: 'm1', role: 'user', content: 'hi', created_at: 1000 }],
    });

    await expect(forkWorkspaceStorage(src.sql, src.vfs, tgt.sql, tgt.vfs, {
      untilMessageId: 'does-not-exist', targetWorkspaceId: 'T', targetWorkspaceName: 'f',
    })).rejects.toThrow('fork point not found');
  });

  test('9. forkPointMs is inclusive (messages at created_at == T are copied)', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedTargetBootstrap(tgt);
    await seedSource(src, {
      identity: { id: 'S', name: 's' }, purpose: 'p',
      messages: [
        { id: 'm1', role: 'user', content: 'a', created_at: 1000 },
        { id: 'm2', role: 'assistant', content: 'b', created_at: 1000 },  // same ts
        { id: 'm3', role: 'user', content: 'c', created_at: 1001 },       // just after
      ],
    });

    await forkWorkspaceStorage(src.sql, src.vfs, tgt.sql, tgt.vfs, { untilMessageId: 'm2', targetWorkspaceId: 'T', targetWorkspaceName: 'f' });

    const ids = tgt.sql<{ id: string }>`SELECT id FROM messages ORDER BY created_at ASC, id ASC`.map(r => r.id);
    expect(ids).toContain('m1');
    expect(ids).toContain('m2');  // same ts as the fork point — included
    expect(ids).not.toContain('m3');
  });

  test('10. workspace_identity rewritten with new UUID + name + fresh created_at', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedTargetBootstrap(tgt);
    await seedSource(src, {
      identity: { id: 'SRC-UUID', name: 'src-name' }, purpose: 'p',
      messages: [{ id: 'm1', role: 'user', content: 'hi', created_at: 1000 }],
    });

    await forkWorkspaceStorage(src.sql, src.vfs, tgt.sql, tgt.vfs, {
      untilMessageId: 'm1', targetWorkspaceId: 'NEW-UUID', targetWorkspaceName: 'fork-name', now: 7777,
    });

    const ident = tgt.sql<{ id: string; name: string; created_at: number }>`
      SELECT id, name, created_at FROM workspace_identity
    `;
    expect(ident.length).toBe(1);
    expect(ident[0]!.id).toBe('NEW-UUID');
    expect(ident[0]!.name).toBe('fork-name');
    expect(ident[0]!.created_at).toBe(7777);
    expect(ident[0]!.id).not.toBe('SRC-UUID');
    expect(ident[0]!.id).not.toBe('TARGET-BOOTSTRAP-ID');   // bootstrap row was purged
  });

  test('11. synthetic fork-notice system message appended to conversation_history', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedTargetBootstrap(tgt);
    await seedSource(src, {
      identity: { id: 'S', name: 'alpha' }, purpose: 'p',
      messages: [
        { id: 'm1', role: 'user', content: 'hi', created_at: 1000 },
        { id: 'm2', role: 'assistant', content: 'hi back', created_at: 1100 },
      ],
    });

    await forkWorkspaceStorage(src.sql, src.vfs, tgt.sql, tgt.vfs, { untilMessageId: 'm2', targetWorkspaceId: 'T', targetWorkspaceName: 'beta', now: 5000 });

    // Post-fork conversation_history has 3 rows: 2 copied + 1 synthetic system
    const rows = tgt.sql<{ role: string; created_at: number; message: string }>`
      SELECT role, created_at, message FROM conversation_history ORDER BY created_at ASC, id ASC
    `;
    expect(rows.length).toBe(3);
    expect(rows[2]!.role).toBe('system');
    expect(rows[2]!.created_at).toBe(1101);    // forkPointMs + 1
    expect(rows[2]!.message).toContain('forked from workspace');
    expect(rows[2]!.message).toContain('alpha');
  });

  test('12. agent_config copied but display_name overwritten', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedTargetBootstrap(tgt);
    await seedSource(src, {
      identity: { id: 'S', name: 'src' }, purpose: 'p',
      messages: [{ id: 'm1', role: 'user', content: 'hi', created_at: 1000 }],
    });

    await forkWorkspaceStorage(src.sql, src.vfs, tgt.sql, tgt.vfs, { untilMessageId: 'm1', targetWorkspaceId: 'T', targetWorkspaceName: 'forked-display' });

    const cfg = tgt.sql<{ key: string; value: string }>`
      SELECT key, value FROM agent_config ORDER BY key
    `;
    const map = new Map(cfg.map(r => [r.key, r.value]));
    expect(map.get('model')).toBe('@cf/moonshotai/kimi-k2.6');
    expect(map.get('display_name')).toBe('forked-display');
    // Source's display_name was 'src' — the fork rewrites it
    expect(map.get('display_name')).not.toBe('src');
  });

  test('13. readForkLineage returns null for non-forked agents', async () => {
    const { sql } = fresh();
    expect(readForkLineage(sql)).toBeNull();
  });

  test('14. assistant_messages (Think Session table) carried to fork', async () => {
    // Populate the Session-owned table on the source and verify the fork
    // hydrates its chat UI from the same rows.
    const src = fresh();
    const tgt = fresh();
    await seedTargetBootstrap(tgt);
    await seedSource(src, {
      identity: { id: 'S', name: 'src' }, purpose: 'p',
      messages: [
        { id: 'm1', role: 'user', content: 'hello', created_at: 1000 },
        { id: 'm2', role: 'assistant', content: 'hi', parent_id: 'm1', created_at: 1100 },
      ],
    });
    // Session's schema as created by appendMessage's ensureTable. Timestamps
    // stored as DATETIME strings; the helper uses strftime to compare.
    src.execRaw(`
      CREATE TABLE IF NOT EXISTS assistant_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL DEFAULT '',
        parent_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // 1000ms → 1970-01-01T00:00:01.000Z; 1100ms → 1970-01-01T00:00:01.100Z.
    // strftime('%s', ...) yields seconds → *1000 gives 1000 and 1000 (rounds
    // down). We use a clearly-separated second to avoid truncation.
    src.sql`INSERT INTO assistant_messages (id, session_id, parent_id, role, content, created_at)
      VALUES ('m1', '', NULL, 'user',
              ${JSON.stringify({ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] })},
              '1970-01-01 00:00:01.000')`;
    src.sql`INSERT INTO assistant_messages (id, session_id, parent_id, role, content, created_at)
      VALUES ('m2', '', 'm1', 'assistant',
              ${JSON.stringify({ id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] })},
              '1970-01-01 00:00:02.000')`;

    await forkWorkspaceStorage(src.sql, src.vfs, tgt.sql, tgt.vfs, {
      untilMessageId: 'm2',    // forkPointMs = 1100
      targetWorkspaceId: 'T', targetWorkspaceName: 'forked',
    });

    // Only m1 (at second=1, strftime returns 1s → 1000ms ≤ 1100ms) is copied.
    // m2 is at second=2 → 2000ms > 1100ms, excluded by the cut point.
    // Step 12 also writes a system-role synthetic marker — we assert on the
    // copied user-role row here; test 16 covers the synthetic marker.
    const userRows = tgt.sql<{ id: string; role: string; content: string; parent_id: string | null }>`
      SELECT id, role, content, parent_id FROM assistant_messages WHERE role = 'user'
    `;
    expect(userRows.length).toBe(1);
    expect(userRows[0]!.id).toBe('m1');
    expect(userRows[0]!.parent_id).toBeNull();
    expect(userRows[0]!.content).toContain('hello');
  });

  test('15. assistant_messages copy is no-op when source has no such table', async () => {
    // Pure-test source DBs never call into Session so this table is missing.
    // Helper must not throw in that case.
    const src = fresh();
    const tgt = fresh();
    await seedTargetBootstrap(tgt);
    await seedSource(src, {
      identity: { id: 'S', name: 'src' }, purpose: 'p',
      messages: [{ id: 'm1', role: 'user', content: 'hi', created_at: 1000 }],
    });
    await expect(forkWorkspaceStorage(src.sql, src.vfs, tgt.sql, tgt.vfs, {
      untilMessageId: 'm1', targetWorkspaceId: 'T', targetWorkspaceName: 'forked',
    })).resolves.toBeDefined();
  });

  test('16. synthetic fork marker written to assistant_messages for UI visibility', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedTargetBootstrap(tgt);
    await seedSource(src, {
      identity: { id: 'SRC', name: 'alpha' }, purpose: 'p',
      messages: [{ id: 'm1', role: 'user', content: 'hi', created_at: 1000 }],
    });
    await forkWorkspaceStorage(src.sql, src.vfs, tgt.sql, tgt.vfs, {
      untilMessageId: 'm1', targetWorkspaceId: 'T', targetWorkspaceName: 'beta',
    });

    // The synthetic marker should land in assistant_messages with role=system,
    // parented on the cut-point message, content referencing the source.
    const rows = tgt.sql<{ id: string; role: string; content: string; parent_id: string | null }>`
      SELECT id, role, content, parent_id FROM assistant_messages WHERE role = 'system'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.role).toBe('system');
    expect(rows[0]!.parent_id).toBe('m1');
    expect(rows[0]!.content).toContain('forked from');
    expect(rows[0]!.content).toContain('alpha');
    expect(rows[0]!.content).toContain('m1');
  });
});
