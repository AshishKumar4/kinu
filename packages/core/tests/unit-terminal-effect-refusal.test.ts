/**
 * An owed effect whose provider refuses for good ends after one attempt, its row gone, with no wake left.
 * Found on prod: fact compression routed to a dead AI Gateway route answered a plain 404 on every attempt, 203 times.
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import * as v from 'valibot';
import { createTestActors } from '@kinu.run/test-utils';
import { initTerminalEffectTable, TERMINAL_EFFECT_RETRY_CEILING_MS, terminalEffect, TerminalEffectLedger } from '../src/orchestrator/terminal-effects';
import { initActorDdl } from '../src/identity/schema';
import { readActivityLog } from '../src/identity/activity-log';
import { makeExecRaw, makeSql } from './helpers';

const NOW = 1_700_000_000_000;

/** A model call through a route whose gateway answers `status` with no gateway code. */
function answering(status: number) {
  const provider = createOpenAICompatible({
    name: 'my-gateway', baseURL: 'https://gateway.example.test/v1',
    // `typeof fetch` carries `preconnect`.
    fetch: Object.assign(async () => new Response('Not Found', { status }), { preconnect: async (): Promise<void> => {} }),
  });

  return async () => {
    await generateText({ model: provider('fast'), prompt: 'compress the facts', maxRetries: 0 });

    return { status: 'completed' as const };
  };
}

function ledgerOver(status: number) {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  const actor = createTestActors(sql, execRaw).main;
  const wakes: number[] = [];

  initTerminalEffectTable(execRaw);
  initActorDdl(execRaw);

  const ledger = new TerminalEffectLedger({
    sql, actor, now: () => NOW,
    transaction: (body) => db.transaction(body)(),
    effects: { sleep_time: terminalEffect({ input: v.object({}), run: answering(status) }) },
    scheduleRetry: async (at) => { wakes.push(at); },
  });

  const rows = () => sql<{ status: string; attempts: number }>`SELECT status, attempts FROM terminal_effects`;

  return { ledger, wakes, rows, activity: () => readActivityLog(sql, actor, 10).map((entry) => [entry.event, entry.detail]) };
}

test.each([404, 400, 413, 422])('a gateway %i ends the owed effect after one attempt and leaves no wake', async (status) => {
  const { ledger, wakes, rows, activity } = ledgerOver(status);

  await (await ledger.run('turn-1', [{ name: 'sleep_time', scope: 'm-1', input: {}, lane: 'detached' }])).reported;

  expect(rows()).toEqual([]);
  expect(ledger.nextRetryAt()).toBeNull();
  // The one arm is the pre-attempt backstop, deferred while this process runs the sequence; the pass that ran
  // the effect armed nothing after it.
  expect(wakes).toEqual([NOW + TERMINAL_EFFECT_RETRY_CEILING_MS]);
  // Said once, where the owner looks.
  expect(activity()).toEqual([['terminal_effect_abandoned', `memory compression failed: the model provider answered HTTP ${String(status)}, so it is not retried`]]);
});

// 401/402/403 are owner-fixable (a key or a top-up), so they replay once fixed.
test.each([429, 408, 503, 401, 402, 403])('a %i stays owed, with its wake', async (status) => {
  const { ledger, rows, activity } = ledgerOver(status);

  await (await ledger.run('turn-1', [{ name: 'sleep_time', scope: 'm-1', input: {}, lane: 'detached' }])).reported;

  expect(rows()).toEqual([{ status: 'pending', attempts: 1 }]);
  expect(ledger.nextRetryAt()).not.toBeNull();
  expect(activity()).toEqual([]);
});

// 2026-09-29 (workerd complexity flake, 632 statements against 541): the pre-attempt arm was due now, so a sequence
// that outlived the next second met its own process's retry pass, which found everything in flight.
test('while this process runs a sequence, its backstop wake is armed but not due', async () => {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  const actor = createTestActors(sql, execRaw).main;
  const wakes: number[] = [];
  const release = Promise.withResolvers<void>();

  initTerminalEffectTable(execRaw);
  initActorDdl(execRaw);

  const hold = async () => {
    await release.promise;

    return { status: 'completed' as const };
  };

  const ledger = new TerminalEffectLedger({
    sql, actor, now: () => NOW,
    transaction: (body) => db.transaction(body)(),
    effects: { sleep_time: terminalEffect({ input: v.object({}), run: hold }) },
    scheduleRetry: async (at) => { wakes.push(at); },
  });

  const run = await ledger.run('turn-1', [{ name: 'sleep_time', scope: 'm-1', input: {}, lane: 'detached' }]);

  // A kill now still leaves a wake; the live process is not woken into the effect it is running.
  expect(wakes).toEqual([NOW + TERMINAL_EFFECT_RETRY_CEILING_MS]);
  release.resolve();
  await run.reported;
  expect(ledger.nextRetryAt()).toBeNull();
});

// 2026-09-29 (durable-exec review): a neighbour's in-flight row is as much this process's as the driven one's.
test('a second sequence driven while the first still runs arms no wake into the first; its own retry lands on time', async () => {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  const actor = createTestActors(sql, execRaw).main;
  const wakes: number[] = [];
  const release = Promise.withResolvers<void>();

  initTerminalEffectTable(execRaw);
  initActorDdl(execRaw);

  const failLater = async () => {
    await release.promise;

    throw new Error('the model provider timed out');
  };

  const ledger = new TerminalEffectLedger({
    sql, actor, now: () => NOW,
    transaction: (body) => db.transaction(body)(),
    effects: {
      sleep_time: terminalEffect({ input: v.object({}), run: failLater }),
      turn_record: terminalEffect({ input: v.object({}), run: () => Promise.resolve({ status: 'completed' as const }) }),
    },
    scheduleRetry: async (at) => { wakes.push(at); },
  });

  const inFlight = new Set<string>(['A']);

  ledger.claim('A', [{ name: 'sleep_time', scope: 'm-1', input: {}, lane: 'detached' }]);
  const first = await ledger.drive('A', inFlight);

  inFlight.add('B');
  ledger.claim('B', [{ name: 'turn_record', scope: 'm-2', input: {}, lane: 'inline' }]);
  await (await ledger.drive('B', inFlight)).reported;
  inFlight.delete('B');
  expect(wakes.filter((at) => at < NOW + TERMINAL_EFFECT_RETRY_CEILING_MS)).toEqual([]);

  release.resolve();
  await first.reported;
  const [owed] = sql<{ next_attempt_at: number }>`SELECT next_attempt_at FROM terminal_effects WHERE sequence_id = 'A'`;

  expect(owed?.next_attempt_at).toBeLessThan(NOW + TERMINAL_EFFECT_RETRY_CEILING_MS);
  expect(wakes.at(-1)).toBe(owed?.next_attempt_at);
});
