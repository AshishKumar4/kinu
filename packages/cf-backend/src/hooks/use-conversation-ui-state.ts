/**
 * Per-conversation draft, mode, and scroll position. A module map: it must survive remounts,
 * stay separate per agent (never one shared state), and reset on reload.
 */
import { useCallback, useEffect, useState } from "react";
import { planReviewAwaitingDecision, type PlanReview } from "@kinu.run/core";
import type { ChatMode } from "@/components/Composer";

/** At the live edge, save 'pinned' rather than an offset so new messages do not strand the reader. */
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
  setDraft: (draft: string) => void;
  updateDraft: (update: (current: string) => string) => void;
  mode: ChatMode;
  setMode: (mode: ChatMode) => void;
  /** Read live on every render: the scroller re-arms its restore on each remount and needs the latest position. */
  savedScroll: ConversationScroll;
  /** Writes the store only; scroll is not render state. */
  rememberScroll: (position: ConversationScroll) => void;
}

export function useConversationUiState(key: string): ConversationUiState {
  const [current, setCurrent] = useState(() => ({ key, ...entryFor(key) }));

  // Same-render reset: the main column swaps workspaces without remounting.
  if (current.key !== key) setCurrent({ key, ...entryFor(key) });

  const updateDraft = useCallback((update: (current: string) => string) => {
    setCurrent((prev) => {
      if (prev.key !== key) return prev;
      const draft = update(prev.draft);
      // Store write inside the updater so it resolves against the rendered value; idempotent under a double invoke.
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

export interface PlanGatedMode {
  readonly mode: ChatMode;
  readonly locked: boolean;
}

/** A plan awaiting a decision locks the composer to Plan mode until it leaves that state. */
export function usePlanGatedMode(
  plan: PlanReview | null,
  ui: Pick<ConversationUiState, "mode" | "setMode">,
): PlanGatedMode {
  const locked = planReviewAwaitingDecision(plan);
  const approved = plan?.status === "approved";
  const setMode = ui.setMode;
  useEffect(() => {
    if (locked) setMode("plan");
    else if (approved) setMode("build");
  }, [locked, approved, setMode]);

  return { mode: locked ? "plan" : ui.mode, locked };
}
