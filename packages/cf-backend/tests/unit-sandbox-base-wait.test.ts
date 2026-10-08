/**
 * A call that meets a box waiting for its base snapshot (D79). The box starts by itself once the build verifies (D66),
 * so the call is held while the build moves on, and is refused only when the build failed or stopped moving. Staging
 * f69a2671a: right after a reset deploy, all 600 execs of the first run were refused "the base snapshot is being
 * rebuilt (about 30 s)", a refusal the agent was left to retry.
 */
import { describe, expect, test } from 'bun:test';
import { handClock } from '@kinu.run/test-utils';
import type { KinuDevbox } from '../src/kinu-devbox';
import { adaptCloudflareSandbox } from '../src/sandbox-exec-lane';

const REBUILDING = 'the base snapshot is being rebuilt (about 30 s); the box starts when it is ready';

type Answer = Awaited<ReturnType<KinuDevbox['resolveReadiness']>>;

const building = (step: string | null): Answer => ({ kind: 'pending', reason: REBUILDING, building: { step } });

/** A box whose `n`th readiness ask is answered `answer(n)`, and that runs what it is given. */
function boxAnswering(answer: (asked: number) => Answer) {
  const ran: string[] = [];
  let asked = 0;

  const box: KinuDevbox = Object.create({
    resolveReadiness: async () => {
      asked += 1;

      return answer(asked);
    },
    execUntimed: async (command: string) => {
      ran.push(command);

      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
    releaseUntimed: async () => {},
  });

  return { box, ran, asked: () => asked };
}

/** Lets the hold ask again `count` times; a call that settles first ends the wait with its own answer. */
async function lapse(clock: ReturnType<typeof handClock>, count: number, call: Promise<unknown>): Promise<void> {
  for (let armed = 1; armed <= count; armed += 1) {
    await Promise.race([clock.whenArmed(armed), call]);
    clock.tick();
  }
}

describe('a call that meets the base snapshot being built', () => {
  test('is held, and runs once the box is ready, its agent told nothing', async () => {
    const clock = handClock();
    const steps: readonly Answer[] = [building(null), building('starting the base image'), building('installing the tools'), { kind: 'restored' }];
    const { box, ran, asked } = boxAnswering((n) => steps[Math.min(n, steps.length) - 1] ?? { kind: 'restored' });
    const exec = adaptCloudflareSandbox(box, async () => {}, null, { clock }).exec('echo KINU_EXEC_OUT_0');

    await lapse(clock, 3, exec);

    await expect(exec).resolves.toMatchObject({ exitCode: 0, stdout: 'ok' });
    expect({ ran, asked: asked() }).toEqual({ ran: ['echo KINU_EXEC_OUT_0'], asked: 4 });
  });

  test('is held past the stall bound while the build keeps moving: the bound is on progress, never on the total', async () => {
    const clock = handClock();
    // A new step every 100 s for 300 s, past the 180 s stall bound.
    const { box, ran } = boxAnswering((n) => (n > 300 ? { kind: 'restored' } : building(`step ${String(Math.floor((n - 1) / 100))}`)));
    const exec = adaptCloudflareSandbox(box, async () => {}, null, { clock }).exec('true');

    await lapse(clock, 300, exec);

    await expect(exec).resolves.toMatchObject({ exitCode: 0 });
    expect({ ran, at: clock.now() }).toEqual({ ran: ['true'], at: 300_000 });
  });

  test('is refused in the box\'s words when the build names no new step for the stall bound', async () => {
    const clock = handClock();
    const { box, ran, asked } = boxAnswering(() => building('installing the tools'));
    const exec = adaptCloudflareSandbox(box, async () => {}, null, { clock }).exec('true');

    await lapse(clock, 180, exec);

    await expect(exec).rejects.toMatchObject({
      code: 'unavailable',
      message: `the base snapshot's build made no progress in 180 s (at: installing the tools); ${REBUILDING}`,
    });
    expect({ ran, asked: asked() }).toEqual({ ran: [], asked: 181 });
  });

  test('a failed build, and any other pending, is answered at once', async () => {
    const clock = handClock();
    const failed = 'the base snapshot could not be built: installing the tools exited 100';
    const { box, ran, asked } = boxAnswering(() => ({ kind: 'pending', reason: failed }));

    await expect(adaptCloudflareSandbox(box, async () => {}, null, { clock }).exec('true'))
      .rejects.toMatchObject({ code: 'unavailable', message: failed });
    expect({ ran, asked: asked(), armed: clock.armed() }).toEqual({ ran: [], asked: 1, armed: 0 });
  });

  test('a stop ends the hold, and nothing runs', async () => {
    const clock = handClock();
    const stop = new AbortController();
    const { box, ran } = boxAnswering(() => building('installing the tools'));
    const exec = adaptCloudflareSandbox(box, async () => {}, null, { clock }).exec('true', { signal: stop.signal });

    await Promise.race([clock.whenArmed(1), exec]);
    stop.abort();

    await expect(exec).rejects.toMatchObject({ code: 'cancelled' });
    expect(ran).toEqual([]);
  });
});
