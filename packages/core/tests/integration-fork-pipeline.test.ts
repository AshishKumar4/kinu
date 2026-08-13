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
  snapshotWorkspaceForFork, writeForkSnapshot,
} from '../src/index.js';
import { makeSql, makeExecRaw, createWorkspaceBundle } from './helpers.js';

function fresh() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initAllTables(execRaw);
  return { db, sql, execRaw, vfs: createWorkspaceBundle(db).vfs };
}

async function seedSource(src: ReturnType<typeof fresh>) {
  src.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'SRC-1'}, ${'source-agent'}, ${100})`;
  await writeSoul(src.vfs, src.sql, 'help with testing');
  src.sql`INSERT INTO messages (id, parent_id, role, content, created_at) VALUES (${'m1'}, ${null}, ${'user'}, ${'hello'}, ${1000})`;
  src.sql`INSERT INTO messages (id, parent_id, role, content, created_at) VALUES (${'m2'}, ${'m1'}, ${'assistant'}, ${'hi there'}, ${1100})`;
  src.sql`INSERT INTO messages (id, parent_id, role, content, created_at) VALUES (${'m3'}, ${'m2'}, ${'user'}, ${'post-fork-point'}, ${1500})`;
  src.sql`INSERT INTO conversation_history (session_id, role, message, created_at) VALUES (${'default'}, ${'user'}, ${JSON.stringify({ content: 'hello' })}, ${1000})`;
  src.sql`INSERT INTO conversation_history (session_id, role, message, created_at) VALUES (${'default'}, ${'assistant'}, ${JSON.stringify({ content: 'hi there' })}, ${1100})`;
  src.sql`INSERT INTO crafted_tools (name, description, code, scope, created_at, updated_at) VALUES (${'helper'}, ${'utility'}, ${'async (x) => x + 1'}, ${'local'}, ${500}, ${500})`;
  await src.vfs.mkdir('memory', { recursive: true });
  await src.vfs.writeFile('memory/MEMORY.md', 'key insight');
  // Pre-create agent_config and add non-display-name rows
  src.execRaw(`CREATE TABLE IF NOT EXISTS agent_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  src.sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES (${'model'}, ${'@cf/moonshotai/kimi-k2.6'})`;
}

describe('fork pipeline (end-to-end)', () => {
  test('payload round-trips across the RPC boundary (structured clone) and replays into the fork DB', async () => {
    const src = fresh();
    const tgt = fresh();
    tgt.execRaw(`CREATE TABLE IF NOT EXISTS agent_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    // Simulate the fork DO's onStart bootstrap
    tgt.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'BOOT-ID'}, ${'fork-bootstrap'}, ${999})`;
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

    const msgs = tgt.sql<{ id: string }>`SELECT id FROM messages ORDER BY created_at ASC`;
    expect(msgs.map(m => m.id)).toEqual(['m1', 'm2']);  // m3 was after fork point

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

  test('a snapshot with zero crafted tools and zero memory is safe', async () => {
    const src = fresh();
    const tgt = fresh();
    tgt.execRaw(`CREATE TABLE IF NOT EXISTS agent_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    src.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'S'}, ${'s'}, ${100})`;
    await writeSoul(src.vfs, src.sql, 'p');
    src.sql`INSERT INTO messages (id, role, content, created_at) VALUES (${'m1'}, ${'user'}, ${'hi'}, ${1000})`;

    const snapshot = structuredClone(await snapshotWorkspaceForFork(src.sql, src.vfs, 'm1'));

    await expect(writeForkSnapshot(tgt.sql, tgt.vfs, snapshot, {
      workspaceId: 'F', workspaceName: 'empty-fork', now: 7000,
    })).resolves.toBeDefined();

    const tools = tgt.sql<{ c: number }>`SELECT COUNT(*) as c FROM crafted_tools`;
    expect(tools[0]!.c).toBe(0);
  });

  test('idempotent re-copy over a partial failure — second run succeeds', async () => {
    // Simulates rawCopyFromFork being called twice: the first call failed
    // partway, leaving garbage in the fork DB, and the second must still
    // produce the correct final state. writeForkSnapshot purges the bootstrap
    // identity and any prior fork_lineage, so it is effectively idempotent.
    const src = fresh();
    const tgt = fresh();
    tgt.execRaw(`CREATE TABLE IF NOT EXISTS agent_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    // Pretend a partial first run left the fork with bootstrap identity +
    // partial messages + a stale lineage row.
    tgt.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'STALE'}, ${'partial'}, ${50})`;
    await writeSoul(tgt.vfs, tgt.sql, 'partial-soul');
    tgt.sql`INSERT INTO fork_lineage (id, source_workspace_id, source_workspace_name, source_message_id, source_message_created_at, forked_at)
            VALUES (${1}, ${'OLD'}, ${'old'}, ${'x'}, ${0}, ${0})`;

    await seedSource(src);
    const snapshot = structuredClone(await snapshotWorkspaceForFork(src.sql, src.vfs, 'm2'));

    await writeForkSnapshot(tgt.sql, tgt.vfs, snapshot, {
      workspaceId: 'FINAL', workspaceName: 'recovered-fork', now: 99999,
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
