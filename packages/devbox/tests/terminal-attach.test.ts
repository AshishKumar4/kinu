/**
 * A pane's terminal attach while the box is not ready (D109). On f44999 a rest's snapshot hung, and for 14 minutes every
 * attach was refused "this devbox is quiescing", which the pane showed only as "Not connected" (D108). The box now takes
 * the socket at once, tells the pane each new reason it waits, and attaches as soon as it can.
 */
import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import type { RestoreReadiness } from '../src/restoration';
import { attachWhenReady, type TerminalSocketEvents } from '../src/terminal';

const SAVING = 'the computer is saving its work and stopping; it starts again as soon as that is done';

const stopping: RestoreReadiness = { kind: 'pending', reason: SAVING, quiescing: true };

const ready: RestoreReadiness = { kind: 'restored' };

const pty: TerminalSocketEvents = { message: () => undefined, close: () => undefined, error: () => undefined };

/** A box answering its readiness asks in turn, the last forever, on a clock each wait moves; and the pane's socket. */
function boxAnswering(answers: readonly (RestoreReadiness | Error)[], leaveAfterAsks = Number.POSITIVE_INFINITY) {
  const sent: unknown[] = [];
  const closed: { code: number; reason: string }[] = [];
  let asked = 0;
  let attached = 0;
  let now = 0;

  return {
    sent, closed, asked: () => asked, attached: () => attached,
    box: {
      socket: { send: (data: string) => { sent.push(JSON.parse(data)); }, close: (code: number, reason: string) => { closed.push({ code, reason }); } },
      held: () => asked < leaveAfterAsks,
      ask: async () => {
        const answer = answers[Math.min(asked, answers.length - 1)] ?? ready;

        asked += 1;

        if (answer instanceof Error) throw answer;

        return answer;
      },
      wait: async (ms: number) => { now += ms; },
      now: () => now,
      attach: () => Effect.sync(() => {
        attached += 1;

        return pty;
      }),
    },
  };
}

describe('a terminal attach while the box saves and stops', () => {
  test('tells the pane why once, and attaches as soon as the box has stopped and started again', async () => {
    const lane = boxAnswering([stopping, stopping, stopping, ready]);

    expect({ events: await attachWhenReady(lane.box), sent: lane.sent, attached: lane.attached(), asked: lane.asked(), closed: lane.closed })
      .toEqual({ events: pty, sent: [{ type: 'status', text: SAVING }], attached: 1, asked: 4, closed: [] });
  });

  test('a pane that leaves while it waits is owed no PTY and told nothing more', async () => {
    const lane = boxAnswering([stopping], 2);

    expect({ events: await attachWhenReady(lane.box), attached: lane.attached(), sent: lane.sent, closed: lane.closed })
      .toEqual({ events: null, attached: 0, sent: [{ type: 'status', text: SAVING }], closed: [] });
  });

  test('a stop past the hold, a pending the box cannot wait out, or a failed ask is the box\'s words, and the socket closes', async () => {
    const outlasted = boxAnswering([stopping]);
    const refused = boxAnswering([{ kind: 'pending', reason: 'this devbox was destroyed after this request arrived, so the request did not run' }]);
    const failed = boxAnswering([new Error('the container could not start: Account resource limit exceeded')]);

    const results = await Promise.all([outlasted, refused, failed].map(async (lane) => ({
      events: await attachWhenReady(lane.box), last: lane.sent.at(-1), closed: lane.closed, attached: lane.attached(),
    })));

    expect(results.map(({ events, closed, attached }) => ({ events, closed, attached }))).toEqual(Array.from({ length: 3 }, () => ({
      events: null, closed: [{ code: 1011, reason: 'the terminal could not attach' }], attached: 0,
    })));
    expect(results.map(({ last }) => last)).toEqual([
      { type: 'error', error: `still after 180 s: ${SAVING}` },
      { type: 'error', error: 'this devbox was destroyed after this request arrived, so the request did not run' },
      { type: 'error', error: expect.stringContaining('Account resource limit exceeded') },
    ]);
  });
});
