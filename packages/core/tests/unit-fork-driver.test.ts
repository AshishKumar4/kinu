/**
 * The fork driver's policy, through its public seam.
 *
 * Everything here used to be a Durable Object method, so a fork existed on
 * exactly one backend. What a backend supplies now is the transport — how to
 * reach a workspace that does not exist yet — and these tests drive the driver
 * over a recording one.
 */

import { describe, test, expect } from 'bun:test';
import {
  forkWorkspace, writeSoul, readForkLineage, writeForkSnapshot,
  type ForkSnapshot, type ForkTransport,
} from '../src/index';
import { createTestWorkspace } from './helpers';

async function sourceWorkspace() {
  const { db, sql, vfs } = createTestWorkspace();
  void sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'SRC'}, ${'atlas'}, ${100})`;
  await writeSoul(vfs, sql, 'help with testing');
  void sql`INSERT INTO messages (id, role, content, created_at) VALUES (${'m1'}, ${'user'}, ${'hello'}, ${1000})`;
  void sql`INSERT INTO messages (id, role, content, created_at) VALUES (${'m2'}, ${'assistant'}, ${'hi'}, ${1100})`;
  return { db, sql, vfs };
}

/** A transport that records what it was asked to do. `taken` is the set of
 *  names it reports as already holding data. */
function recordingTransport(taken: readonly string[] = []) {
  const delivered: Array<{ name: string; snapshot: ForkSnapshot }> = [];
  const probed: string[] = [];
  const transport: ForkTransport = {
    async occupied(name) { probed.push(name); return taken.includes(name); },
    async deliver(name, snapshot) {
      delivered.push({ name, snapshot });
      return { workspaceId: `DO-${name}` };
    },
  };
  return { transport, delivered, probed };
}

describe('forkWorkspace', () => {
  test('ships the snapshot to the requested name and reports where it landed', async () => {
    const src = await sourceWorkspace();
    const t = recordingTransport();
    const out = await forkWorkspace(
      { sql: src.sql, vfs: src.vfs, transport: t.transport, sourceName: 'atlas', busy: () => false },
      'm1',
      { name: 'my-fork' },
    );

    expect(out).toEqual({ workspaceId: 'DO-my-fork', name: 'my-fork', forkPointMs: 1000 });
    expect(t.delivered).toHaveLength(1);
    expect(t.delivered[0]!.name).toBe('my-fork');
    // The snapshot is the source view: cut at m1, so m2 is not in it.
    expect(t.delivered[0]!.snapshot.messages.map((m) => m.id)).toEqual(['m1']);
    expect(t.delivered[0]!.snapshot.source).toEqual({ workspaceId: 'SRC', workspaceName: 'atlas' });
    src.db.close();
  });

  test('an unnamed fork is named after its source and never pre-checked', async () => {
    const src = await sourceWorkspace();
    const t = recordingTransport();
    const out = await forkWorkspace(
      { sql: src.sql, vfs: src.vfs, transport: t.transport, sourceName: 'atlas', busy: () => false },
      'm2',
    );

    expect(out.name).toMatch(/^atlas-fork-[A-Za-z0-9_-]{6}$/);
    // Failing a fork over a random-id collision helps nobody, so a generated
    // name is not probed at all.
    expect(t.probed).toEqual([]);
    expect(out.forkPointMs).toBe(1100);
    src.db.close();
  });

  test('a requested name that is already taken is refused', async () => {
    const src = await sourceWorkspace();
    const t = recordingTransport(['taken']);
    await expect(forkWorkspace(
      { sql: src.sql, vfs: src.vfs, transport: t.transport, sourceName: 'atlas', busy: () => false },
      'm1',
      { name: 'taken' },
    )).rejects.toThrow('agent name already exists: "taken"');
    expect(t.delivered).toEqual([]);
    src.db.close();
  });

  test('a malformed name is refused before anything is created', async () => {
    const src = await sourceWorkspace();
    const t = recordingTransport();
    await expect(forkWorkspace(
      { sql: src.sql, vfs: src.vfs, transport: t.transport, sourceName: 'atlas', busy: () => false },
      'm1',
      { name: 'has spaces' },
    )).rejects.toThrow('invalid agent name');
    expect(t.probed).toEqual([]);
    expect(t.delivered).toEqual([]);
    src.db.close();
  });

  test('an unknown cut point is refused before a workspace is addressed', async () => {
    const src = await sourceWorkspace();
    const t = recordingTransport();
    await expect(forkWorkspace(
      { sql: src.sql, vfs: src.vfs, transport: t.transport, sourceName: 'atlas', busy: () => false },
      'nope',
      { name: 'my-fork' },
    )).rejects.toThrow('fork point not found');
    expect(t.probed).toEqual([]);
    expect(t.delivered).toEqual([]);
    src.db.close();
  });

  test('a busy agent is not forked: a mid-turn cut snapshots half a turn', async () => {
    const src = await sourceWorkspace();
    const t = recordingTransport();
    await expect(forkWorkspace(
      { sql: src.sql, vfs: src.vfs, transport: t.transport, sourceName: 'atlas', busy: () => true },
      'm1',
    )).rejects.toThrow('agent busy');
    expect(t.delivered).toEqual([]);
    src.db.close();
  });

  test('a transport that cannot answer the pre-check does not block the fork', async () => {
    const src = await sourceWorkspace();
    const delivered: string[] = [];
    const out = await forkWorkspace({
      sql: src.sql,
      vfs: src.vfs,
      sourceName: 'atlas',
      busy: () => false,
      transport: {
        async occupied() { return false; },
        async deliver(name) { delivered.push(name); return { workspaceId: 'DO-1' }; },
      },
    }, 'm1', { name: 'my-fork' });
    expect(delivered).toEqual(['my-fork']);
    expect(out.workspaceId).toBe('DO-1');
    src.db.close();
  });

  test('the delivered snapshot lands a complete fork', async () => {
    const src = await sourceWorkspace();
    const { db: tgtDb, sql: tgt, vfs: tgtVfs } = createTestWorkspace();

    const out = await forkWorkspace({
      sql: src.sql,
      vfs: src.vfs,
      sourceName: 'atlas',
      busy: () => false,
      transport: {
        async occupied() { return false; },
        async deliver(name, snapshot) {
          await writeForkSnapshot(tgt, tgtVfs, snapshot, { workspaceId: 'TGT', workspaceName: name, now: 5000 });
          return { workspaceId: 'TGT' };
        },
      },
    }, 'm2', { name: 'landed' });

    expect(out.workspaceId).toBe('TGT');
    expect(tgt<{ name: string }>`SELECT name FROM workspace_identity`[0]!.name).toBe('landed');
    expect(readForkLineage(tgt)!.sourceWorkspaceName).toBe('atlas');
    src.db.close();
    tgtDb.close();
  });
});
