/**
 * Eviction recovery, with no client — the two platform facts every recovery
 * decision in `ActorAgent` stands on, neither of which had ever been observed.
 *
 * WHAT WE HAD BEFORE THIS FILE. `unit-eviction-durability.test.ts` runs the
 * recovery DECISIONS for real, against a hand-reproduced `cf_agents_runs` table,
 * and that is the right place for them: they are our code. But the bun stand-in
 * has no alarm and no isolate reset, so every case there begins with a row a
 * test wrote. Whether such a row ever arrives — whether the SDK notices it with
 * nothing connected, and whether an interrupted chat turn resumes at all — was
 * inferred from the vendor's documentation and from nothing running.
 *
 * WHY `bun test` CANNOT HOST IT. There is no `abortAllDurableObjects`, no alarm
 * dispatch and no output gate outside workerd. In bun a promise held by a
 * "reset" object simply keeps running, so the two arms below are
 * indistinguishable there.
 *
 * THE OBSERVATION NEVER TOUCHES THE PROBE, which is the only way to make "no
 * client" mean anything: a read is a request, a request runs `onStart`, and
 * `onStart` runs the interrupted-fiber scan eagerly. Both tests poll the WITNESS
 * object, so until it answers, nothing has addressed the probe since the reset —
 * and the thing that started recovery can only have been the alarm the previous
 * activation persisted.
 */
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/** Generous, because a passing run never spends it: every wait below stops at
 *  its condition. It bounds only how long a broken platform is given before the
 *  assertion reports the state actually reached. Chat recovery is scheduled on
 *  the object's own alarm with backoff, so its window is the wider one. */
const FIBER_DEADLINE_MS = 20_000;
const TURN_DEADLINE_MS = 90_000;
const POLL_MS = 50;

/** A stub held across a reset is itself broken by the reset; the id survives.
 *  Re-acquiring is what a real caller does on its next request. */
const witness = (name: string) => env.WITNESS.get(env.WITNESS.idFromName(name));
const probe = (name: string) => env.EVICTION_PROBE.get(env.EVICTION_PROBE.idFromName(name));

/**
 * Real wall-clock polling, deliberately: the condition is a REAL alarm
 * delivery, which fake timers cannot produce. Condition-bound, so the deadline
 * is only ever paid by a failing run.
 */
async function untilSeen(
  name: string, deadlineMs: number, matches: (notes: string[]) => boolean,
): Promise<string[]> {
  const started = Date.now();
  for (;;) {
    const notes = await witness(name).seen();
    if (matches(notes)) return notes;
    if (Date.now() - started > deadlineMs) return notes;
    await scheduler.wait(POLL_MS);
  }
}

/** The probe's own durable fiber rows, awaited into existence. A row is what
 *  makes the work recoverable, so an empty list means the rest of a test would
 *  measure nothing. */
async function untilFiberRow(name: string, deadlineMs: number): Promise<{ name: string }[]> {
  const started = Date.now();
  for (;;) {
    const rows = await probe(name).openFiberRows();
    if (rows.length > 0) return rows;
    if (Date.now() - started > deadlineMs) return rows;
    await scheduler.wait(POLL_MS);
  }
}

/** The probe's stored transcript, awaited until it carries `needle`. Reading it
 *  is a request, which is fine here and only here: the request that could have
 *  triggered recovery has already been made, and no WEBSOCKET exists anywhere
 *  in this file — which is what "with no client" means for a chat turn. */
async function untilTranscript(name: string, deadlineMs: number, needle: string): Promise<string> {
  const started = Date.now();
  for (;;) {
    const transcript = (await probe(name).transcript()).join('\n');
    if (transcript.includes(needle)) return transcript;
    if (Date.now() - started > deadlineMs) return transcript;
    await scheduler.wait(POLL_MS);
  }
}

describe('a durable fiber the activation took with it', () => {
  it('is recovered from the alarm alone, with nothing connected', async () => {
    const stub = probe('fiber-lost');
    await stub.startLostFiber('probe:lost');

    // The row `runFiber` wrote, before the body it will never finish.
    expect(await stub.openFiberRows()).toEqual([
      expect.objectContaining({ name: 'probe:lost' }),
    ]);

    // The eviction nobody schedules: a deploy, a runtime restart, an
    // alarm-boundary reset. `keepAlive` does not survive one — it only resets the
    // idle timer — which is exactly why the lane is a fiber and not a heartbeat.
    await abortAllDurableObjects();

    // From here until the witness answers, NOTHING addresses the probe. The only
    // thing that can start recovery is the keepAlive alarm `runFiber` armed
    // before the reset.
    const notes = await untilSeen('fiber-lost', FIBER_DEADLINE_MS, (seen) => seen.includes('fiber:probe:lost'));
    expect(notes).toContain('fiber:probe:lost');

    // And the recovery converged: the row it recovered is released, so the next
    // activation is not handed the same work again.
    expect(await probe('fiber-lost').openFiberRows()).toEqual([]);
  });
});

describe('a durable submission accepted before the reset', () => {
  it('survives it, and the interrupted turn continues with no client', async () => {
    const stub = probe('turn-lost');

    // The durable acceptance boundary: persisted BEFORE inference runs, so this
    // resolving is a promise about storage rather than about a turn.
    const accepted = await stub.submit('start the work', 'probe-turn-1');
    expect(accepted.accepted).toBe(true);

    // The turn reaches `park`, which never settles — the deterministic mid-turn
    // window this probe exists to hold open.
    const parked = await untilFiberRow('turn-lost', FIBER_DEADLINE_MS);
    // Think wraps the turn in its own recovery fiber when `chatRecovery` is on,
    // so a row here IS the turn being recoverable. An empty list would mean the
    // turn was never durable and the rest of this test would measure nothing.
    expect(parked.length).toBeGreaterThan(0);

    await abortAllDurableObjects();

    // The submission is still on record — the acceptance boundary is durable,
    // and this read is the first thing to touch the object since the reset. It
    // is also what makes the next assertion attributable: the turn had not
    // finished at reset time.
    const statuses = await probe('turn-lost').submissionStatuses();
    expect(statuses).toContainEqual(
      expect.objectContaining({ idempotencyKey: 'probe-turn-1' }),
    );

    // And the turn CONTINUED, with no socket anywhere in this test.
    //
    // Observed as the ANSWER rather than as a second entry into `park`, and the
    // difference is the vendor's contract: recovery resolves the interrupted
    // tool call rather than replaying it, so the recovered step sees a `tool`
    // role in its prompt and answers directly. A test waiting for the tool to be
    // re-entered would be waiting for something Think deliberately does not do.
    const answered = await untilTranscript('turn-lost', TURN_DEADLINE_MS, 'answered after recovery');
    expect(answered).toContain('answered after recovery');
  });
});
