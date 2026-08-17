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
import {
  forkWorkspaceStorage, readForkLineage, initAllTables, readSoul, writeSoul, sessionTreeAncestry,
} from '../src/index.js';
import type { RawSqlExec, SqlExecutor, VFS } from '../src/types/primitives.js';
import { makeSql, makeExecRaw, createWorkspaceBundle } from './helpers.js';

/** The SDK's own DDL, verbatim from `agents`' AgentSessionProvider.ensureTable.
 *  `created_at` is a whole-second DATETIME — the reason a fork cut cannot be a
 *  timestamp comparison. */
const SDK_SESSION_DDL = `CREATE TABLE IF NOT EXISTS assistant_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT '',
  parent_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`;

/** One in-memory workspace: the full production schema plus its filesystem. */
interface WorkspaceFixture {
  db: Database;
  sql: SqlExecutor;
  execRaw: RawSqlExec;
  vfs: VFS;
}

function fresh(): WorkspaceFixture {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initAllTables(execRaw);
  const vfs = createWorkspaceBundle(db).vfs;
  return { db, sql, execRaw, vfs };
}

/** Seed a source DB with identity, SOUL.md, N messages, and some crafted tools.
 *  A message with no explicit `parent_id` is linked to the previous one, which
 *  is what the SDK's session provider does (`parentId ?? latestLeaf`) — a
 *  transcript always has edges, and a seed without them is not a transcript. */
async function seedSource(
  { sql, execRaw, vfs }: WorkspaceFixture,
  opts: {
    identity: { id: string; name: string };
    purpose: string;
    messages: Array<{ id: string; role: string; content: string; parent_id?: string | null; created_at: number }>;
    craftedTools?: Array<{ name: string; description: string; code: string; scope: string; created_at: number; updated_at: number }>;
  },
) {
  void sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${opts.identity.id}, ${opts.identity.name}, ${100})`;
  await writeSoul(vfs, sql, opts.purpose);
  let previousId: string | null = null;
  for (const m of opts.messages) {
    const parent = m.parent_id !== undefined ? m.parent_id : previousId;
    void sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
        VALUES (${m.id}, ${'default'}, ${parent}, ${m.role}, ${m.content}, ${m.created_at})`;
    previousId = m.id;
  }
  for (const t of opts.craftedTools ?? []) {
    void sql`INSERT INTO crafted_tools (name, description, params, code, scope, created_at, updated_at)
        VALUES (${t.name}, ${t.description}, ${null}, ${t.code}, ${t.scope}, ${t.created_at}, ${t.updated_at})`;
  }
  // Ensure agent_config table exists (the CF backend creates it at runtime, not
  // in schema.ts). Tests need to exercise the optional-copy path without failing.
  execRaw(`CREATE TABLE IF NOT EXISTS agent_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  void sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES (${'model'}, ${'@cf/moonshotai/kimi-k2.6'})`;
  void sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES (${'display_name'}, ${opts.identity.name})`;
}

async function seedTargetBootstrap({ sql, execRaw, vfs }: WorkspaceFixture) {
  // Simulate what the fork DO's onStart path inserts: default SOUL.md + identity.
  // forkWorkspaceStorage should purge these before writing the real fork rows.
  void sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'TARGET-BOOTSTRAP-ID'}, ${'target-bootstrap'}, ${200})`;
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
      SELECT id, parent_id, role, content FROM messages
      WHERE role != 'system' ORDER BY created_at ASC
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
    void src.sql`INSERT INTO search_nodes (id, task, action, visits, value) VALUES (${'n1'}, ${'t'}, ${'a'}, ${3}, ${0.8})`;
    void src.sql`INSERT INTO evolution_events (type, message) VALUES (${'reflection'}, ${'done'})`;

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
    void src.sql`INSERT INTO craft_scores (tool_name, score, uses) VALUES (${'foo'}, ${0.9}, ${12})`;

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
    void b.sql`INSERT INTO messages (id, parent_id, role, content, created_at)
          VALUES (${'b3'}, ${'a2'}, ${'user'}, ${'in B'}, ${1200})`;
    void b.sql`INSERT INTO messages (id, parent_id, role, content, created_at)
          VALUES (${'b4'}, ${'b3'}, ${'assistant'}, ${'from B'}, ${1300})`;

    // Fork B → C
    await forkWorkspaceStorage(b.sql, b.vfs, c.sql, c.vfs, { untilMessageId: 'b4', targetWorkspaceId: 'C-ID', targetWorkspaceName: 'agent-C', now: 7000 });

    // C inherits b4's ancestry: a1, a2, b3, b4 (its own marker excluded).
    const cMsgs = c.sql<{ id: string }>`
      SELECT id FROM messages WHERE role != 'system' ORDER BY created_at ASC`;
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

  test('9. the cut resolves on edges, not on time — a whole-second clock cannot', async () => {
    // The SDK's store stamps `DATETIME DEFAULT CURRENT_TIMESTAMP`, so every
    // message of a turn can share one timestamp. `created_at <= T` therefore
    // could not say which side of the cut m2 and m3 were on; the edges can.
    const src = fresh();
    const tgt = fresh();
    await seedTargetBootstrap(tgt);
    await seedSource(src, {
      identity: { id: 'S', name: 's' }, purpose: 'p',
      messages: [
        { id: 'm1', role: 'user', content: 'a', created_at: 1000 },
        { id: 'm2', role: 'assistant', content: 'b', created_at: 1000 },
        { id: 'm3', role: 'user', content: 'c', created_at: 1000 },
      ],
    });

    await forkWorkspaceStorage(src.sql, src.vfs, tgt.sql, tgt.vfs, { untilMessageId: 'm2', targetWorkspaceId: 'T', targetWorkspaceName: 'f' });

    const ids = tgt.sql<{ id: string }>`
      SELECT id FROM messages WHERE role != 'system' ORDER BY created_at ASC, id ASC`.map(r => r.id);
    expect(ids).toEqual(['m1', 'm2']);
  });

  test('9b. a sibling branch is not inherited — only the cut point\'s ancestry', async () => {
    // Two children of m1: forking at one must not carry the other. A prefix cut
    // cannot express this at all, which is why the model had to change.
    const src = fresh();
    const tgt = fresh();
    await seedTargetBootstrap(tgt);
    await seedSource(src, {
      identity: { id: 'S', name: 's' }, purpose: 'p',
      messages: [
        { id: 'm1', role: 'user', content: 'root', created_at: 1000 },
        { id: 'left', role: 'assistant', content: 'take one', parent_id: 'm1', created_at: 1100 },
        { id: 'right', role: 'assistant', content: 'take two', parent_id: 'm1', created_at: 1100 },
      ],
    });

    await forkWorkspaceStorage(src.sql, src.vfs, tgt.sql, tgt.vfs, { untilMessageId: 'left', targetWorkspaceId: 'T', targetWorkspaceName: 'f' });

    const ids = tgt.sql<{ id: string }>`
      SELECT id FROM messages WHERE role != 'system' ORDER BY created_at ASC, id ASC`.map(r => r.id);
    expect(ids).toEqual(['m1', 'left']);
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

  test('11. the fork marker is a node of the fork\'s own tree, parented on the cut', async () => {
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

    const rows = tgt.sql<{ id: string; parent_id: string | null; role: string; created_at: number; content: string }>`
      SELECT id, parent_id, role, created_at, content FROM messages ORDER BY created_at ASC, id ASC
    `;
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant', 'system']);
    const marker = rows[2]!;
    expect(marker.parent_id).toBe('m2');
    expect(marker.created_at).toBe(1101);    // forkPointMs + 1
    expect(marker.content).toContain('forked from workspace');
    expect(marker.content).toContain('alpha');
    // The marker is the fork's leaf, so the whole inherited chain hangs off it.
    expect(sessionTreeAncestry(tgt.sql, marker.id).map((n) => n.id))
      .toEqual(['m1', 'm2', marker.id]);
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

  test('14. the pane rows a fork carries are the cut point\'s ancestry', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedTargetBootstrap(tgt);
    await seedSource(src, {
      identity: { id: 'S', name: 'src' }, purpose: 'p',
      messages: [
        { id: 'm1', role: 'user', content: 'hello', created_at: 1000 },
        { id: 'm2', role: 'assistant', content: 'hi', parent_id: 'm1', created_at: 1100 },
        { id: 'm3', role: 'user', content: 'after', parent_id: 'm2', created_at: 1200 },
      ],
    });
    src.execRaw(SDK_SESSION_DDL);
    // Both messages land in the SAME second, which is all the SDK's
    // `DATETIME DEFAULT CURRENT_TIMESTAMP` can record. The old cut compared
    // `strftime('%s', created_at) * 1000` against the fork point and so could
    // not tell m2 from m3; the ancestry can.
    for (const [id, parent, role, text] of [
      ['m1', null, 'user', 'hello'], ['m2', 'm1', 'assistant', 'hi'], ['m3', 'm2', 'user', 'after'],
    ] as const) {
      void src.sql`INSERT INTO assistant_messages (id, session_id, parent_id, role, content, created_at)
        VALUES (${id}, ${''}, ${parent}, ${role},
                ${JSON.stringify({ id, role, parts: [{ type: 'text', text }] })},
                ${'1970-01-01 00:00:01'})`;
    }

    await forkWorkspaceStorage(src.sql, src.vfs, tgt.sql, tgt.vfs, {
      untilMessageId: 'm2', targetWorkspaceId: 'T', targetWorkspaceName: 'forked',
    });

    const carried = tgt.sql<{ id: string; role: string; parent_id: string | null }>`
      SELECT id, role, parent_id FROM assistant_messages WHERE role != 'system' ORDER BY rowid
    `;
    expect(carried.map((r) => r.id)).toEqual(['m1', 'm2']);
    expect(carried[1]!.parent_id).toBe('m1');
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

  test('16. the fork marker reaches the pane store when the fork carried one', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedTargetBootstrap(tgt);
    await seedSource(src, {
      identity: { id: 'SRC', name: 'alpha' }, purpose: 'p',
      messages: [{ id: 'm1', role: 'user', content: 'hi', created_at: 1000 }],
    });
    src.execRaw(SDK_SESSION_DDL);
    void src.sql`INSERT INTO assistant_messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${'m1'}, ${''}, ${null}, ${'user'},
              ${JSON.stringify({ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] })},
              ${'1970-01-01 00:00:01'})`;

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
