// What waits on the owner, as an agent's program reads it, and the one wake it can arm on it: read from the same rows
// the attention stack holds, each named by its own fields; the workspace agent's over every row, a hire's over its own.
import { expect, test } from 'bun:test';
import { createTestRuntime } from '@kinu.run/test-utils';
import { Effect } from 'effect';
import { settle } from '../src/obs/effect';
import { createAgentConfigStore } from '../src/config/store';
import { ownerWaits, ownerWaitsHost, wakeMetOwnerWaits, type OwnerWaitReader, type OwnerWaitSources } from '../src/read-models/owner-waits';
import type { DeferredApproval } from '../src/safety/deferred-approval';
import type { AgentSignal } from '../src/types/signals';

const parked = (id: string, actor: string, command: string, at: number): DeferredApproval => ({
  id, actor, command, executor: 'workspace', context: {}, reason: 'asks first', status: 'queued', requestedAt: at, decidedAt: null,
});

function sources(over: Partial<OwnerWaitSources> = {}): OwnerWaitSources {
  return {
    deferred: [parked('c1', 'main-id', 'rm -rf build', 10), parked('c2', 'hire-id', 'git push', 20), { ...parked('c3', 'main-id', 'ls', 5), status: 'approved' }],
    plans: [{ actor: 'hire-id', id: 'p1', revision: 2, content: '# Migrate the billing tables\n\nSteps…', updatedAt: 30 }],
    proposals: [{ id: 'w1', name: 'Research desk', brief: 'Reads papers', soul: '', status: 'pending', requestedAt: 40, decidedAt: null }],
    consents: [{ consentId: 'd1', deviceLabel: 'laptop', method: 'exec', command: 'brew install jq', createdAt: 50 }],
    questions: [
      { agent: 'scout', actor: 'hire-id', asked: { id: 'q1', actor: 'hire-id', callId: 'c', turnId: 't', mode: 'build', questions: [{ id: 'db', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }], status: 'open', answers: null, askedAt: 60, closedAt: null } },
      { agent: 'scout', actor: 'hire-id', asked: { id: 'q0', actor: 'hire-id', callId: 'c', turnId: 't', mode: 'build', questions: [{ id: 'x', question: 'Old?', options: [{ label: 'a' }, { label: 'b' }] }], status: 'answered', answers: null, askedAt: 1, closedAt: 2 } },
    ],
    nameOf: (actorId) => (actorId === 'hire-id' ? 'scout' : 'main'),
    ...over,
  };
}

test('every row that holds the owner, newest first, each named by its own fields; a hire reads only its own', () => {
  const rows = ownerWaits(sources());

  expect(rows.map((row) => row.wait)).toEqual([
    { key: 'question:q1', kind: 'question', what: 'Which database?', since: 60, askedBy: 'scout' },
    { key: 'consent:d1', kind: 'consent', what: 'exec on laptop: brew install jq', since: 50, askedBy: null },
    { key: 'action:w1', kind: 'workspace', what: 'Research desk', since: 40, askedBy: null },
    { key: 'plan:hire-id:p1:2', kind: 'plan', what: 'Migrate the billing tables', since: 30, askedBy: 'scout' },
    { key: 'action:c2', kind: 'command', what: 'git push', since: 20, askedBy: 'scout' },
    { key: 'action:c1', kind: 'command', what: 'rm -rf build', since: 10, askedBy: 'main' },
  ]);
  expect(rows.filter((row) => row.raisedBy === 'hire-id').map((row) => row.wait.key)).toEqual(['question:q1', 'plan:hire-id:p1:2', 'action:c2']);
});

function world() {
  const { testSql, rt } = createTestRuntime();
  let current = sources();
  const woken: Array<{ actorId: string; signal: AgentSignal }> = [];
  let armed = 0;

  const readerOf = (actorId: string, workspaceAgent: boolean): OwnerWaitReader => ({
    actorId, workspaceAgent, config: createAgentConfigStore(testSql.sql, actorId, () => undefined),
  });

  const main = readerOf(rt.actor.actorId, true);
  const hire = readerOf('hire-id', false);
  const host = (reader: OwnerWaitReader) => ownerWaitsHost({ reader, read: async () => ownerWaits(current), armed: () => { armed += 1; } });

  const pass = async () => settle(wakeMetOwnerWaits({
    readers: [main, hire], rows: async () => ownerWaits(current),
    wake: (actorId, signal) => Effect.sync(() => { woken.push({ actorId, signal }); }),
  }));

  return { main, hire, host, pass, woken, armedCount: () => armed, set: (over: Partial<OwnerWaitSources>) => { current = sources(over); } };
}

test("a hire's wake on everything it waits on comes once, when its own last ask is handled, whatever else still waits", async () => {
  const { hire, host, pass, woken, armedCount, set } = world();

  expect(await host(hire).list()).toHaveLength(3);
  expect(await host(hire).wakeWhenDone(null)).toEqual({ armed: true });
  expect(armedCount()).toBe(1);

  // The workspace's own asks still wait; the hire's are handled.
  set({ deferred: [parked('c1', 'main-id', 'rm -rf build', 10)], plans: [], questions: [] });
  expect(await pass()).toBe(false);
  expect(woken).toEqual([{ actorId: 'hire-id', signal: expect.objectContaining({ kind: 'owner_waits_cleared', text: expect.stringContaining('everything'), idempotencyKey: expect.stringContaining('owner_waits_cleared') }) }]);
  expect(hire.config.getOwnerWaitsWatch()).toBeNull();

  // Once: the next change finds nothing armed.
  await pass();
  expect(woken).toHaveLength(1);
});

test("a wake on one key waits for that ask alone; already handled, nothing is armed", async () => {
  const { main, host, pass, woken, set } = world();

  expect(await host(main).wakeWhenDone('action:c1')).toEqual({ armed: true });
  expect(main.config.getOwnerWaitsWatch()).toMatchObject({ key: 'action:c1', what: 'rm -rf build' });

  // Another ask handled: not this one.
  set({ deferred: [parked('c1', 'main-id', 'rm -rf build', 10)] });
  expect(await pass()).toBe(true);
  expect(woken).toEqual([]);

  set({ deferred: [] });
  expect(await pass()).toBe(false);
  expect(woken.map((w) => [w.actorId, w.signal.text])).toEqual([[main.actorId, 'Your owner has handled what you waited on: rm -rf build']]);

  expect(await host(main).wakeWhenDone('action:c1')).toEqual({ already: true });
  expect(main.config.getOwnerWaitsWatch()).toBeNull();
});
