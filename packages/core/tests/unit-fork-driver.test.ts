/**
 * The fork driver's policy, through its public seam.
 *
 * The policy is backend-agnostic: a backend supplies only the transport — how
 * to reach a workspace that does not exist yet — and these tests drive the
 * driver over a recording one. A driver built out of Durable Object methods
 * would exist on exactly one backend.
 */

import { describe, test, expect } from 'bun:test';
import {
  forkWorkspace, readForkLineage, writeForkSnapshot, snapshotWorkspaceForFork,
  workspaceAddressRefusal, CHAT_SESSION_ID,
  type ForkDriverDeps, type ForkTransport,
} from '../src/index';
import { createTestWorkspace, type TestWorkspace } from './helpers';
import { seedForkSource, SOURCE_ARTIFACTS, TARGET_ARTIFACTS } from './helpers/fork-conversation';
import { openWorkspaceMainActor } from '../src/identity/workspace-actors';
import type { ActorHandle } from '../src/identity/actor-handle';

interface ForkSourceFixture {
  readonly workspace: TestWorkspace;
  readonly actor: ActorHandle;
}

async function sourceWorkspace(): Promise<ForkSourceFixture> {
  const workspace = createTestWorkspace();
  const chat = await seedForkSource(workspace, { workspaceId: 'SRC', workspaceName: 'atlas' });
  // The cut is looked up in THIS actor's rows, so the seeded transcript names it.
  await chat.say({ id: 'm1', role: 'user', text: 'hello', parentId: null });
  await chat.say({ id: 'm2', role: 'assistant', text: 'hi' });

  return { workspace, actor: chat.actor };
}

/** The driver's inputs, minus the transport each test varies. */
function deps(source: ForkSourceFixture, transport: ForkTransport, busy = false): ForkDriverDeps {
  return {
    sql: source.workspace.sql,
    actor: source.actor,
    vfs: source.workspace.vfs,
    artifactDirectory: SOURCE_ARTIFACTS,
    sourceName: 'atlas',
    busy: () => busy,
    transport,
  };
}

/** A transport that records what it was asked to do. `taken` is the set of
 *  names it reports as already holding data. */
function recordingTransport(taken: readonly string[] = []) {
  const delivered: Array<{ name: string; untilMessageId: string; artifactDirectory: string }> = [];
  const probed: string[] = [];

  const transport: ForkTransport = {
    async occupied(name) {
      probed.push(name);

      return taken.includes(name);
    },
    async deliver(name, source) {
      delivered.push({
        name, untilMessageId: source.untilMessageId, artifactDirectory: source.artifactDirectory,
      });

      // The transport is handed sql + the cut, never an actor: the real transfer
      // resolves the source's main actor itself (`forkTransferFrames`), and this
      // recording stand-in reads the chain the same way.
      const entry = source.sql<{ recorded_at: number }>`
        SELECT recorded_at FROM conversation_entries
        WHERE actor_id = ${openWorkspaceMainActor(source.sql).actorId}
          AND session_id = ${CHAT_SESSION_ID} AND id = ${source.untilMessageId} LIMIT 1`[0];

      if (!entry) throw new Error(`fork point not found: message id "${source.untilMessageId}" does not exist in source`);

      return { workspaceId: `DO-${name}`, forkPointMs: entry.recorded_at };
    },
  };

  return { transport, delivered, probed };
}

describe('forkWorkspace', () => {
  test('ships the source cut to the requested name and reports where it landed', async () => {
    const src = await sourceWorkspace();
    const t = recordingTransport();

    const out = await forkWorkspace(deps(src, t.transport), 'm1', { name: 'my-fork' });

    expect(out.workspaceId).toBe('DO-my-fork');
    expect(out.name).toBe('my-fork');
    expect(t.delivered).toHaveLength(1);
    // The transport receives the cut and the source's payload plane, not a
    // materialized snapshot: its source side streams rows and files in bounded
    // frames, and m2 is past this cut.
    expect(t.delivered[0]).toEqual({
      name: 'my-fork', untilMessageId: 'm1', artifactDirectory: SOURCE_ARTIFACTS,
    });
    src.workspace.db.close();
  });

  test('an unnamed fork gets a fresh workspace address a preview hostname can carry, never pre-checked', async () => {
    const src = await sourceWorkspace();
    const t = recordingTransport();

    const out = await forkWorkspace(deps(src, t.transport), 'm2');

    expect(workspaceAddressRefusal(out.name)).toBeNull();
    expect(out.name).not.toContain('atlas');
    // Failing a fork over a random-id collision helps nobody, so a generated
    // name is not probed at all.
    expect(t.probed).toEqual([]);
    expect(out.forkPointMs).toBeGreaterThan(0);
    src.workspace.db.close();
  });

  test('a requested name that is already taken is refused', async () => {
    const src = await sourceWorkspace();
    const t = recordingTransport(['taken']);

    await expect(forkWorkspace(deps(src, t.transport), 'm1', { name: 'taken' }))
      .rejects.toThrow('agent name already exists: "taken"');

    expect(t.delivered).toEqual([]);
    src.workspace.db.close();
  });

  const REFUSED_BEFORE_ANYTHING = [
    {
      name: 'a malformed name is refused before anything is created',
      cut: 'm1', forkName: 'has spaces', says: 'invalid agent name',
    },
    {
      // The primary-key preflight is bounded: it proves the cut exists without
      // materialising its ancestry, so no pending target is ever addressed.
      name: 'an unknown cut point is refused by the bounded preflight',
      cut: 'nope', forkName: 'my-fork', says: 'fork point not found',
    },
  ];

  for (const refusal of REFUSED_BEFORE_ANYTHING) {
    test(refusal.name, async () => {
      const src = await sourceWorkspace();
      const t = recordingTransport();

      await expect(forkWorkspace(deps(src, t.transport), refusal.cut, { name: refusal.forkName }))
        .rejects.toThrow(refusal.says);

      expect(t.probed).toEqual([]);
      expect(t.delivered).toEqual([]);
      src.workspace.db.close();
    });
  }

  test('a requested name no preview hostname can carry is refused with the limit', async () => {
    const src = await sourceWorkspace();
    const t = recordingTransport();

    await expect(forkWorkspace(deps(src, t.transport), 'm1', { name: 'a'.repeat(32) })).rejects.toThrow('31');
    await expect(forkWorkspace(deps(src, t.transport), 'm1', { name: 'MyFork' })).rejects.toThrow('carries no case');
    expect(t.probed).toEqual([]);
    expect(t.delivered).toEqual([]);
    src.workspace.db.close();
  });

  test('a busy agent is not forked: a mid-turn cut snapshots half a turn', async () => {
    const src = await sourceWorkspace();
    const t = recordingTransport();

    await expect(forkWorkspace(deps(src, t.transport, true), 'm1')).rejects.toThrow('agent busy');
    expect(t.delivered).toEqual([]);
    src.workspace.db.close();
  });

  test('a transport that cannot answer the pre-check does not block the fork', async () => {
    const src = await sourceWorkspace();
    const delivered: string[] = [];

    const out = await forkWorkspace(deps(src, {
      async occupied() { return false; },
      async deliver(name) {
        delivered.push(name);

        return { workspaceId: 'DO-1', forkPointMs: 1 };
      },
    }), 'm1', { name: 'my-fork' });

    expect(delivered).toEqual(['my-fork']);
    expect(out.workspaceId).toBe('DO-1');
    src.workspace.db.close();
  });

  test('the delivered source stream lands a complete fork', async () => {
    const src = await sourceWorkspace();
    const target = createTestWorkspace();

    const out = await forkWorkspace(deps(src, {
      async occupied() { return false; },
      async deliver(name, source) {
        const snapshot = await snapshotWorkspaceForFork({
          sql: source.sql, vfs: source.vfs, untilMessageId: source.untilMessageId,
          artifactDirectory: source.artifactDirectory,
        });

        await writeForkSnapshot(target.sql, target.vfs, snapshot, {
          workspaceId: 'TGT', workspaceName: name, artifactDirectory: TARGET_ARTIFACTS, now: 5000,
        });

        return { workspaceId: 'TGT', forkPointMs: snapshot.cut.createdAtMs };
      },
    }), 'm2', { name: 'landed' });

    expect(out.workspaceId).toBe('TGT');
    expect(target.sql<{ name: string }>`SELECT name FROM workspace_identity`[0]?.name).toBe('landed');
    expect(readForkLineage(target.sql)?.sourceWorkspaceName).toBe('atlas');
    src.workspace.db.close();
    target.db.close();
  });
});
