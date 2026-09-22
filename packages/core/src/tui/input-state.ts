// Keyboard and client events both dispatch through this reducer.

/** Esc pressed again within this window of the arming Esc opens walk-back. */
export const ESC_ESC_BEAT_MS = 750;

export interface InputState {
  /** turn-start minus turn-end; > 0 means processing. */
  activeTurns: number;
  escArmedAt: number | null;
  queue: string[];
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
  | { type: 'queue-shortcut'; draft: string }
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

      const [next, ...rest] = state.queue;

      if (activeTurns === 0 && next !== undefined) {
        return {
          state: { ...state, activeTurns, queue: rest },
          effects: [{ kind: 'send-queued', text: next }],
        };
      }

      return { state: { ...state, activeTurns }, effects: [] };
    }

    case 'escape': {
      if (state.walkbackOpen) {
        const [next, ...rest] = state.queue;
        const canDrain = state.activeTurns === 0 && next !== undefined;

        return {
          state: { ...state, walkbackOpen: false, queue: canDrain ? rest : state.queue },
          effects: canDrain ? [{ kind: 'send-queued', text: next }] : [],
        };
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
        // Interrupt means stop: queued drafts return to the composer instead of auto-firing.
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

    case 'queue-shortcut': {
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

      return { state, effects: [{ kind: 'send-queued', text }] };
    }

    case 'branch': {
      const text = event.draft.trim();

      if (!text) {
        return state.activeTurns > 0
          ? { state, effects: [{ kind: 'hint', text: 'Type the redirect first, then run the branch action.' }] }
          : { state, effects: [] };
      }

      if (state.activeTurns > 0) {
        return { state, effects: [{ kind: 'send-branch', text }, { kind: 'clear-input' }] };
      }

      return { state, effects: [{ kind: 'send-queued', text }, { kind: 'clear-input' }] };
    }

    case 'backspace': {
      const last = state.queue.at(-1);

      if (event.draft !== '' || last === undefined) return { state, effects: [] };

      return {
        state: { ...state, queue: state.queue.slice(0, -1) },
        effects: [{ kind: 'set-input', text: last }],
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
