/**
 * What a settled turn still owes after the isolate running its effects dies. Workerd-only:
 * `abortAllDurableObjects()` and DO alarms do not exist under bun (actor layer: `terminal-effect-probe.ts`).
 * The duplicate oracle is row counts (`executions()` vs `outputs()`), never a spy.
 */
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { terminalEffectKey } from '@kinu.run/core';
import { HELD_EFFECT, PROBE_SEQUENCE, type ProbeClaim } from './terminal-effect-probe';

/** Wall-clock, not a fake timer: the condition is a real alarm delivery after a real eviction. */
const WAKE_DEADLINE_MS = 30_000;

const POLL_MS = 50;

/** Effects write output decoded off their row, so an output carrying this outlived the isolate. */
const ANSWER = 'the answer only the interrupted attempt recorded';

/** A stub held across a reset is broken by it; the id survives. */
const probe = (name: string) =>
  env.TERMINAL_EFFECT_PROBE.get(env.TERMINAL_EFFECT_PROBE.idFromName(name));

/** Built with the ledger's own key function so a key-version bump moves the expectation. */
const keys = (messageId: string) => PROBE_SEQUENCE.map((name) => terminalEffectKey(name, messageId));

/** Polled until settled. Reading runs no recovery, which keeps the alarm case attributable. */
async function untilSettled(name: string, deadlineMs: number): Promise<ProbeClaim[]> {
  const started = Date.now();

  for (;;) {
    const claims = await probe(name).claims();

    if (claims.every((claim) => claim.settled) && claims.length > 0) return claims;

    if (Date.now() - started > deadlineMs) return claims;
    await scheduler.wait(POLL_MS);
  }
}

describe('a terminal sequence on real Durable Object storage', () => {
  /**
   * The whole sequence is claimed before any of it runs: otherwise effects after a cut would have no
   * row, indistinguishable from effects never owed.
   */
  it('claims every owed effect before the first one runs', async () => {
    const stub = probe('claim-first');

    expect(await stub.settle('u-head', 'a-head', ANSWER, {
      cutAt: { name: 'takes', phase: 'before' },
    })).toMatch(/interrupted before its side effect/u);

    const rows = await stub.effectRows('u-head', 'a-head');
    expect(rows.map((row) => `${row.key}=${row.status}`))
      .toEqual(keys('a-head').map((key) => `${key}=pending`));
    expect(rows.every((row) => row.answer === ANSWER)).toBe(true);
    // Nothing ran: a claim, not a record.
    expect(await stub.executions()).toEqual([]);
    expect(await stub.claims()).toEqual([
      { turnId: 'u-head', messageId: 'a-head', settled: false },
    ]);
  });
});

describe('an eviction part-way through a terminal sequence', () => {
  /** The cut lands before `turn_record`; after `abortAllDurableObjects()` only the table survives. */
  it('leaves exactly the unfinished suffix, and a fresh activation finishes it', async () => {
    const stub = probe('interrupted-suffix');

    expect(await stub.settle('u-cut', 'a-cut', ANSWER, {
      cutAt: { name: 'turn_record', phase: 'before' },
    })).toMatch(/interrupted before its side effect/u);
    expect(await stub.executions()).toEqual([
      { key: terminalEffectKey('takes', 'a-cut'), runs: 1 },
      { key: terminalEffectKey('event_reply', 'a-cut'), runs: 1 },
    ]);

    await abortAllDurableObjects();

    const fresh = probe('interrupted-suffix');
    expect(await fresh.owedSequences()).toEqual(['u-cut/a-cut']);
    const survived = await fresh.effectRows('u-cut', 'a-cut');
    expect(survived.map((row) => `${row.name}=${row.status}`)).toEqual([
      'takes=completed', 'event_reply=completed',
      'turn_record=pending', 'auto_title=pending', 'auto_gepa=pending',
    ]);
    expect(survived.every((row) => row.answer === ANSWER)).toBe(true);

    // A recovery before the cut effect's retry instant runs only due rows; the cut row stays owed.
    await fresh.resume(false);
    const early = await fresh.effectRows('u-cut', 'a-cut');
    expect(early.filter((row) => row.status === 'pending').map((row) => row.name))
      .toEqual(['turn_record']);
    expect(await fresh.claims()).toEqual([
      { turnId: 'u-cut', messageId: 'a-cut', settled: false },
    ]);

    await fresh.resume(true);
    expect(await fresh.claims()).toEqual([
      { turnId: 'u-cut', messageId: 'a-cut', settled: true },
    ]);
    // Completed rows are pruned once settled, so an empty sequence is the converged state.
    expect(await fresh.effectRows('u-cut', 'a-cut')).toEqual([]);

    // The order is the recovery's: never-attempted rows were due at once, the cut one waited for its wake.
    expect(await fresh.executions()).toEqual([
      { key: terminalEffectKey('takes', 'a-cut'), runs: 1 },
      { key: terminalEffectKey('event_reply', 'a-cut'), runs: 1 },
      { key: terminalEffectKey('auto_title', 'a-cut'), runs: 1 },
      { key: terminalEffectKey('auto_gepa', 'a-cut'), runs: 1 },
      { key: terminalEffectKey('turn_record', 'a-cut'), runs: 1 },
    ]);
    const outputs = await fresh.outputs();
    expect(outputs.map((output) => output.key).sort()).toEqual([...keys('a-cut')].sort());
    expect(outputs.every((output) => output.payload === ANSWER)).toBe(true);
  });

  /**
   * The side effect happened and the isolate died before recording it. The replay runs the body again;
   * the keyed boundary keeps the effect once.
   */
  it('replays an effect cut after its side effect, and the keyed boundary holds', async () => {
    const stub = probe('indeterminate');

    expect(await stub.settle('u-after', 'a-after', ANSWER, {
      cutAt: { name: 'turn_record', phase: 'after' },
    })).toMatch(/interrupted after its side effect/u);
    expect((await stub.effectRows('u-after', 'a-after'))
      .find((row) => row.name === 'turn_record')?.status).toBe('pending');
    expect((await stub.outputs()).map((output) => output.key))
      .toContain(terminalEffectKey('turn_record', 'a-after'));

    await abortAllDurableObjects();

    const fresh = probe('indeterminate');
    // Two wakes: never-attempted rows are due at once, the cut one after its own backoff.
    await fresh.resume(false);
    await fresh.resume(true);

    expect(await fresh.executions()).toEqual([
      { key: terminalEffectKey('takes', 'a-after'), runs: 1 },
      { key: terminalEffectKey('event_reply', 'a-after'), runs: 1 },
      { key: terminalEffectKey('turn_record', 'a-after'), runs: 2 },
      { key: terminalEffectKey('auto_title', 'a-after'), runs: 1 },
      { key: terminalEffectKey('auto_gepa', 'a-after'), runs: 1 },
    ]);
    const outputs = await fresh.outputs();
    expect(outputs.map((output) => output.key).sort()).toEqual([...keys('a-after')].sort());
    expect(await fresh.claims()).toEqual([
      { turnId: 'u-after', messageId: 'a-after', settled: true },
    ]);
  });
});

describe('a duplicate callback for a sequence already in flight', () => {
  /**
   * The in-activation guard: two settles of one response in flight. The durable claim cannot help,
   * because the run in progress already holds it.
   */
  it('is refused, and no effect runs twice', async () => {
    const stub = probe('in-flight-guard');

    expect(await stub.settleTwice('u-dup', 'a-dup', ANSWER)).toBe(1);
    expect(await stub.claims()).toEqual([
      { turnId: 'u-dup', messageId: 'a-dup', settled: true },
    ]);
    const outputs = await stub.outputs();
    expect(outputs.map((output) => output.key).sort()).toEqual([...keys('a-dup')].sort());
  });
});

describe('two responses interrupted before one sweep', () => {
  /** `resumeAll` over several open claims, as a cold start finds them; identities come off the rows. */
  it('finds both from storage and converges both', async () => {
    const stub = probe('two-sequences');

    for (const messageId of ['a-one', 'a-two']) {
      expect(await stub.settle('u-both', messageId, ANSWER, {
        cutAt: { name: 'turn_record', phase: 'before' },
      })).toMatch(/interrupted before its side effect/u);
    }

    await abortAllDurableObjects();

    const fresh = probe('two-sequences');
    expect((await fresh.incompleteSequences()).sort())
      .toEqual(['u-both/a-one', 'u-both/a-two']);

    // One delivery per pass; each cut row waits for its own backoff, so sequences finish on different passes.
    for (let pass = 0; pass < 3; pass++) await fresh.resume(true);

    expect(await fresh.incompleteSequences()).toEqual([]);
    expect(await fresh.claims()).toEqual([
      { turnId: 'u-both', messageId: 'a-one', settled: true },
      { turnId: 'u-both', messageId: 'a-two', settled: true },
    ]);
    const outputs = await fresh.outputs();
    expect(outputs.map((output) => output.key).sort())
      .toEqual([...keys('a-one'), ...keys('a-two')].sort());
  });
});

describe('an effect that is still owed when the isolate dies', () => {
  /**
   * `event_reply` reports itself still owed on first execution, so the sequence may not close; after the
   * eviction only reads address the object, so only the committed alarm can finish the row.
   */
  it('keeps the outer transition open, and a durable wake converges it', async () => {
    const stub = probe('durable-wake');

    await stub.settle('u-owed', 'a-owed', ANSWER, { holdReply: true });

    const rows = await stub.effectRows('u-owed', 'a-owed');
    expect(rows.filter((row) => row.status === 'pending').map((row) => row.name))
      .toEqual([HELD_EFFECT]);
    expect(await stub.claims()).toEqual([
      { turnId: 'u-owed', messageId: 'a-owed', settled: false },
    ]);
    // Convergence is a wake, committed before this call returns, so an eviction cannot lose it.
    const wake = await stub.armedWake();
    expect(wake).not.toBeNull();
    expect(wake ?? 0).toBeGreaterThan(Date.now());

    await abortAllDurableObjects();

    const settled = await untilSettled('durable-wake', WAKE_DEADLINE_MS);
    expect(settled).toEqual([{ turnId: 'u-owed', messageId: 'a-owed', settled: true }]);

    const fresh = probe('durable-wake');
    // Attributable: done by an alarm delivery, not a read.
    expect(await fresh.alarmRuns()).toBeGreaterThan(0);
    expect(await fresh.executions()).toEqual([
      { key: terminalEffectKey('takes', 'a-owed'), runs: 1 },
      // Twice: once reporting itself owed, once finishing.
      { key: terminalEffectKey(HELD_EFFECT, 'a-owed'), runs: 2 },
      { key: terminalEffectKey('turn_record', 'a-owed'), runs: 1 },
      { key: terminalEffectKey('auto_title', 'a-owed'), runs: 1 },
      { key: terminalEffectKey('auto_gepa', 'a-owed'), runs: 1 },
    ]);
    const outputs = await fresh.outputs();
    expect(outputs.map((output) => output.key).sort()).toEqual([...keys('a-owed')].sort());
    // Converged: no wake left armed.
    expect(await fresh.armedWake()).toBeNull();
  });
});
