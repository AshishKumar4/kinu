/**
 * The ONE input state machine for the TUI chat surface: turn lifecycle
 * (paired turn-start/turn-end events), Esc / Esc-Esc (interrupt → walk-back
 * picker), the Tab queue, Ctrl+B steer-as-branch, and queued-draft editing. A pure reducer — the
 * keyboard handler and the client event stream both dispatch through it, so
 * no parallel keypress handlers fight over state, and the transitions are
 * directly testable.
 */

/** Esc pressed again within this window of the arming Esc opens walk-back. */
export const ESC_ESC_BEAT_MS = 750;

export interface InputState {
  /** Open turns (turn-start minus turn-end); > 0 means processing. */
  activeTurns: number;
  /** Timestamp of the Esc that armed walk-back, or null. */
  escArmedAt: number | null;
  /** Drafts queued (Tab / /queue) to send after the current turn, FIFO. */
  queue: string[];
  /** Walk-back picker overlay visibility. */
  walkbackOpen: boolean;
  /** A walk-back request waiting for every interrupted turn to settle. */
  walkbackPending: boolean;
}

export const initialInputState: InputState = {
  activeTurns: 0,
  escArmedAt: null,
  queue: [],
  walkbackOpen: false,
  walkbackPending: false,
};

export type InputMachineEvent =
  | { type: 'turn-start' }
  | { type: 'turn-settled' }
  | { type: 'escape'; now: number; draft: string; hasUserMessages: boolean }
  | { type: 'tab'; draft: string }
  | { type: 'backspace'; draft: string }
  | { type: 'queue'; text: string }
  | { type: 'branch'; draft: string }
  | { type: 'open-walkback' }
  | { type: 'walkback-closed' };

export type InputEffect =
  | { kind: 'interrupt' }
  | { kind: 'exit' }
  | { kind: 'clear-input' }
  | { kind: 'set-input'; text: string }
  | { kind: 'hint'; text: string }
  | { kind: 'send-queued'; text: string }
  | { kind: 'send-branch'; text: string };

export interface InputTransition {
  state: InputState;
  effects: InputEffect[];
}

export function reduceInput(state: InputState, event: InputMachineEvent): InputTransition {
  switch (event.type) {
    case 'turn-start':
      return { state: { ...state, activeTurns: state.activeTurns + 1 }, effects: [] };

    case 'turn-settled': {
      const activeTurns = Math.max(0, state.activeTurns - 1);
      if (activeTurns === 0 && state.walkbackPending) {
        return {
          state: {
            ...state,
            activeTurns,
            walkbackPending: false,
            walkbackOpen: true,
          },
          effects: [],
        };
      }
      if (activeTurns === 0 && state.queue.length > 0) {
        const [next, ...rest] = state.queue;
        return {
          state: { ...state, activeTurns, queue: rest },
          effects: [{ kind: 'send-queued', text: next! }],
        };
      }
      return { state: { ...state, activeTurns }, effects: [] };
    }

    case 'escape': {
      if (state.walkbackOpen) {
        return { state: { ...state, walkbackOpen: false }, effects: [] };
      }
      const busy = state.activeTurns > 0;
      const armed = state.escArmedAt !== null && event.now - state.escArmedAt <= ESC_ESC_BEAT_MS;
      if (armed) {
        if (event.hasUserMessages) {
          return busy
            ? {
                state: {
                  ...state,
                  escArmedAt: null,
                  walkbackPending: true,
                },
                effects: [],
              }
            : {
                state: {
                  ...state,
                  escArmedAt: null,
                  walkbackOpen: true,
                },
                effects: [],
              };
        }
        return busy
          ? { state: { ...state, escArmedAt: event.now }, effects: [{ kind: 'hint', text: 'Nothing to walk back to yet.' }] }
          : { state: { ...state, escArmedAt: null }, effects: [{ kind: 'exit' }] };
      }
      if (busy) {
        // Interrupt means stop — queued drafts must not auto-fire when the
        // aborted turn settles; they return to the composer for editing.
        const restored = [event.draft.trim(), ...state.queue].filter(Boolean).join('\n');
        return {
          state: { ...state, escArmedAt: event.now, queue: [] },
          effects: [
            { kind: 'interrupt' },
            ...(state.queue.length > 0 ? [{ kind: 'set-input', text: restored } satisfies InputEffect] : []),
          ],
        };
      }
      if (event.draft.trim()) {
        return { state: { ...state, escArmedAt: event.now }, effects: [{ kind: 'clear-input' }] };
      }
      if (event.hasUserMessages) {
        return {
          state: { ...state, escArmedAt: event.now },
          effects: [{ kind: 'hint', text: 'Press Esc again to walk back to an earlier message.' }],
        };
      }
      return { state, effects: [{ kind: 'exit' }] };
    }

    case 'tab': {
      if (state.activeTurns === 0) return { state, effects: [] };
      return reduceInput(state, { type: 'queue', text: event.draft });
    }

    case 'queue': {
      const text = event.text.trim();
      if (!text) return { state, effects: [] };
      if (state.activeTurns > 0) {
        return {
          state: { ...state, queue: [...state.queue, text] },
          effects: [{ kind: 'clear-input' }],
        };
      }
      // Nothing running — a queued message just sends.
      return { state, effects: [{ kind: 'send-queued', text }] };
    }

    case 'branch': {
      const text = event.draft.trim();
      if (!text) {
        return state.activeTurns > 0
          ? { state, effects: [{ kind: 'hint', text: 'Type the redirect first — Ctrl+B runs it as a parallel branch.' }] }
          : { state, effects: [] };
      }
      if (state.activeTurns > 0) {
        return { state, effects: [{ kind: 'send-branch', text }, { kind: 'clear-input' }] };
      }
      // Nothing running — there is no live turn to branch from; just send.
      return { state, effects: [{ kind: 'send-queued', text }, { kind: 'clear-input' }] };
    }

    case 'backspace': {
      if (event.draft !== '' || state.queue.length === 0) return { state, effects: [] };
      return {
        state: { ...state, queue: state.queue.slice(0, -1) },
        effects: [{ kind: 'set-input', text: state.queue.at(-1)! }],
      };
    }

    case 'open-walkback':
      return state.activeTurns > 0
        ? { state: { ...state, walkbackPending: true, escArmedAt: null }, effects: [] }
        : { state: { ...state, walkbackOpen: true, escArmedAt: null }, effects: [] };

    case 'walkback-closed':
      return {
        state: { ...state, walkbackOpen: false, walkbackPending: false },
        effects: [],
      };
  }
}
