/**
 * What a settled turn still owes after the isolate running its effects dies.
 *
 * WHAT WE HAD BEFORE THIS FILE. `tests/unit-durable-terminal.test.ts` runs the
 * ledger's DECISIONS for real, and that is the right place for them: they are
 * our code. But bun has no isolate reset, so every case there re-drives recovery
 * over a `bun:sqlite` database the previous harness left in memory. "The
 * surviving rows name the unfinished suffix" was therefore a statement about
 * rows a test wrote, and "convergence comes from a durable wake" could not be
 * stated at all — the bun tier reaches recovery by CALLING it.
 *
 * WHY `bun test` CANNOT HOST IT. `abortAllDurableObjects()` and Durable Object
 * alarms exist only in workerd. Both halves of this design need them: the ledger
 * exists because an activation can end between two effects, and nothing outside
 * workerd can end one.
 *
 * WHICH LAYER THIS REACHES, and which it does not. The subject is the production
 * ledger over real Durable Object SQLite, the production claim it gates, and the
 * recovery entry point — see `terminal-effect-probe.ts` for why the ACTOR above
 * them (`onChatResponse`) is out of reach in this pool and stays under `bun test`.
 *
 * THE DUPLICATE ORACLE IS ROW COUNTS IN THE TABLES THE EFFECTS WRITE, never a
 * spy: `executions()` counts bodies that ran, `outputs()` counts side effects
 * that landed. An eviction between those two is the whole problem, so a test
 * that could not tell them apart would be measuring nothing.
 */
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { terminalEffectKey } from '@kinu.run/core';
import { HELD_EFFECT, PROBE_SEQUENCE, type ProbeClaim } from './terminal-effect-probe';

/** Generous, and never spent by a passing run: the wait below stops at its
 *  condition. It bounds how long a broken platform is given before the assertion
 *  reports the state actually reached. The condition is a REAL alarm delivery
 *  after a real eviction, which is why it is wall-clock and not a fake timer. */
const WAKE_DEADLINE_MS = 30_000;
const POLL_MS = 50;

/** Distinctive, because it is the thing that has to survive: every effect writes
 *  its output from the input DECODED OFF ITS ROW, so an output carrying this
 *  string is a recording that outlived the isolate. */
const ANSWER = 'the answer only the interrupted attempt recorded';

/** A stub held across a reset is itself broken by the reset; the id survives.
 *  Re-acquiring is what a real caller does on its next request. */
const probe = (name: string) =>
  env.TERMINAL_EFFECT_PROBE.get(env.TERMINAL_EFFECT_PROBE.idFromName(name));

/** The sequence's effect keys, in declared order, built with the ledger's own
 *  key function so a key-version bump moves the expectation with it. */
const keys = (messageId: string) => PROBE_SEQUENCE.map((name) => terminalEffectKey(name, messageId));

/**
 * The outer transition, polled until it settles.
 *
 * Reading is a request, and this probe runs no recovery on a request — that is
 * what makes the alarm case attributable. Nothing here replays anything.
 */
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
   * The reason the whole sequence is claimed before any of it runs.
   *
   * Cut at the FIRST effect and every later effect must already hold a row with
   * its input written down. Claiming each effect just before its own side effect
   * would leave the ones after the cut with no row at all — indistinguishable
   * from effects that were never owed, which is a suffix nobody can replay.
   */
  it('claims every owed effect before the first one runs', async () => {
    const stub = probe('claim-first');

    expect(await stub.settle('u-head', 'a-head', ANSWER, {
      cutAt: { name: 'takes', phase: 'before' },
    })).toMatch(/interrupted before its side effect/u);

    const rows = await stub.effectRows('u-head', 'a-head');
    expect(rows.map((row) => `${row.key}=${row.status}`))
      .toEqual(keys('a-head').map((key) => `${key}=pending`));
    // Every row already carries the input its effect will be replayed from.
    expect(rows.every((row) => row.answer === ANSWER)).toBe(true);
    // And nothing ran, which is what makes the claim a claim rather than a record.
    expect(await stub.executions()).toEqual([]);
    // The outer transition is open, so the next activation is handed the suffix.
    expect(await stub.claims()).toEqual([
      { turnId: 'u-head', messageId: 'a-head', settled: false },
    ]);
  });
});

describe('an eviction part-way through a terminal sequence', () => {
  /**
   * The whole recovery, at the tier where the isolate genuinely dies.
   *
   * The cut lands before `turn_record`, so two effects have happened and three
   * have not. Everything after `abortAllDurableObjects()` is a FRESH activation
   * with nothing hydrated: no turn, no accumulator, no live promise — only the
   * table.
   */
  it('leaves exactly the unfinished suffix, and a fresh activation finishes it', async () => {
    const stub = probe('interrupted-suffix');

    expect(await stub.settle('u-cut', 'a-cut', ANSWER, {
      cutAt: { name: 'turn_record', phase: 'before' },
    })).toMatch(/interrupted before its side effect/u);
    expect(await stub.executions()).toEqual([
      { key: terminalEffectKey('takes', 'a-cut'), runs: 1 },
      { key: terminalEffectKey('event_reply', 'a-cut'), runs: 1 },
    ]);

    // The eviction nobody schedules: a deploy, a runtime restart, an
    // alarm-boundary reset. The promise running the sequence does not survive
    // it; the rows do.
    await abortAllDurableObjects();

    const fresh = probe('interrupted-suffix');
    // What a fresh activation can find out about work it owes, before it has
    // hydrated anything at all.
    expect(await fresh.owedSequences()).toEqual(['u-cut/a-cut']);
    const survived = await fresh.effectRows('u-cut', 'a-cut');
    expect(survived.map((row) => `${row.name}=${row.status}`)).toEqual([
      'takes=completed', 'event_reply=completed',
      'turn_record=pending', 'auto_title=pending', 'auto_gepa=pending',
    ]);
    // The inputs are intact and readable — which is the only reason the suffix
    // can be run without the turn that produced it.
    expect(survived.every((row) => row.answer === ANSWER)).toBe(true);

    // A recovery that arrives before the cut effect's retry instant attempts the
    // rows that are due and leaves that one alone. It is not abandoned and it is
    // not repeated on sight: it is owed, and it keeps the transition open.
    await fresh.resume(false);
    const early = await fresh.effectRows('u-cut', 'a-cut');
    expect(early.filter((row) => row.status === 'pending').map((row) => row.name))
      .toEqual(['turn_record']);
    expect(await fresh.claims()).toEqual([
      { turnId: 'u-cut', messageId: 'a-cut', settled: false },
    ]);

    // Once it is due, the last owed row runs and the transition closes.
    await fresh.resume(true);
    expect(await fresh.claims()).toEqual([
      { turnId: 'u-cut', messageId: 'a-cut', settled: true },
    ]);
    // Completed rows are pruned once the transition settles, so an empty
    // sequence is the converged state rather than a missing one.
    expect(await fresh.effectRows('u-cut', 'a-cut')).toEqual([]);

    // Nothing ran twice across the eviction. The order is the recovery's, not
    // the sequence's: the two rows that had never been attempted were due
    // immediately, and the cut one waited for its wake.
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
   * The indeterminate instant, which is the one the old design refused to
   * replay: the side effect HAPPENED and the isolate died before anything
   * recorded that it had.
   *
   * There is no way to tell that row from one whose effect never ran, so the
   * replay runs the body a second time — and the effect still happens once,
   * because its boundary is keyed. That is what replaces refusing: the
   * execution count doubles and the side-effect count does not.
   */
  it('replays an effect cut after its side effect, and the keyed boundary holds', async () => {
    const stub = probe('indeterminate');

    expect(await stub.settle('u-after', 'a-after', ANSWER, {
      cutAt: { name: 'turn_record', phase: 'after' },
    })).toMatch(/interrupted after its side effect/u);
    // It ran, and its row says nothing about that.
    expect((await stub.effectRows('u-after', 'a-after'))
      .find((row) => row.name === 'turn_record')?.status).toBe('pending');
    expect((await stub.outputs()).map((output) => output.key))
      .toContain(terminalEffectKey('turn_record', 'a-after'));

    await abortAllDurableObjects();

    const fresh = probe('indeterminate');
    // Two wakes, because they are two schedules: the rows that were never
    // attempted are due at once, and the cut one is due after its own backoff.
    // Each pass is one delivery, running what is due at the instant it arrives.
    await fresh.resume(false);
    await fresh.resume(true);

    expect(await fresh.executions()).toEqual([
      { key: terminalEffectKey('takes', 'a-after'), runs: 1 },
      { key: terminalEffectKey('event_reply', 'a-after'), runs: 1 },
      // Run twice, honestly: nobody could tell that the first one had finished.
      { key: terminalEffectKey('turn_record', 'a-after'), runs: 2 },
      { key: terminalEffectKey('auto_title', 'a-after'), runs: 1 },
      { key: terminalEffectKey('auto_gepa', 'a-after'), runs: 1 },
    ]);
    // And the effect happened exactly once, which is the claim that matters.
    const outputs = await fresh.outputs();
    expect(outputs.map((output) => output.key).sort()).toEqual([...keys('a-after')].sort());
    expect(await fresh.claims()).toEqual([
      { turnId: 'u-after', messageId: 'a-after', settled: true },
    ]);
  });
});

describe('a duplicate callback for a sequence already in flight', () => {
  /**
   * The in-activation guard, which only exists in the lifecycle class.
   *
   * Two settles of ONE response are started before either is awaited, so the
   * second arrives while the first still holds the sequence. Without the guard it
   * would re-enter every pending effect beside the first — the durable claim
   * cannot help, because the claim is already held by the run in progress.
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
  /**
   * `resumeAll` over more than one open claim, which is the shape a cold start
   * actually finds: the sequences that need recovery are precisely the ones whose
   * process is gone, and an eviction takes every sequence that activation held.
   *
   * The identities come off the rows, so the sweep addresses both without being
   * told either.
   */
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

    // Each pass is ONE delivery, running what is due at the instant it arrives:
    // the never-attempted rows are due at once and each cut row waits for its own
    // backoff, so the two sequences reach their last row on different passes.
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
   * The gate and the convergence, in one case, because they are one mechanism.
   *
   * `event_reply` reports itself still owed on its first execution — a reply
   * channel that is still open, which is what `owed` means in production. No
   * fault is armed: the sequence runs to the end and STILL may not close, and
   * the wake is what carries the rest.
   *
   * After the eviction nothing addresses the object until the poll below, and
   * the poll only reads. The alarm the interrupted activation committed is the
   * only thing that can have finished the row, and `alarmRuns()` says whether it
   * did.
   */
  it('keeps the outer transition open, and a durable wake converges it', async () => {
    const stub = probe('durable-wake');

    await stub.settle('u-owed', 'a-owed', ANSWER, { holdReply: true });

    const rows = await stub.effectRows('u-owed', 'a-owed');
    expect(rows.filter((row) => row.status === 'pending').map((row) => row.name))
      .toEqual([HELD_EFFECT]);
    // One owed row, and the transition the turn ended on stays open over it.
    expect(await stub.claims()).toEqual([
      { turnId: 'u-owed', messageId: 'a-owed', settled: false },
    ]);
    // Convergence is a wake, not a retry loop and not an abandonment. It is
    // committed before this call returns, so an eviction cannot lose it.
    const wake = await stub.armedWake();
    expect(wake).not.toBeNull();
    expect(wake ?? 0).toBeGreaterThan(Date.now());

    await abortAllDurableObjects();

    const settled = await untilSettled('durable-wake', WAKE_DEADLINE_MS);
    expect(settled).toEqual([{ turnId: 'u-owed', messageId: 'a-owed', settled: true }]);

    const fresh = probe('durable-wake');
    // Attributable: the work was done by an alarm delivery, not by a read.
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
    // Converged: nothing owed, so no wake is left armed to find nothing to do.
    expect(await fresh.armedWake()).toBeNull();
  });
});
