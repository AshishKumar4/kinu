/**
 * The fork-copy pipeline end-to-end, across the transport boundary.
 *
 *   1. The source workspace materializes a ForkSnapshot from its own SQL rows
 *      (snapshotWorkspaceForFork)
 *   2. The snapshot crosses the wire — structuredClone, which is what DO RPC
 *      does, and what preserves the canonical BLOB vfs rows
 *   3. The target lands it in its own SQLite (writeForkSnapshot)
 *
 * Both halves are core's, so this exercises the production path rather than a
 * transcription of it: the copy used to be defined a second time inside the CF
 * backend as a SqlExecutor shim answering the exact SELECTs the write issues,
 * and a third time here, and each transcription was a place the shapes could
 * drift apart in silence.
 *
 * Verifies the same invariants as unit-fork.test.ts, over the full round trip.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  initAllTables, readForkLineage, readSoul, writeSoul,
  snapshotWorkspaceForFork, writeForkSnapshot, SOUL_PATH,
} from '../src/index.js';
import { makeSql, makeExecRaw, createWorkspaceBundle } from './helpers.js';
import type { RawSqlExec, SqlExecutor, VFS } from '../src/types/primitives.js';

/** One in-memory workspace: production schema, filesystem, and the SDK's own
 *  message store — the shape a hosted workspace actually has. */
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
  execRaw(`CREATE TABLE IF NOT EXISTS assistant_messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT '', parent_id TEXT,
    role TEXT NOT NULL, content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  return { db, sql, execRaw, vfs: createWorkspaceBundle(db).vfs };
}

async function seedSource(src: WorkspaceFixture) {
  void src.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'SRC-1'}, ${'source-agent'}, ${100})`;
  await writeSoul(src.vfs, src.sql, 'help with testing');
  // Both stores, same ids and same edges — which is what the projection
  // maintains in production. `m3` is past the cut and must not come across.
  const chain = [
    { id: 'm1', parent: null, role: 'user', text: 'hello', at: '1970-01-01 00:00:01' },
    { id: 'm2', parent: 'm1', role: 'assistant', text: 'hi there', at: '1970-01-01 00:00:02' },
    { id: 'm3', parent: 'm2', role: 'user', text: 'post-fork-point', at: '1970-01-01 00:00:03' },
  ] as const;
  for (const m of chain) {
    void src.sql`INSERT INTO messages (id, parent_id, role, content, created_at)
      VALUES (${m.id}, ${m.parent}, ${m.role}, ${m.text}, ${Date.parse(`${m.at.replace(' ', 'T')}Z`)})`;
    void src.sql`INSERT INTO assistant_messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${m.id}, ${''}, ${m.parent}, ${m.role},
              ${JSON.stringify({ id: m.id, role: m.role, parts: [{ type: 'text', text: m.text }] })},
              ${m.at})`;
  }
  void src.sql`INSERT INTO crafted_tools (name, description, code, scope, created_at, updated_at) VALUES (${'helper'}, ${'utility'}, ${'async (x) => x + 1'}, ${'local'}, ${500}, ${500})`;
  await src.vfs.mkdir('memory', { recursive: true });
  await src.vfs.writeFile('memory/MEMORY.md', 'key insight');
  // Pre-create agent_config and add non-display-name rows
  src.execRaw(`CREATE TABLE IF NOT EXISTS agent_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  void src.sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES (${'model'}, ${'@cf/moonshotai/kimi-k2.6'})`;
}

describe('fork pipeline (end-to-end)', () => {
  test('payload round-trips across the RPC boundary (structured clone) and replays into the fork DB', async () => {
    const src = fresh();
    const tgt = fresh();
    tgt.execRaw(`CREATE TABLE IF NOT EXISTS agent_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    // Simulate the fork DO's onStart bootstrap
    void tgt.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'BOOT-ID'}, ${'fork-bootstrap'}, ${999})`;
    await writeSoul(tgt.vfs, tgt.sql, 'default');

    await seedSource(src);

    // Source side: materialize the snapshot, then cross the RPC boundary.
    // DO RPC uses structured clone, which preserves the canonical BLOB
    // (Uint8Array/ArrayBuffer) vfs rows.
    const snapshot = structuredClone(await snapshotWorkspaceForFork(src.sql, src.vfs, 'm2'));

    // Fork side: land it.
    await writeForkSnapshot(tgt.sql, tgt.vfs, snapshot, {
      workspaceId: 'FORK-DO-ID', workspaceName: 'my-fork', now: 88888,
    });

    // Assertions — the fork has correct state after the round-trip
    const ident = tgt.sql<{ id: string; name: string }>`SELECT id, name FROM workspace_identity`;
    expect(ident.length).toBe(1);
    expect(ident[0]!.id).toBe('FORK-DO-ID');
    expect(ident[0]!.name).toBe('my-fork');

    expect(await readSoul(tgt.vfs)).toBe('help with testing');

    const msgs = tgt.sql<{ id: string }>`
      SELECT id FROM messages WHERE role != 'system' ORDER BY created_at ASC`;
    expect(msgs.map(m => m.id)).toEqual(['m1', 'm2']);  // m3 is not an ancestor of m2

    const tools = tgt.sql<{ name: string }>`SELECT name FROM crafted_tools`;
    expect(tools.map(t => t.name)).toEqual(['helper']);

    // The memory arrived as a FILE the fork can open, not as copied rows.
    expect(await tgt.vfs.readFile('memory/MEMORY.md', { encoding: 'utf8' })).toBe('key insight');

    const lineage = readForkLineage(tgt.sql);
    expect(lineage).not.toBeNull();
    expect(lineage!.sourceWorkspaceId).toBe('SRC-1');
    expect(lineage!.sourceWorkspaceName).toBe('source-agent');
    expect(lineage!.sourceMessageId).toBe('m2');
    expect(lineage!.forkedAt).toBe(88888);

    // The fork marker is a message in the tree, parented on the cut point, so
    // an ancestry walk from it reaches the whole inherited chain.
    const marker = tgt.sql<{ id: string; parent_id: string | null; content: string; created_at: number }>`
      SELECT id, parent_id, content, created_at FROM messages WHERE role = 'system'
    `;
    expect(marker.length).toBe(1);
    expect(marker[0]!.parent_id).toBe('m2');
    expect(marker[0]!.created_at).toBe(snapshot.cut.createdAtMs + 1);
    expect(marker[0]!.content).toContain('forked from workspace');
    expect(marker[0]!.content).toContain('source-agent');

    // agent_config — model copied, display_name overwritten
    const cfg = new Map(tgt.sql<{ key: string; value: string }>`SELECT key, value FROM agent_config`.map(r => [r.key, r.value]));
    expect(cfg.get('model')).toBe('@cf/moonshotai/kimi-k2.6');
    expect(cfg.get('display_name')).toBe('my-fork');
  });

  test('a snapshot with zero crafted tools and zero memory is safe', async () => {
    const src = fresh();
    const tgt = fresh();
    tgt.execRaw(`CREATE TABLE IF NOT EXISTS agent_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    void src.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'S'}, ${'s'}, ${100})`;
    await writeSoul(src.vfs, src.sql, 'p');
    void src.sql`INSERT INTO messages (id, role, content, created_at) VALUES (${'m1'}, ${'user'}, ${'hi'}, ${1000})`;

    const snapshot = structuredClone(await snapshotWorkspaceForFork(src.sql, src.vfs, 'm1'));

    await expect(writeForkSnapshot(tgt.sql, tgt.vfs, snapshot, {
      workspaceId: 'F', workspaceName: 'empty-fork', now: 7000,
    })).resolves.toBeDefined();

    const tools = tgt.sql<{ c: number }>`SELECT COUNT(*) as c FROM crafted_tools`;
    expect(tools[0]!.c).toBe(0);
  });

  test('hosted fork identity preserves the owner established before file copy', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedSource(src);
    const snapshot = structuredClone(await snapshotWorkspaceForFork(src.sql, src.vfs, 'm2'));

    await writeForkSnapshot(tgt.sql, tgt.vfs, snapshot, {
      workspaceId: 'OWNED-FORK', workspaceName: 'owned-fork', ownerUserId: 'user-123', now: 9000,
    });

    expect(tgt.sql<{ owner_user_id: string }>`SELECT owner_user_id FROM workspace_identity`).toEqual([
      { owner_user_id: 'user-123' },
    ]);
  });

  test('hosted forks route SOUL.md through the owner-only writer on every delivery', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedSource(src);
    const snapshot = structuredClone(await snapshotWorkspaceForFork(src.sql, src.vfs, 'm2'));
    const soul = snapshot.files.find((file) => file.path === SOUL_PATH);
    if (!soul) throw new Error('fork snapshot did not include SOUL.md');
    const protectedWrites: string[] = [];
    const options = {
      workspaceId: 'PROTECTED-FORK',
      workspaceName: 'protected-fork',
      ownerUserId: 'user-123',
      now: 9000,
      writeSoulFile: async (content: string) => {
        protectedWrites.push(content);
        await tgt.vfs.writeFile(SOUL_PATH, content);
      },
    } as const;

    await writeForkSnapshot(tgt.sql, tgt.vfs, snapshot, options);
    await writeForkSnapshot(tgt.sql, tgt.vfs, snapshot, options);

    expect(protectedWrites).toEqual([soul.content, soul.content]);
  });

  test('repeating a completed delivery converges on exactly one copied history', async () => {
    const src = fresh();
    const tgt = fresh();
    tgt.execRaw(`CREATE TABLE IF NOT EXISTS agent_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    await seedSource(src);
    const snapshot = structuredClone(await snapshotWorkspaceForFork(src.sql, src.vfs, 'm2'));

    const options = {
      workspaceId: 'FINAL', workspaceName: 'recovered-fork', now: 99999,
    } as const;
    await writeForkSnapshot(tgt.sql, tgt.vfs, snapshot, options);
    await writeForkSnapshot(tgt.sql, tgt.vfs, snapshot, options);

    const ident = tgt.sql<{ id: string; name: string }>`SELECT id, name FROM workspace_identity`;
    expect(ident.length).toBe(1);
    expect(ident[0]!.id).toBe('FINAL');
    const lin = tgt.sql<{ c: number }>`SELECT COUNT(*) as c FROM fork_lineage`;
    expect(lin[0]!.c).toBe(1);
    const l = readForkLineage(tgt.sql);
    expect(l!.forkedAt).toBe(99999);

    const messages = tgt.sql<{ c: number }>`SELECT COUNT(*) AS c FROM messages`;
    const assistant = tgt.sql<{ c: number }>`SELECT COUNT(*) AS c FROM assistant_messages`;
    // +1 for the fork marker, which lands in both stores exactly once.
    expect(messages[0]!.c).toBe(snapshot.messages.length + 1);
    expect(assistant[0]!.c).toBe(snapshot.assistantMessages.length + 1);
  });
});
