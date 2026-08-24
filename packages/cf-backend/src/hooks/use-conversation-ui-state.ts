/**
 * Per-conversation composer state, kept for the SPA session.
 *
 * Every agent conversation in a workspace — the orchestrator's and each
 * additional agent's — owns its draft, its Auto/Plan mode, and where its
 * reader was scrolled to. The components that render a conversation unmount
 * when another one opens, so this state cannot live in them; and it must NOT
 * live in one shared `useState` above them, which is exactly how a draft
 * typed to one agent used to surface in another's composer.
 *
 * A module-level map rather than context: the state must survive full
 * remounts (WorkspacePage is keyed by workspace), and it is deliberately
 * session-scoped — a reload starts clean, like the transcript scroll does.
 */
import { useCallback, useState } from "react";
import type { ChatMode } from "@/components/Composer";

/** A reader at the live edge saves 'pinned', not a pixel offset: the newest
 *  message keeps arriving while they are away, and restoring yesterday's
 *  offset would strand them just above it. */
export type ConversationScroll = number | "pinned";

interface ConversationUiEntry {
  draft: string;
  mode: ChatMode;
  scroll: ConversationScroll;
}

const store = new Map<string, ConversationUiEntry>();

function entryFor(key: string): ConversationUiEntry {
  let entry = store.get(key);
  if (!entry) {
    entry = { draft: "", mode: "build", scroll: "pinned" };
    store.set(key, entry);
  }
  return entry;
}

export interface ConversationUiState {
  draft: string;
  /** Replace the draft. */
  setDraft: (draft: string) => void;
  /** Rewrite the draft from its current value — the steer hook hands an
   *  interrupted draft back with `(current) => …` exactly like React's
   *  setState, and giving that shape its own entry keeps both statically
   *  typed instead of discriminating a union at runtime. */
  updateDraft: (update: (current: string) => string) => void;
  mode: ChatMode;
  setMode: (mode: ChatMode) => void;
  /** Where this conversation's reader last was — feed to the scroller's
   *  restore. Read live from the store on every render, because the scroller
   *  re-arms its restore each time its container remounts (switching to
   *  another conversation unmounts it) and must see the LATEST position, not
   *  the one from this component's own mount. */
  savedScroll: ConversationScroll;
  /** Record positions as the reader moves. Writes the store only — scroll is
   *  not render state, and a render per scroll tick would be one. */
  rememberScroll: (position: ConversationScroll) => void;
}

export function useConversationUiState(key: string): ConversationUiState {
  const [current, setCurrent] = useState(() => ({ key, ...entryFor(key) }));
  // Same-render reset when the conversation changes under a mounted component
  // (the main column swaps workspaces without remounting).
  if (current.key !== key) setCurrent({ key, ...entryFor(key) });

  const updateDraft = useCallback((update: (current: string) => string) => {
    setCurrent((prev) => {
      if (prev.key !== key) return prev;
      const draft = update(prev.draft);
      // Store write inside the updater so the rewrite resolves against the
      // same value it renders from; idempotent under a double invoke.
      entryFor(key).draft = draft;
      return { ...prev, draft };
    });
  }, [key]);
  const setDraft = useCallback((draft: string) => {
    updateDraft(() => draft);
  }, [updateDraft]);
  const setMode = useCallback((mode: ChatMode) => {
    entryFor(key).mode = mode;
    setCurrent((prev) => prev.key === key ? { ...prev, mode } : prev);
  }, [key]);
  const rememberScroll = useCallback((position: ConversationScroll) => {
    entryFor(key).scroll = position;
  }, [key]);

  return {
    draft: current.draft,
    setDraft,
    updateDraft,
    mode: current.mode,
    setMode,
    savedScroll: entryFor(key).scroll,
    rememberScroll,
  };
}
