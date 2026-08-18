/**
 * The user steer-drain's contract — the semantics BOTH backends now inherit
 * from one place instead of one backend having them and the other not.
 *
 * Three of these were properties of `LocalAgentSession.pendingSteers` and
 * existed nowhere the cloud backend could reach: a steer persists as a verbatim
 * user row (so the walk-back fork can cut at it), an interrupt HANDS IT BACK
 * rather than eating it, and a leftover reruns as a user-origin turn. They are
 * load-bearing, so they are pinned here against the shared class rather than
 * only against the CLI that happened to own them.
 */

import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { UserSteerDrain, steerUserMessage, type UserSteer } from '../src/orchestrator/user-steer.js';

/** A prepareStep context: what the step pipeline hands an extension. */
function step(stepNumber: number, messages: ModelMessage[]) {
  return { stepNumber, messages };
}

const HISTORY: ModelMessage[] = [
  { role: 'user', content: 'deploy the api' },
  { role: 'assistant', content: 'starting' },
];

function drain(inFlight = true) {
  const drained: UserSteer[][] = [];
  return {
    drained,
    drain: new UserSteerDrain({
      turnInFlight: () => inFlight,
      onDrain: (steers) => drained.push([...steers]),
    }),
  };
}

describe('UserSteerDrain — accepting', () => {
  test('a steer is refused when no turn is running, so the caller still owns the text', () => {
    const idle = new UserSteerDrain({ turnInFlight: () => false });
    expect(idle.accept({ text: 'nothing is running' })).toBe('idle');
    // Refused means NOT buffered: a caller that sends it as a turn must not
    // then have it spliced into the next unrelated one.
    expect(idle.pendingCount).toBe(0);
  });

  test('a steer is accepted mid-turn and reported as mid-turn, not as a boolean', () => {
    const { drain: d } = drain();
    expect(d.accept({ text: 'also check staging' })).toBe('mid-turn');
    expect(d.pendingCount).toBe(1);
  });
});

describe('UserSteerDrain — draining into the step', () => {
  test('everything pending lands as ONE user message at the step tail', () => {
    const { drain: d, drained } = drain();
    d.beginTurn();
    d.accept({ text: 'also check staging' });
    d.accept({ text: 'and the logs' });

    const rewritten = d.prepareStep(step(0, HISTORY));

    // At the TAIL: after the latest tool results, which is what keeps role
    // alternation provider-safe.
    expect(rewritten).toEqual([
      ...HISTORY,
      { role: 'user', content: 'also check staging\n\nand the logs' },
    ]);
    // One drain, both texts — and the drain is announced exactly once, because
    // "the model has it" is one event however many lines were typed.
    expect(drained).toEqual([[
      { text: 'also check staging' },
      { text: 'and the logs' },
    ]]);
    expect(d.pendingCount).toBe(0);
  });

  test('a step with nothing pending re-applies earlier steers at the index the model first saw them', () => {
    const { drain: d } = drain();
    d.beginTurn();
    d.accept({ text: 'also check staging' });
    d.prepareStep(step(0, HISTORY));

    // streamText rebuilds each step's messages from scratch, so a steer that is
    // not re-applied simply vanishes from the conversation after one step.
    const laterStep = [...HISTORY, { role: 'assistant' as const, content: 'ran a tool' }];
    expect(d.prepareStep(step(1, laterStep))).toEqual([
      ...HISTORY,
      { role: 'user', content: 'also check staging' },
      { role: 'assistant', content: 'ran a tool' },
    ]);
  });

  test('a fresh turn resets splice coordinates but KEEPS a steer typed for it', () => {
    const { drain: d } = drain();
    d.beginTurn();
    d.accept({ text: 'first turn steer' });
    d.prepareStep(step(0, HISTORY));
    expect(d.drainedTexts()).toEqual(['first turn steer']);

    // Typed while the previous turn was finishing: it belongs to the turn that
    // is about to run, not to the one that just ended.
    d.accept({ text: 'typed as the turn ended' });
    d.beginTurn();
    expect(d.drainedTexts()).toEqual([]);
    expect(d.pendingCount).toBe(1);
    expect(d.prepareStep(step(0, HISTORY))).toEqual([
      ...HISTORY,
      { role: 'user', content: 'typed as the turn ended' },
    ]);
  });

  test('attachments ride as file parts rather than being dropped from the text', () => {
    const message = steerUserMessage([{
      text: 'look at this',
      files: [{ filename: 'trace.png', mediaType: 'image/png', url: 'data:image/png;base64,AA' }],
    }]);
    expect(message).toEqual({
      role: 'user',
      content: [
        { type: 'file', data: 'data:image/png;base64,AA', mediaType: 'image/png', filename: 'trace.png' },
        { type: 'text', text: 'look at this' },
      ],
    });
  });
});

describe('UserSteerDrain — the three load-bearing semantics', () => {
  test('a drained steer is available VERBATIM for persistence, one row per steer', () => {
    const { drain: d } = drain();
    d.beginTurn();
    d.accept({ text: 'also check staging' });
    d.prepareStep(step(0, HISTORY));
    d.accept({ text: 'and the logs' });
    d.prepareStep(step(1, HISTORY));

    // Per STEER, not per drain: the walk-back fork pivot matches an individual
    // user message, so a merged "staging\n\nlogs" row would make one of them
    // unforkable.
    expect(d.drainedTexts()).toEqual(['also check staging', 'and the logs']);
  });

  test('an interrupt returns what the model never saw, and drops it from the turn', () => {
    const { drain: d } = drain();
    d.beginTurn();
    d.accept({ id: 's1', text: 'change of plans' });

    // Returned, not swallowed: the surface already rendered it as sent, so it
    // goes back to the composer.
    expect(d.interrupt()).toEqual([{ id: 's1', text: 'change of plans' }]);
    expect(d.pendingCount).toBe(0);
    // And it must NOT then reappear in the next step or as a leftover turn.
    expect(d.prepareStep(step(1, HISTORY))).toBeUndefined();
    expect(d.takeLeftover()).toEqual([]);
  });

  test('an interrupt leaves a steer the model already read in the durable record', () => {
    const { drain: d } = drain();
    d.beginTurn();
    d.accept({ text: 'also check staging' });
    d.prepareStep(step(0, HISTORY));

    // Interrupting after the drain cannot un-send it: the model acted on it, so
    // it stays in the history the next turn inherits.
    expect(d.interrupt()).toEqual([]);
    expect(d.drainedTexts()).toEqual(['also check staging']);
    expect(d.recordedMessages()).toEqual([{ role: 'user', content: 'also check staging' }]);
  });

  test('a steer that never saw a step boundary comes back as a leftover to rerun', () => {
    const { drain: d } = drain();
    d.beginTurn();
    d.prepareStep(step(0, HISTORY));
    // Typed while the model was writing its final answer — there is no further
    // step for it to land on.
    d.accept({ text: 'one more thing' });

    expect(d.takeLeftover()).toEqual([{ text: 'one more thing' }]);
    // Taken means taken: it must not ALSO splice into a later step.
    expect(d.pendingCount).toBe(0);
  });

  test('the spliced conversation replays into the turn response at the position the model saw it', () => {
    const { drain: d } = drain();
    d.beginTurn();
    d.accept({ text: 'also check staging' });
    d.prepareStep(step(0, HISTORY));

    // The durable-history merge: base coordinates are the step-0 count, so the
    // steer lands ahead of the assistant work that followed it.
    const response: ModelMessage[] = [
      { role: 'assistant', content: 'checked staging' },
    ];
    expect(d.replayInto(response)).toEqual([
      { role: 'user', content: 'also check staging' },
      { role: 'assistant', content: 'checked staging' },
    ]);
  });
});
