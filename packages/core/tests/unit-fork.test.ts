/**
 * Unit tests for forkWorkspaceStorage — the storage-layer fork helper.
 * Backend-agnostic: drives two bun:sqlite handles in-memory.
 *
 * Schema parity: the canonical initAllTables() DDL from
 * packages/core/src/identity/schema.ts, and the production workspace
 * filesystem — a fork carries FILES, so the test forks real ones.
 */

import { describe, test, expect } from 'bun:test';
import {
  forkWorkspaceStorage, readForkLineage, readSoul, writeSoul, sessionTreeAncestry,
  snapshotWorkspaceForFork, writeForkSnapshot,
} from '../src/index';
import { createTestWorkspace as fresh, SDK_SESSION_DDL, type TestWorkspace } from './helpers';

/** Seed a source DB with identity, SOUL.md, N messages, and some crafted tools.
 *  A message with no explicit `parent_id` is linked to the previous one, which
 *  is what the SDK's session provider does (`parentId ?? latestLeaf`) — a
 *  transcript always has edges, and a seed without them is not a transcript. */
async function seedSource(
  { sql, vfs }: TestWorkspace,
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
  void sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES (${'model'}, ${'@cf/moonshotai/kimi-k2.6'})`;
  void sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES (${'display_name'}, ${opts.identity.name})`;
}

async function seedTargetBootstrap({ sql, vfs }: TestWorkspace) {
  // Simulate what the fork DO's onStart path inserts: default SOUL.md + identity.
  // forkWorkspaceStorage should purge these before writing the real fork rows.
  void sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'TARGET-BOOTSTRAP-ID'}, ${'target-bootstrap'}, ${200})`;
  await writeSoul(vfs, sql, 'default bootstrap purpose');
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

  test('15. assistant_messages copy is skipped when the source has no such table', async () => {
    // The agents SDK creates it on first append, so a source that never ran a
    // turn has none. Asked as a question (tableExists), not discovered by
    // catching — so this stays a no-op while a real query fault still throws.
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

  test('17. a fork that cannot copy assistant_messages FAILS instead of losing them', async () => {
    // A target carrying an older Session schema (no session_id) rejects the
    // insert. This used to be swallowed together with the CREATE that preceded
    // it, so the fork reported success with an empty chat pane — the owner's
    // messages silently gone. The copy must be all-or-nothing and loud.
    const src = fresh();
    const tgt = fresh();
    await seedTargetBootstrap(tgt);
    await seedSource(src, {
      identity: { id: 'S', name: 'src' }, purpose: 'p',
      messages: [{ id: 'm1', role: 'user', content: 'hi', created_at: 1000 }],
    });
    src.execRaw(`CREATE TABLE assistant_messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT '', parent_id TEXT,
      role TEXT NOT NULL, content TEXT NOT NULL, created_at DATETIME
    )`);
    void src.sql`INSERT INTO assistant_messages (id, session_id, parent_id, role, content, created_at)
      VALUES ('m1', '', NULL, 'user', ${JSON.stringify({ id: 'm1', role: 'user', parts: [] })}, '1970-01-01 00:00:01.000')`;
    tgt.execRaw(`CREATE TABLE assistant_messages (
      id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, created_at DATETIME
    )`);

    await expect(forkWorkspaceStorage(src.sql, src.vfs, tgt.sql, tgt.vfs, {
      untilMessageId: 'm1', targetWorkspaceId: 'T', targetWorkspaceName: 'forked',
    })).rejects.toThrow(/no such column/);
  });

  test('18. a fork that cannot copy memory_chunks FAILS instead of dropping the memory index', async () => {
    // A target holding the pre-FTS 3-column table rejects the 7-column insert.
    // Swallowed, the fork came up with the parent's memory silently absent and
    // reported "found nothing" rather than "I could not read it".
    const src = fresh();
    const tgt = fresh();
    await seedTargetBootstrap(tgt);
    await seedSource(src, {
      identity: { id: 'S', name: 'src' }, purpose: 'p',
      messages: [{ id: 'm1', role: 'user', content: 'hi', created_at: 1000 }],
    });
    void src.sql`INSERT INTO memory_chunks (id, path, start_line, end_line, hash, text, updated_at)
      VALUES ('c1', 'memory/MEMORY.md', 1, 4, 'h', 'key insight', 10)`;
    tgt.execRaw('DROP TABLE memory_chunks_fts');
    tgt.execRaw('DROP TABLE memory_chunks');
    tgt.execRaw('CREATE TABLE memory_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, content TEXT NOT NULL)');

    await expect(forkWorkspaceStorage(src.sql, src.vfs, tgt.sql, tgt.vfs, {
      untilMessageId: 'm1', targetWorkspaceId: 'T', targetWorkspaceName: 'forked',
    })).rejects.toThrow(/memory_chunks/);
  });

  test('19. a fork that cannot write agent_config FAILS instead of keeping the bootstrap name', async () => {
    // display_name is written here. Swallowed, the fork kept the target's
    // bootstrap identity and the UI showed the wrong workspace name.
    const src = fresh();
    const tgt = fresh();
    await seedTargetBootstrap(tgt);
    await seedSource(src, {
      identity: { id: 'S', name: 'src' }, purpose: 'p',
      messages: [{ id: 'm1', role: 'user', content: 'hi', created_at: 1000 }],
    });
    tgt.execRaw('DROP TABLE agent_config');

    await expect(forkWorkspaceStorage(src.sql, src.vfs, tgt.sql, tgt.vfs, {
      untilMessageId: 'm1', targetWorkspaceId: 'T', targetWorkspaceName: 'forked',
    })).rejects.toThrow(/agent_config/);
  });
});

/** Populate `assistant_messages` the way the SDK's session provider does,
 *  mirroring rows that already exist in `messages`: same id, same parent edge,
 *  and a serialized UIMessage whose text parts flatten to the plain row's
 *  content. That identity is what the CF turn mirror establishes, and it is what
 *  makes eliding the plain text lossless. */
function seedPaneTranscript(
  src: TestWorkspace,
  rows: Array<{ id: string; role: string; content: string; parent_id: string | null }>,
) {
  src.execRaw(SDK_SESSION_DDL);
  for (const r of rows) {
    const ui = JSON.stringify({ id: r.id, role: r.role, parts: [{ type: 'text', text: r.content }] });
    void src.sql`INSERT INTO assistant_messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${r.id}, ${''}, ${r.parent_id}, ${r.role}, ${ui}, ${'1970-01-01 00:00:01'})`;
  }
}

describe('fork snapshot payload', () => {
  test('the transcript crosses once, not once per table, and still lands intact', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedTargetBootstrap(tgt);
    const TURNS = 200;
    const rows = Array.from({ length: TURNS }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${i} ${'z'.repeat(400)}`,
      parent_id: i === 0 ? null : `m${i - 1}`,
      created_at: 1000 + i,
    }));
    await seedSource(src, { identity: { id: 'S', name: 'src' }, purpose: 'p', messages: rows });
    seedPaneTranscript(src, rows);

    const snapshot = await snapshotWorkspaceForFork(src.sql, src.vfs, `m${TURNS - 1}`);

    // Denominator: the rich transcript IS carried, in full, and so is every
    // plain row. The saving is not "carry less", it is "stop carrying the same
    // conversation twice".
    expect(snapshot.assistantMessages.length).toBe(TURNS);
    expect(snapshot.messages.length).toBe(TURNS);
    // Every plain row's text is elided because the rich row under the same id
    // carries it. Measured against a real long session, the two copies were
    // 14.4 MiB and 20.5 MiB — 34.9 MiB of one conversation against a 32 MiB
    // serialized-argument ceiling.
    expect(snapshot.messages.reduce((n, m) => n + (m.content?.length ?? 0), 0)).toBe(0);
    // Root first, edges intact: the chain the write side rebuilds against.
    expect(snapshot.messages.map((m) => m.id)).toEqual(rows.map((r) => r.id));
    expect(snapshot.messages.map((m) => m.parent_id)).toEqual(rows.map((r) => r.parent_id));

    // ...and the plain table still lands byte-identical, reconstructed at the
    // write side by the same projection the turn mirror applies.
    await writeForkSnapshot(tgt.sql, tgt.vfs, snapshot, { workspaceId: 'T', workspaceName: 'forked' });
    const landed = tgt.sql<{ id: string; content: string }>`
      SELECT id, content FROM messages WHERE role != 'system' ORDER BY rowid`;
    expect(landed.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(landed.map((r) => r.content)).toEqual(rows.map((r) => r.content));
  });

  test('a chain with no pane store carries its own text', async () => {
    // The CLI has one store, so there is no twin to elide against and nothing
    // may be dropped. This is the other half of the elision contract: `content`
    // is null EXACTLY when the rich row under that id is carried.
    const src = fresh();
    const tgt = fresh();
    await seedTargetBootstrap(tgt);
    await seedSource(src, {
      identity: { id: 'S', name: 'src' }, purpose: 'p',
      messages: [
        { id: 'm1', role: 'user', content: 'first', created_at: 1000 },
        { id: 'm2', role: 'assistant', content: 'second', created_at: 1100 },
      ],
    });

    const snapshot = await snapshotWorkspaceForFork(src.sql, src.vfs, 'm2');

    expect(snapshot.assistantMessages).toEqual([]);
    expect(snapshot.messages.map((m) => m.content)).toEqual(['first', 'second']);

    await writeForkSnapshot(tgt.sql, tgt.vfs, snapshot, { workspaceId: 'T', workspaceName: 'forked' });
    const landed = tgt.sql<{ content: string }>`
      SELECT content FROM messages WHERE role != 'system' ORDER BY rowid`;
    expect(landed.map((r) => r.content)).toEqual(['first', 'second']);
  });

  test('an elided row with no carried twin is refused, not landed empty', async () => {
    // The failure this rules out is a fork whose transcript is present but
    // blank. A snapshot that arrives with a hole says so.
    const tgt = fresh();
    await seedTargetBootstrap(tgt);
    await expect(writeForkSnapshot(tgt.sql, tgt.vfs, {
      source: { workspaceId: 'S', workspaceName: 'src' },
      cut: { messageId: 'm1', createdAtMs: 1000 },
      messages: [{ id: 'm1', parent_id: null, role: 'user', content: null, created_at: 1000 }],
      assistantMessages: [],
      files: [],
      memoryChunks: [],
      craftedTools: [],
      agentConfig: [],
    }, { workspaceId: 'T', workspaceName: 'forked' }))
      .rejects.toThrow(/elided the text of message "m1"/);
  });

  test('a transcript over the snapshot budget is refused before a row is materialized', async () => {
    const src = fresh();
    const CHUNK = 'x'.repeat(1_000_000);
    await seedSource(src, {
      identity: { id: 'S', name: 'src' }, purpose: 'p',
      messages: Array.from({ length: 18 }, (_, i) => ({
        id: `m${i}`, role: 'user', content: CHUNK, created_at: 1000 + i,
      })),
    });

    // The platform refuses a serialized argument over 32 MiB. Refusing here
    // instead means the source isolate never builds the ~35 MiB of live objects
    // it could not have sent, and the message says which component is at fault
    // and what the owner can do about it.
    await expect(snapshotWorkspaceForFork(src.sql, src.vfs, 'm17'))
      .rejects.toThrow(/over the \d+-byte budget/);
    await expect(snapshotWorkspaceForFork(src.sql, src.vfs, 'm17'))
      .rejects.toThrow(/Largest component: transcript at \d+ bytes/);
  });

  test('memory files over what the transcript left of the budget are refused by path', async () => {
    const src = fresh();
    await seedSource(src, {
      identity: { id: 'S', name: 'src' }, purpose: 'p',
      messages: Array.from({ length: 16 }, (_, i) => ({
        id: `m${i}`, role: 'user', content: 'x'.repeat(1_000_000), created_at: 1000 + i,
      })),
    });
    await src.vfs.mkdir('memory', { recursive: true });
    await src.vfs.writeFile('memory/huge.md', 'y'.repeat(1_500_000));

    await expect(snapshotWorkspaceForFork(src.sql, src.vfs, 'm15'))
      .rejects.toThrow(/files exceed the remaining \d+-byte budget at "memory\/huge\.md"/);
  });

  test('a transcript inside the budget is not refused', async () => {
    const src = fresh();
    await seedSource(src, {
      identity: { id: 'S', name: 'src' }, purpose: 'p',
      messages: [{ id: 'm1', role: 'user', content: 'x'.repeat(1_000_000), created_at: 1000 }],
    });
    await expect(snapshotWorkspaceForFork(src.sql, src.vfs, 'm1')).resolves.toBeDefined();
  });
});
