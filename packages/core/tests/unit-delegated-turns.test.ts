import { expect, test } from 'bun:test';
import type { WorkspaceActor } from '../src/identity/workspace-actors';
import { DelegatedTurnRunners } from '../src/subordinates/delegated-turns';

const actor = (actorId: string): WorkspaceActor => ({
  actorId, workspaceId: 'ws', parentActorId: 'root', name: actorId, storageKey: actorId, creationId: actorId,
  origin: 'agent', tab: false, input: false, lifetime: 'durable', evolves: false, createdAt: 0, retiringAt: null, deletedAt: null,
});

test('every hired agent\'s pass runs at once, and one agent\'s passes stay in order', async () => {
  const release = Promise.withResolvers<void>();
  const running: string[] = [];
  const passes: string[] = [];
  let peak = 0;

  const pool = new DelegatedTurnRunners({
    pass: async (record) => {
      passes.push(record.actorId);
      running.push(record.actorId);
      peak = Math.max(peak, running.length);
      await release.promise;
      running.splice(running.indexOf(record.actorId), 1);

      return false;
    },
    holdLane: (body) => body(),
    failed: (_record, error) => { throw error; },
  });

  pool.start([actor('a'), actor('b'), actor('c')]);
  // More work for `a` while its pass runs: a second pass after it, never beside it.
  pool.start([actor('a')]);
  await Promise.resolve();
  expect(peak).toBe(3);

  release.resolve();
  await pool.idle();
  expect(passes.filter((id) => id === 'a')).toHaveLength(2);
  expect(peak).toBe(3);
});
