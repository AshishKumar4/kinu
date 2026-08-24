// The TUI input reducer: interrupt/walk-back, queue, branch, and turn lifecycle.
import { describe, expect, test } from 'bun:test';
import {
  ESC_ESC_BEAT_MS,
  initialInputState,
  reduceInput,
  type InputMachineEvent,
  type InputState,
} from '../src/tui/input-state';

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
  test('Esc-Esc waits for the interrupted turn to settle before walk-back opens', () => {
    const busy = run(initialInputState, { type: 'turn-start' });
    const first = reduceInput(busy.state, esc(1_000));
    expect(first.effects).toEqual([{ kind: 'interrupt' }]);
    expect(first.state.walkbackOpen).toBe(false);

    const second = reduceInput(first.state, esc(1_000 + ESC_ESC_BEAT_MS - 1));
    expect(second.state.walkbackOpen).toBe(false);
    expect(second.state.walkbackPending).toBe(true);
    const settled = reduceInput(second.state, { type: 'turn-settled' });
    expect(settled.state.walkbackOpen).toBe(true);
    expect(settled.state.walkbackPending).toBe(false);
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

  test('walk-back waits for every active turn to settle', () => {
    const busy = run(initialInputState, { type: 'turn-start' });
    const armed = reduceInput(busy.state, esc(1_000));
    const withTurn = reduceInput(armed.state, { type: 'turn-start' });
    const second = reduceInput(withTurn.state, esc(1_400));
    expect(second.state.walkbackPending).toBe(true);
    const oneLeft = reduceInput(second.state, { type: 'turn-settled' });
    expect(oneLeft.state.walkbackOpen).toBe(false);
    expect(oneLeft.state.walkbackPending).toBe(true);
    const allSettled = reduceInput(oneLeft.state, { type: 'turn-settled' });
    expect(allSettled.state.walkbackOpen).toBe(true);
  });

  test('closing deferred walk-back drains the held queue', () => {
    const busy = run(
      initialInputState,
      { type: 'turn-start' },
      { type: 'queue', text: 'held follow-up' },
      { type: 'open-walkback' },
    );
    const settled = reduceInput(busy.state, { type: 'turn-settled' });
    expect(settled.state.walkbackOpen).toBe(true);
    const activeAgain = reduceInput(settled.state, { type: 'turn-start' });
    const postponed = reduceInput(activeAgain.state, esc(1_900));
    expect(postponed.state.queue).toEqual(['held follow-up']);
    expect(postponed.effects).toEqual([]);
    expect(settled.state.queue).toEqual(['held follow-up']);
    const closed = reduceInput(settled.state, esc(2_000));
    expect(closed.state.walkbackOpen).toBe(false);
    expect(closed.state.queue).toEqual([]);
    expect(closed.effects).toEqual([{ kind: 'send-queued', text: 'held follow-up' }]);
  });
});

describe('queue ordering', () => {
  test('the queue shortcut stores drafts in FIFO order, one per settled turn', () => {
    const busy = run(initialInputState, { type: 'turn-start' });
    const queued = run(busy.state,
      { type: 'queue-shortcut', draft: 'first queued' },
      { type: 'queue-shortcut', draft: 'second queued' },
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

  test('the queue shortcut while idle is a no-op; /queue sends immediately', () => {
    const shortcut = reduceInput(initialInputState, { type: 'queue-shortcut', draft: 'nothing running' });
    expect(shortcut.effects).toEqual([]);
    expect(shortcut.state.queue).toEqual([]);

    const queue = reduceInput(initialInputState, { type: 'queue', text: 'send me now' });
    expect(queue.effects).toEqual([{ kind: 'send-queued', text: 'send me now' }]);
  });

  test('Backspace on an empty input pops the last queued draft back for editing', () => {
    const busy = run(initialInputState,
      { type: 'turn-start' },
      { type: 'queue-shortcut', draft: 'keep' },
      { type: 'queue-shortcut', draft: 'edit me' },
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
      { type: 'queue-shortcut', draft: 'next thing' },
      { type: 'queue-shortcut', draft: 'after that' },
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
      { type: 'queue-shortcut', draft: 'after both' },
      { type: 'turn-settled' },
    );
    expect(overlapped.effects.filter((effect) => effect.kind === 'send-queued')).toEqual([]);
    const drained = reduceInput(overlapped.state, { type: 'turn-settled' });
    expect(drained.effects).toEqual([{ kind: 'send-queued', text: 'after both' }]);
  });
});

describe('semantic steer-as-branch', () => {
  test('branch while a turn runs sends the draft as a branch and clears the input', () => {
    const busy = run(initialInputState, { type: 'turn-start' });
    const branched = reduceInput(busy.state, { type: 'branch', draft: 'try the other approach' });
    expect(branched.effects).toEqual([
      { kind: 'send-branch', text: 'try the other approach' },
      { kind: 'clear-input' },
    ]);
    // Branching never queues and never interrupts — the machine state is untouched.
    expect(branched.state).toEqual(busy.state);
  });

  test('branch while idle just sends — there is no live turn to branch from', () => {
    const idle = reduceInput(initialInputState, { type: 'branch', draft: 'hello' });
    expect(idle.effects).toEqual([
      { kind: 'send-queued', text: 'hello' },
      { kind: 'clear-input' },
    ]);
  });

  test('branch with an empty draft hints while busy, no-ops while idle', () => {
    const busy = run(initialInputState, { type: 'turn-start' });
    const hinted = reduceInput(busy.state, { type: 'branch', draft: '   ' });
    expect(hinted.effects).toEqual([
      { kind: 'hint', text: 'Type the redirect first, then run the branch action.' },
    ]);
    expect(reduceInput(initialInputState, { type: 'branch', draft: '' }).effects).toEqual([]);
  });
});
