/**
 * Eviction recovery, with no client — the platform fact every fiber recovery
 * decision in `ActorAgent` stands on, which had never been observed.
 *
 * WHAT WE HAD BEFORE THIS FILE. `unit-eviction-durability.test.ts` runs the
 * recovery DECISIONS for real, against a hand-reproduced `cf_agents_runs` table,
 * and that is the right place for them: they are our code. But the bun stand-in
 * has no alarm and no isolate reset, so every case there begins with a row a
 * test wrote. Whether such a row ever arrives — whether the SDK notices it with
 * nothing connected — was inferred from the vendor's documentation and from
 * nothing running. (An interrupted CHAT turn is the loop's to resume, not the
 * SDK's: `ChatSession` re-opens it from the run ledger, which the two-turn probe
 * carries across a reset through the production orchestrator.)
 *
 * WHY `bun test` CANNOT HOST IT. There is no `abortAllDurableObjects`, no alarm
 * dispatch and no output gate outside workerd. In bun a promise held by a
 * "reset" object simply keeps running, so the two arms are indistinguishable
 * there.
 *
 * THE OBSERVATION NEVER TOUCHES THE PROBE, which is the only way to make "no
 * client" mean anything: a read is a request, a request runs `onStart`, and
 * `onStart` runs the interrupted-fiber scan eagerly. The test polls the WITNESS
 * object, so until it answers, nothing has addressed the probe since the reset —
 * and the thing that started recovery can only have been the alarm the previous
 * activation persisted.
 */
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/** Generous, because a passing run never spends it: every wait below stops at
 *  its condition. It bounds only how long a broken platform is given before the
 *  assertion reports the state actually reached. */
const FIBER_DEADLINE_MS = 20_000;

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
