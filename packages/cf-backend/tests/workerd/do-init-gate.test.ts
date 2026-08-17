/**
 * Defect 2, executed. Anything Durable Object init awaits stalls every request
 * on that object, including a pure read that touches nothing.
 *
 * WHAT WE HAD BEFORE THIS FILE. `scripts/do-init-gate.ts` walks the AST of
 * `onStart` and rejects an await in its own scope, an `async` declaration, and
 * a nested `blockConcurrencyWhile`. `unit-do-init-gate.test.ts:53-57` reflects
 * on `onStart.constructor.name`. Both are good gates and both observe a
 * DECLARATION. The measurements they exist to prevent — 2303 / 10215 / 25212 ms
 * for a 2s / 10s / 25s busy neighbour, reset at 31s
 * (`platform-catalog.ts:465`) — came from a deployed probe run once. Nothing in
 * CI reproduces the stall, so nothing would notice if the input gate stopped
 * behaving that way, or if partyserver stopped routing `onStart` through it.
 *
 * WHY `bun test` CANNOT HOST IT. `blockConcurrencyWhile` is the Durable Object
 * input gate. Bun has no actor and no gate, so a `bun test` that constructs a
 * DO class and calls a method observes zero stall by construction, whatever
 * init does.
 *
 * The stall is deliberately 700ms, not 25s: the finding is that init latency
 * passes through to an unrelated read AT ALL. Driving to the 31s reset would
 * measure the same fact for 40x the CI cost.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const STALL_MS = 700;
/** The gate is the only thing that can cost time here — `ping()` is
 *  `SELECT 1`. Half the stall is comfortably above scheduling noise and
 *  comfortably below the real stall. */
const ATTRIBUTABLE_MS = STALL_MS / 2;

describe('Durable Object init gate', () => {
  it('a pure read pays for whatever init awaited', async () => {
    const gated = env.GATED.get(env.GATED.idFromName(`stall:${STALL_MS}`));

    const startedAt = Date.now();
    const answer = await gated.ping();
    const elapsed = Date.now() - startedAt;

    // The query itself is `SELECT 1`. Everything above zero is the input gate,
    // and the neighbour Durable Object that init awaited is what set it.
    expect(answer).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(ATTRIBUTABLE_MS);
  });

  // The control that makes the assertion above attributable. Same class, same
  // query, same binding — only the awaited work in init differs. Without it,
  // "slow" could be cold-start cost, module evaluation, or the pool itself.
  it('the shipped shape — init awaits nothing — answers the same read immediately', async () => {
    const clean = env.GATED.get(env.GATED.idFromName('stall:0'));

    const startedAt = Date.now();
    const answer = await clean.ping();
    const elapsed = Date.now() - startedAt;

    expect(answer).toBe(1);
    expect(elapsed).toBeLessThan(ATTRIBUTABLE_MS);
  });

  it('the gate is held per object, so a second request behind it waits too', async () => {
    const gated = env.GATED.get(env.GATED.idFromName(`stall:${STALL_MS}:sibling`));

    const startedAt = Date.now();
    // `fetch`, `webSocketMessage`, `webSocketClose` and `alarm` all await the
    // same gate — which is why one slow init took out every caller of the
    // object, not just the one that activated it.
    const answers = await Promise.all([gated.ping(), gated.ping(), gated.ping()]);
    const elapsed = Date.now() - startedAt;

    expect(answers).toEqual([1, 1, 1]);
    expect(elapsed).toBeGreaterThanOrEqual(ATTRIBUTABLE_MS);
  });
});
