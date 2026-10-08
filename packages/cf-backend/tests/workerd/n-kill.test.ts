/**
 * A workspace turn of five shell steps whose object is killed five times while it works, each kill where the platform
 * can land one: a model request before any byte, a model stream after its first delta, a tool call the model just
 * delivered (its shell still asleep), and between steps. Nothing connects after a kill: the turn's own wake brings
 * the object back. Compare acoyfellow/tardigrade's kill5, which retries a stalled step forever; Kinu settles a turn
 * that two runs leave at one step (the stall rule) rather than handing it the same cut again. That rule needs a
 * stamped build, which this pool does not carry: unit-chat-reopened-turn proves it on the harness, which does.
 *
 * The guarantee is that a recorded claimed call is never replayed automatically, not that a side effect can never
 * happen twice: told a cut call may or may not have run, the model can issue a fresh call doing the same thing. What
 * this scripted model's fresh call does is an observation here, not a pin.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const driver = (name: string) => env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName(name));

/** One kill per step, so each run gets further than the one before it: the stall rule settles nothing. */
const KILLS = [
  { step: 1, attempt: 1, at: 'request' },
  { step: 2, attempt: 1, at: 'stream' },
  { step: 3, attempt: 1, at: 'delivered' },
  { step: 4, attempt: 1, at: 'request' },
  { step: 5, attempt: 1, at: 'delivered' },
] as const;

describe('a turn killed five times while it works', () => {
  it('finishes once, writes each step once, replays no recorded call, and comes back with no client', async () => {
    const journey = await driver('n-kill').killedTurn(KILLS);

    // Measured, not pinned: how long each kill left the object down before it asked for the cut step again.
    console.info('n-kill revival', JSON.stringify(journey.kills), 'fresh calls', JSON.stringify(journey.issued));

    expect(journey.kills.map(({ step, at }) => ({ step, at }))).toEqual(KILLS.map(({ step, at }) => ({ step, at })));
    expect(journey.file).toBe('step-1\nstep-2\nstep-3\nstep-4\nstep-5\n');
    expect(journey.answers).toBe(1);
    expect(journey.runEnds).toEqual([{ runId: expect.any(String), reason: 'completed' }]);
    expect(journey.claimOutcome).toBe('completed');

    // A call a kill cut is answered for what it is, never run again under its recorded id.
    expect(new Set(journey.issued).size).toBe(journey.issued.length);

    // Each step is told it ran exactly once: no recorded call ran again and was answered twice, and none was lost. A
    // cut call the product recorded is answered as one that may or may not have run, so a step can hold more calls
    // than runs; how many is measured, not pinned.
    console.info('n-kill steps', JSON.stringify(journey.steps));
    expect(journey.steps.map(({ step, ran }) => ({ step, ran }))).toEqual(KILLS.map(({ step }) => ({ step, ran: 1 })));
  });
});
