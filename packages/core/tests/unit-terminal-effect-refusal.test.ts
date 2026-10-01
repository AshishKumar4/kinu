/**
 * An owed effect whose provider refuses for good ends after one attempt, its row gone, with no wake left.
 * Found on prod: fact compression routed to a dead AI Gateway route answered a plain 404 on every attempt, 203 times.
 * One the owner must fix (401/402/403) parks with no wake until the owner's change or new work releases it.
 * Found on prod 2026-09-29 (ironwood-cairn-6dbcb8de): the fast tier's provider answered 402 for 11.5 hours, and every
 * settled turn added a sleep_time row retried on a 600 s ceiling: 18 object activations an hour with nobody there.
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, type LanguageModel } from 'ai';
import * as v from 'valibot';
import { createTestActors } from '@kinu.run/test-utils';
import {
  initTerminalEffectTable, TERMINAL_EFFECT_RETRY_CEILING_MS, terminalEffect, TerminalEffectLedger,
  type OwedEffect, type TerminalEffectTable,
} from '../src/orchestrator/terminal-effects';
import { TerminalTransitions } from '../src/orchestrator/terminal-transition';
import { initToolEffectClaimTable } from '../src/tools/effect-claim';
import { initActorDdl } from '../src/identity/schema';
import { readActivityLog } from '../src/identity/activity-log';
import { toKinuError } from '../src/obs/index';
import { asFetchFunction, CHATGPT_CRED_KEY, createChatGptProvider } from '../src/index';
import { makeExecRaw, makeSql } from './helpers';

const NOW = 1_700_000_000_000;

/** opencode's answer to ironwood-cairn-6dbcb8de's fast tier on 2026-09-29. */
const NO_FUNDS = JSON.stringify({ error: { message: 'Upstream request failed: Insufficient account funds', type: 'server_error' } });

/** An effect body that calls `model` once. */
function calling(model: LanguageModel) {
  return async () => {
    await generateText({ model, prompt: 'compress the facts', maxRetries: 0 });

    return { status: 'completed' as const };
  };
}

/** A model call through a route whose gateway answers `status`. */
function answering(status: number, body = 'Not Found', calls: { n: number } = { n: 0 }) {
  const provider = createOpenAICompatible({
    name: 'my-gateway', baseURL: 'https://gateway.example.test/v1',
    // `typeof fetch` carries `preconnect`.
    fetch: Object.assign(async () => {
      calls.n += 1;

      return new Response(body, { status, headers: { 'content-type': body.startsWith('{') ? 'application/json' : 'text/plain' } });
    }, { preconnect: async (): Promise<void> => {} }),
  });

  return calling(provider('fast'));
}

/** The shape a host's effect body throws: its own step wrapped around the provider's answer. */
function wrapped(call: () => Promise<{ status: 'completed' }>) {
  return async () => {
    try {
      return await call();
    } catch (cause) {
      throw toKinuError({ doing: 'compressing the recent turns into agent facts', cause, otherwise: 'unavailable' });
    }
  };
}

function store() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  const actor = createTestActors(sql, execRaw).main;

  initTerminalEffectTable(execRaw);
  initToolEffectClaimTable(execRaw);
  initActorDdl(execRaw);

  return { db, sql, actor };
}

function ledgerOver(status: number, run = answering(status)) {
  const { db, sql, actor } = store();
  const wakes: number[] = [];

  const ledger = new TerminalEffectLedger({
    sql, actor, now: () => NOW,
    transaction: (body) => db.transaction(body)(),
    effects: { sleep_time: terminalEffect({ input: v.object({}), run }) },
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

test.each([429, 408, 503])('a %i stays owed, with its wake', async (status) => {
  const { ledger, rows, activity } = ledgerOver(status);

  await (await ledger.run('turn-1', [{ name: 'sleep_time', scope: 'm-1', input: {}, lane: 'detached' }])).reported;

  expect(rows()).toEqual([{ status: 'pending', attempts: 1 }]);
  expect(ledger.nextRetryAt()).not.toBeNull();
  expect(activity()).toEqual([]);
});

test.each([401, 402, 403])('a %i parks the effect with no wake, and a release makes it due', async (status) => {
  const { ledger, wakes, rows, activity } = ledgerOver(status, answering(status, NO_FUNDS));

  await (await ledger.run('turn-1', [{ name: 'sleep_time', scope: 'm-1', input: {}, lane: 'detached' }])).reported;

  expect(rows()).toEqual([{ status: 'parked', attempts: 1 }]);
  expect(ledger.nextRetryAt()).toBeNull();
  // Only the pre-attempt backstop; nothing after the refusal.
  expect(wakes).toEqual([NOW + TERMINAL_EFFECT_RETRY_CEILING_MS]);
  expect(activity()).toEqual([]);

  expect(ledger.release()).toBe(1);
  expect(rows()).toEqual([{ status: 'pending', attempts: 1 }]);
  expect(ledger.nextRetryAt()).toBe(NOW);
});

// The cf sleep_time body wraps the provider's answer in its own step (orchestrator.ts runSleepTimeCompute); the
// wrapper's code is a guess, and read first it hid both the 404 and the 402.
test.each([
  [404, 'abandoned', []],
  [402, 'parked', [{ status: 'parked', attempts: 1 }]],
] as const)('a %i the host wrapped in its own step is still read off the provider', async (status, _outcome, left) => {
  const { ledger, rows } = ledgerOver(status, wrapped(answering(status, NO_FUNDS)));

  await (await ledger.run('turn-1', [{ name: 'sleep_time', scope: 'm-1', input: {}, lane: 'detached' }])).reported;

  expect(rows()).toEqual([...left]);
  expect(ledger.nextRetryAt()).toBeNull();
});

/** A call on the ChatGPT plan after its usage limit is reached (SIWC errors-and-recovery, 2026-09-30). */
function planSpent() {
  const provider = createChatGptProvider();

  const model = provider.createModel('gpt-6.1-sol', {
    env: {},
    sessionAffinity: 'kinu-test',
    fetch: asFetchFunction(async () => Response.json(
      { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'usage limit reached', param: null, type: 'rate_limit_error' } },
      { status: 429 },
    )),
    getAuth: async () => ({ headers: { Authorization: 'Bearer at-1' } }),
    hasCredential: async (key) => key === CHATGPT_CRED_KEY,
  });

  return calling(model);
}

// A 429 that is a spent plan, not a busy one: waiting does not restore it, so it is the owner's to fix.
test('a spent ChatGPT plan parks the effect with no wake, even wrapped in the host\'s step', async () => {
  const { ledger, wakes, rows } = ledgerOver(429, wrapped(planSpent()));

  await (await ledger.run('turn-1', [{ name: 'sleep_time', scope: 'm-1', input: {}, lane: 'detached' }])).reported;

  expect(rows()).toEqual([{ status: 'parked', attempts: 1 }]);
  expect(ledger.nextRetryAt()).toBeNull();
  expect(wakes).toEqual([NOW + TERMINAL_EFFECT_RETRY_CEILING_MS]);
});

// ironwood-cairn-6dbcb8de, 2026-09-29: genesis owed auto_title, three settled turns each owed sleep_time, and the fast
// tier answered 402 throughout. Each row retried on its own 600 s ceiling and the object woke 18 times an hour.
test('settled turns under an owner-fixable refusal leave one row per effect and no clock', async () => {
  const { db, sql, actor } = store();
  const calls = { n: 0 };
  const refused = wrapped(answering(402, NO_FUNDS, calls));
  const wakes: number[] = [];
  const closes: Promise<void>[] = [];

  const effects: TerminalEffectTable = {
    sleep_time: terminalEffect({ input: v.object({}), run: refused }),
    auto_title: terminalEffect({ input: v.object({ subject: v.string() }), run: refused }),
  };

  const transitions = new TerminalTransitions({
    sql, actor, now: () => NOW, effects,
    scheduleRetry: async (at) => { wakes.push(at); },
    transaction: <T>(body: () => T): T => db.transaction(body)(),
    turnIsLive: () => false,
    settled: async () => {},
  });

  const settle = async (turnId: string, name: 'sleep_time' | 'auto_title') => {
    const owed: OwedEffect = { name, scope: `${turnId}-answer`, input: name === 'auto_title' ? { subject: 'Hello' } : {}, lane: 'detached' };

    await transitions.settle({
      transition: { turnId, messageId: `${turnId}-answer` },
      declare: () => [owed],
      hold: (_transition, close) => { closes.push(close()); },
    });
    await Promise.all(closes);
    // The wake the settle armed.
    await transitions.replayOwedAndRearm();
  };

  await settle('genesis', 'auto_title');

  for (const turn of ['t1', 't2', 't3']) await settle(turn, 'sleep_time');

  const rows = sql<{ sequence_id: string; effect_name: string; status: string }>`
    SELECT sequence_id, effect_name, status FROM terminal_effects ORDER BY effect_name`;

  // The newest sleep_time completed each one before it, and a completed sequence ends with its rows.
  expect(rows).toEqual([
    { sequence_id: 'genesis/genesis-answer', effect_name: 'auto_title', status: 'parked' },
    { sequence_id: 't3/t3-answer', effect_name: 'sleep_time', status: 'parked' },
  ]);
  // One call per settled turn's own effect, plus the parked title each new turn released.
  expect(calls.n).toBe(7);
  expect(transitions.nextRetryAt()).toBeNull();
  expect(transitions.hasIncomplete()).toBe(false);

  // An activation for any other reason arms nothing for them.
  const armed = wakes.length;

  await transitions.armOwedRecovery();
  expect(wakes.length).toBe(armed);

  // The owner's change: both fall due on one wake.
  await transitions.releaseParked();
  expect(wakes.slice(armed)).toEqual([NOW]);
  expect(transitions.nextRetryAt()).toBe(NOW);
});

/** Answers each call from `answers` once `gate` opens; past the list, a completion. */
function gatedGateway(answers: number[], gate: Promise<void>, calls: { n: number }) {
  const provider = createOpenAICompatible({
    name: 'my-gateway', baseURL: 'https://gateway.example.test/v1',
    fetch: Object.assign(async () => {
      calls.n += 1;
      await gate;

      const status = answers.shift();

      return status === undefined
        ? Response.json({ id: 'r', object: 'chat.completion', created: 0, model: 'fast', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hello' } }] })
        : new Response(NO_FUNDS, { status, headers: { 'content-type': 'application/json' } });
    }, { preconnect: async (): Promise<void> => {} }),
  });

  return calling(provider('fast'));
}

// Review of T1, 2026-09-30: the owner replaced a refused key while a call made with the old one still waited on its
// answer. The release found nothing parked, the late refusal parked the row, and nothing tried the new key.
test.each([
  ['the owner changes the model settings', 401, (transitions: TerminalTransitions) => transitions.releaseParked()],
  ['a newer turn claims its effects', 402, async (transitions: TerminalTransitions) => {
    transitions.ledger.claim('t2/t2-answer', [{ name: 'sleep_time', scope: 't2-answer', input: {}, lane: 'detached' }]);
  }],
] as const)('a refusal answered after %s falls due at once instead of parking', async (_when, status, release) => {
  const { db, sql, actor } = store();
  const answer = Promise.withResolvers<void>();
  const calls = { n: 0 };
  const wakes: number[] = [];

  const transitions = new TerminalTransitions({
    sql, actor, now: () => NOW,
    effects: {
      auto_title: terminalEffect({ input: v.object({ subject: v.string() }), run: wrapped(gatedGateway([status], answer.promise, calls)) }),
      sleep_time: terminalEffect({ input: v.object({}), run: async () => ({ status: 'completed' as const }) }),
    },
    scheduleRetry: async (at) => { wakes.push(at); },
    transaction: <T>(body: () => T): T => db.transaction(body)(),
    turnIsLive: () => false,
    settled: async () => {},
  });

  const titled = () => sql<{ status: string; next_attempt_at: number }>`
    SELECT status, next_attempt_at FROM terminal_effects WHERE sequence_id = 't1/t1-answer'`;

  const run = await transitions.ledger.run('t1/t1-answer', [{ name: 'auto_title', scope: 't1-answer', input: { subject: 'Hello' }, lane: 'detached' }]);

  await release(transitions);
  answer.resolve();
  await run.reported;

  expect(titled()).toEqual([{ status: 'pending', next_attempt_at: NOW }]);
  expect(wakes.at(-1)).toBe(NOW);

  // The wake tries what the change may have fixed.
  await transitions.ledger.replayOwed('t1/t1-answer');
  expect(calls.n).toBe(2);
  expect(titled().map((row) => row.status)).toEqual(['completed']);
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
