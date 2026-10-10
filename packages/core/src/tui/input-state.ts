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
  /** Sends not yet answered, for an adapter that reports them: a queued prompt waits behind these as behind a turn. */
  sending: number;
}

export const initialInputState: InputState = {
  activeTurns: 0,
  escArmedAt: null,
  queue: [],
  walkbackOpen: false,
  walkbackPending: false,
  sending: 0,
};

export type InputMachineEvent =
  | { type: 'turn-start' }
  | { type: 'turn-settled' }
  /** A send left, or was answered, admitted or refused: what waits behind it goes once nothing else runs. */
  | { type: 'send-started' }
  | { type: 'send-ended' }
  | { type: 'escape'; now: number; draft: string; hasUserMessages: boolean }
  /** Stop the running turn, from a key or a signal: what was queued behind it returns to the input, never fires. */
  | { type: 'interrupt'; draft: string }
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

/** The next queued prompt, sent once no turn runs and no send waits on an answer. */
function released(state: InputState): InputTransition {
  const [next, ...rest] = state.queue;

  if (state.activeTurns > 0 || state.sending > 0 || next === undefined) return { state, effects: [] };

  return { state: { ...state, queue: rest }, effects: [{ kind: 'send-queued', text: next }] };
}

/** A prompt asked to go after what runs: held while a turn runs or a send waits on an answer, else sent now. */
function queued(state: InputState, text: string): InputTransition {
  if (!text) return { state, effects: [] };

  if (state.activeTurns > 0 || state.sending > 0) {
    return { state: { ...state, queue: [...state.queue, text] }, effects: [{ kind: 'clear-input' }] };
  }

  return { state, effects: [{ kind: 'send-queued', text }] };
}

/** A redirect: beside the running turn, or, with none to branch from, the next prompt behind any send still out. */
function branched(state: InputState, text: string): InputTransition {
  if (!text) {
    return state.activeTurns > 0
      ? { state, effects: [{ kind: 'hint', text: 'Type the redirect first, then run the branch action.' }] }
      : { state, effects: [] };
  }

  if (state.activeTurns > 0) return { state, effects: [{ kind: 'send-branch', text }, { kind: 'clear-input' }] };
  const next = queued(state, text);

  return { state: next.state, effects: next.state.queue.length > state.queue.length ? next.effects : [...next.effects, { kind: 'clear-input' }] };
}

/** Esc pressed again within the beat: walk back (once the turn settles, if one runs), or leave when there is nothing. */
function secondEscape(state: InputState, now: number, hasUserMessages: boolean, busy: boolean): InputTransition {
  if (hasUserMessages) {
    return busy
      ? { state: { ...state, escArmedAt: null, walkbackPending: true }, effects: [] }
      : { state: { ...state, escArmedAt: null, walkbackOpen: true }, effects: [] };
  }

  return busy
    ? { state: { ...state, escArmedAt: now }, effects: [{ kind: 'hint', text: 'Nothing to walk back to yet.' }] }
    : { state: { ...state, escArmedAt: null }, effects: [{ kind: 'exit' }] };
}

export function reduceInput(state: InputState, event: InputMachineEvent): InputTransition {
  switch (event.type) {
    case 'turn-start':
      return { state: { ...state, activeTurns: state.activeTurns + 1 }, effects: [] };

    case 'turn-settled': {
      const activeTurns = Math.max(0, state.activeTurns - 1);

      if (activeTurns === 0 && state.walkbackPending) {
        return { state: { ...state, activeTurns, walkbackPending: false, walkbackOpen: true }, effects: [] };
      }

      return released({ ...state, activeTurns });
    }

    case 'send-started':
      return { state: { ...state, sending: state.sending + 1 }, effects: [] };

    case 'send-ended':
      return released({ ...state, sending: Math.max(0, state.sending - 1) });

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

      if (armed) return secondEscape(state, event.now, event.hasUserMessages, busy);

      if (busy) {
        const stopped = reduceInput(state, { type: 'interrupt', draft: event.draft });

        return { state: { ...stopped.state, escArmedAt: event.now }, effects: stopped.effects };
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

    case 'interrupt': {
      // Interrupt means stop: queued drafts return to the input instead of auto-firing.
      const restored = [event.draft.trim(), ...state.queue].filter(Boolean).join('\n');

      return {
        state: { ...state, queue: [] },
        effects: [
          { kind: 'interrupt' },
          ...(state.queue.length > 0 ? [{ kind: 'set-input', text: restored } satisfies InputEffect] : []),
        ],
      };
    }

    case 'queue-shortcut': {
      if (state.activeTurns === 0) return { state, effects: [] };

      return reduceInput(state, { type: 'queue', text: event.draft });
    }

    case 'queue':
      return queued(state, event.text.trim());

    case 'branch':
      return branched(state, event.draft.trim());

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
