/**
 * An owed effect whose provider refuses for good ends after one attempt, recorded as failed, with no wake left.
 * Found on prod: fact compression routed to a dead AI Gateway route answered a plain 404 on every attempt, 203 times.
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import * as v from 'valibot';
import { createTestActors } from '@kinu.run/test-utils';
import { initTerminalEffectTable, terminalEffect, TerminalEffectLedger } from '../src/orchestrator/terminal-effects';
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
    effects: { sleep_time: terminalEffect({ input: v.object({}), run: answering(status) }) },
    scheduleRetry: async (at) => { wakes.push(at); },
  });

  const rows = () => sql<{ status: string; attempts: number }>`SELECT status, attempts FROM terminal_effects`;

  return { ledger, wakes, rows, activity: () => readActivityLog(sql, actor, 10).map((entry) => [entry.event, entry.detail]) };
}

test('a gateway 404 ends the owed effect after one attempt and leaves no wake', async () => {
  const { ledger, wakes, rows, activity } = ledgerOver(404);

  await (await ledger.run('turn-1', [{ name: 'sleep_time', scope: 'm-1', input: {}, lane: 'detached' }])).reported;

  expect(rows()).toEqual([{ status: 'failed', attempts: 1 }]);
  expect(ledger.nextRetryAt()).toBeNull();
  // The one arm is the pre-attempt one; the pass that ran the effect armed nothing after it.
  expect(wakes).toEqual([NOW]);
  // Said once, where the owner looks.
  expect(activity()).toEqual([['terminal_effect_abandoned', 'memory compression failed: the model provider answered HTTP 404, so it is not retried']]);
});

test.each([429, 408, 503])('a %i stays owed, with its wake', async (status) => {
  const { ledger, rows, activity } = ledgerOver(status);

  await (await ledger.run('turn-1', [{ name: 'sleep_time', scope: 'm-1', input: {}, lane: 'detached' }])).reported;

  expect(rows()).toEqual([{ status: 'pending', attempts: 1 }]);
  expect(ledger.nextRetryAt()).not.toBeNull();
  expect(activity()).toEqual([]);
});
