// The TUI input state machine — Esc/Esc-Esc walk-back, the Tab queue, and
// turn-lifecycle transitions, tested as the pure reducer the chat app drives.
import { describe, expect, test } from 'bun:test';
import {
  ESC_ESC_BEAT_MS,
  initialInputState,
  reduceInput,
  type InputMachineEvent,
  type InputState,
} from '../src/tui/input-state.js';

function run(state: InputState, ...events: InputMachineEvent[]) {
  let current = state;
  const effects = [];
  for (const event of events) {
    const next = reduceInput(current, event);
    current = next.state;
    effects.push(...next.effects);
  }
  return { state: current, effects };
}

const esc = (now: number, opts: { draft?: string; hasUserMessages?: boolean } = {}): InputMachineEvent =>
  ({ type: 'escape', now, draft: opts.draft ?? '', hasUserMessages: opts.hasUserMessages ?? true });

describe('Esc / Esc-Esc state machine', () => {
  test('first Esc while processing interrupts; second within the beat opens walk-back', () => {
    const busy = run(initialInputState, { type: 'turn-start' });
    const first = reduceInput(busy.state, esc(1_000));
    expect(first.effects).toEqual([{ kind: 'interrupt' }]);
    expect(first.state.walkbackOpen).toBe(false);

    const second = reduceInput(first.state, esc(1_000 + ESC_ESC_BEAT_MS - 1));
    expect(second.state.walkbackOpen).toBe(true);
    expect(second.effects).toEqual([]);
  });

  test('a second Esc after the beat re-interrupts instead of opening walk-back', () => {
    const busy = run(initialInputState, { type: 'turn-start' });
    const first = reduceInput(busy.state, esc(1_000));
    const late = reduceInput(first.state, esc(1_000 + ESC_ESC_BEAT_MS + 1));
    expect(late.effects).toEqual([{ kind: 'interrupt' }]);
    expect(late.state.walkbackOpen).toBe(false);
  });

  test('idle: Esc clears a draft, arms, and Esc-Esc opens walk-back', () => {
    const first = reduceInput(initialInputState, esc(1_000, { draft: 'half-typed' }));
    expect(first.effects).toEqual([{ kind: 'clear-input' }]);
    const second = reduceInput(first.state, esc(1_200));
    expect(second.state.walkbackOpen).toBe(true);
  });

  test('idle with empty draft and history: Esc hints, Esc-Esc opens walk-back', () => {
    const first = reduceInput(initialInputState, esc(1_000));
    expect(first.effects[0]).toMatchObject({ kind: 'hint' });
    const second = reduceInput(first.state, esc(1_300));
    expect(second.state.walkbackOpen).toBe(true);
  });

  test('idle with no user messages: Esc exits (fresh-session behavior preserved)', () => {
    const result = reduceInput(initialInputState, esc(1_000, { hasUserMessages: false }));
    expect(result.effects).toEqual([{ kind: 'exit' }]);
  });

  test('Esc closes an open walk-back picker', () => {
    const open = reduceInput(initialInputState, { type: 'open-walkback' });
    expect(open.state.walkbackOpen).toBe(true);
    const closed = reduceInput(open.state, esc(2_000));
    expect(closed.state.walkbackOpen).toBe(false);
    expect(closed.effects).toEqual([]);
  });

  test('a new turn does not disturb an armed Esc within the beat', () => {
    const busy = run(initialInputState, { type: 'turn-start' });
    const armed = reduceInput(busy.state, esc(1_000));
    const withTurn = reduceInput(armed.state, { type: 'turn-start' });
    const second = reduceInput(withTurn.state, esc(1_400));
    expect(second.state.walkbackOpen).toBe(true);
  });
});

describe('queue ordering', () => {
  test('Tab queues drafts in order; they drain FIFO, one per settled turn', () => {
    const busy = run(initialInputState, { type: 'turn-start' });
    const queued = run(busy.state,
      { type: 'tab', draft: 'first queued' },
      { type: 'tab', draft: 'second queued' },
    );
    expect(queued.state.queue).toEqual(['first queued', 'second queued']);
    expect(queued.effects).toEqual([{ kind: 'clear-input' }, { kind: 'clear-input' }]);

    const settledOnce = reduceInput(queued.state, { type: 'turn-settled' });
    expect(settledOnce.effects).toEqual([{ kind: 'send-queued', text: 'first queued' }]);
    expect(settledOnce.state.queue).toEqual(['second queued']);

    // The drained message starts its own turn; the next settle sends the rest.
    const next = run(settledOnce.state, { type: 'turn-start' });
    const settledTwice = reduceInput(next.state, { type: 'turn-settled' });
    expect(settledTwice.effects).toEqual([{ kind: 'send-queued', text: 'second queued' }]);
    expect(settledTwice.state.queue).toEqual([]);
  });

  test('Tab while idle is a no-op; /queue while idle sends immediately', () => {
    const tab = reduceInput(initialInputState, { type: 'tab', draft: 'nothing running' });
    expect(tab.effects).toEqual([]);
    expect(tab.state.queue).toEqual([]);

    const queue = reduceInput(initialInputState, { type: 'queue', text: 'send me now' });
    expect(queue.effects).toEqual([{ kind: 'send-queued', text: 'send me now' }]);
  });

  test('Backspace on an empty input pops the last queued draft back for editing', () => {
    const busy = run(initialInputState,
      { type: 'turn-start' },
      { type: 'tab', draft: 'keep' },
      { type: 'tab', draft: 'edit me' },
    );
    const popped = reduceInput(busy.state, { type: 'backspace', draft: '' });
    expect(popped.effects).toEqual([{ kind: 'set-input', text: 'edit me' }]);
    expect(popped.state.queue).toEqual(['keep']);

    // With text in the input, Backspace belongs to the textarea.
    const typing = reduceInput(popped.state, { type: 'backspace', draft: 'kee' });
    expect(typing.effects).toEqual([]);
    expect(typing.state.queue).toEqual(['keep']);
  });

  test('Esc interrupt returns queued drafts to the composer instead of auto-firing them', () => {
    const busy = run(initialInputState,
      { type: 'turn-start' },
      { type: 'tab', draft: 'next thing' },
      { type: 'tab', draft: 'after that' },
    );
    const interrupted = reduceInput(busy.state, esc(1_000, { draft: 'half typed' }));
    expect(interrupted.effects).toEqual([
      { kind: 'interrupt' },
      { kind: 'set-input', text: 'half typed\nnext thing\nafter that' },
    ]);
    expect(interrupted.state.queue).toEqual([]);

    // The aborted turn settling sends nothing.
    const settled = reduceInput(interrupted.state, { type: 'turn-settled' });
    expect(settled.effects).toEqual([]);
  });

  test('turn counting survives overlapping turns (cloud steer) before draining', () => {
    const overlapped = run(initialInputState,
      { type: 'turn-start' },
      { type: 'turn-start' },
      { type: 'tab', draft: 'after both' },
      { type: 'turn-settled' },
    );
    expect(overlapped.effects.filter((effect) => effect.kind === 'send-queued')).toEqual([]);
    const drained = reduceInput(overlapped.state, { type: 'turn-settled' });
    expect(drained.effects).toEqual([{ kind: 'send-queued', text: 'after both' }]);
  });
});
