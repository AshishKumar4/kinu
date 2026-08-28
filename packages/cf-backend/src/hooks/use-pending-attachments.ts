/**
 * The composer's pending attachments, and the one aggregate budget they spend.
 *
 * The cap is PER MESSAGE and shared by every pending part, so admitting a file
 * is a reservation against capacity the other pending parts already hold. The
 * shape this replaced computed the remaining capacity from render-time state,
 * awaited the base64 conversion, and appended what it had sized against a list
 * that no longer existed — so two additions started before either finished
 * (paste racing a drop, a drop racing the picker) each saw the full remaining
 * capacity and both spent it. The combined message then exceeded the cap the
 * row it persists into cannot hold.
 *
 * Here the sizing happens inside the reducer, which React runs against the
 * CURRENT list: a second addition sees the first one's parts, because the budget
 * is read where it is spent rather than captured before an await. There is no
 * second counter to keep in step with the list — the list IS the ledger — and
 * `admitAttachments` is pure, so replaying the reducer cannot double-spend.
 */
import { useCallback, useMemo, useReducer } from "react";
import { convertFileListToFileUIParts, type FileUIPart } from "ai";
import { dataUrlRawBytes } from "@/components/AttachmentChip";

/** What one offer landed: the list as it now stands, and what did not fit. */
export interface AttachmentAdmission {
  readonly parts: readonly FileUIPart[];
  readonly refused: readonly string[];
}

const partName = (part: FileUIPart): string => part.filename ?? "an attachment";

/**
 * Admit as much of `offered` as `limitBytes` still allows over `current`, in
 * offer order, and name what did not fit.
 *
 * In order rather than best-fit: the user chose the order, and a cap that
 * silently preferred the small files would reorder their message for them.
 */
export function admitAttachments(
  current: readonly FileUIPart[],
  offered: readonly FileUIPart[],
  limitBytes: number,
): AttachmentAdmission {
  let budget = limitBytes - current.reduce((sum, part) => sum + dataUrlRawBytes(part.url), 0);
  const admitted: FileUIPart[] = [];
  const refused: string[] = [];
  for (const part of offered) {
    const bytes = dataUrlRawBytes(part.url);
    if (bytes <= budget) {
      admitted.push(part);
      budget -= bytes;
    } else {
      refused.push(partName(part));
    }
  }
  return {
    parts: admitted.length === 0 ? current : [...current, ...admitted],
    refused,
  };
}

interface State {
  readonly parts: readonly FileUIPart[];
  /** Names from the LAST action only — a one-shot statement about what the user
   *  just did, not a log that outlives the capacity it described. */
  readonly refused: readonly string[];
}

type Action =
  | { readonly kind: "offer"; readonly parts: readonly FileUIPart[]; readonly oversized: readonly string[] }
  | { readonly kind: "remove"; readonly index: number }
  | { readonly kind: "clear" };

const EMPTY: State = { parts: [], refused: [] };

function reduce(state: State, action: Action, limitBytes: number): State {
  if (action.kind === "clear") return EMPTY;
  if (action.kind === "remove") {
    return {
      parts: state.parts.filter((_, index) => index !== action.index),
      // Removing frees capacity, so whatever "did not fit" said is no longer
      // true. Keeping the line would blame the cap for a message that now fits.
      refused: [],
    };
  }
  const admission = admitAttachments(state.parts, action.parts, limitBytes);
  return { parts: admission.parts, refused: [...action.oversized, ...admission.refused] };
}

export interface PendingAttachments {
  readonly parts: readonly FileUIPart[];
  /** The one line naming what the cap refused, or null. */
  readonly refusal: string | null;
  /** Add files from a picker, a paste, or a drop. Fire-and-forget: conversion
   *  is asynchronous and admission happens when it lands. */
  readonly add: (files: FileList | null | undefined) => void;
  readonly remove: (index: number) => void;
  readonly clear: () => void;
}

export function usePendingAttachments(limitBytes: number): PendingAttachments {
  const [state, dispatch] = useReducer(
    (current: State, action: Action) => reduce(current, action, limitBytes),
    EMPTY,
  );

  const add = useCallback((files: FileList | null | undefined) => {
    if (!files || files.length === 0) return;
    const candidates = [...files];
    // A file larger than the WHOLE aggregate can never be attached, whatever
    // else is pending, so it is refused before any base64 work — the inflation
    // is the expensive half and it would be thrown away.
    const oversized = candidates.filter((file) => file.size > limitBytes).map((file) => file.name);
    const convertible = candidates.filter((file) => file.size <= limitBytes);
    if (convertible.length === 0) {
      dispatch({ kind: "offer", parts: [], oversized });
      return;
    }
    // A materialized list, never the live FileList: an input's FileList empties
    // the instant its value is cleared, and a dataTransfer's when the handler
    // returns.
    const transfer = new DataTransfer();
    for (const file of convertible) transfer.items.add(file);
    void convertFileListToFileUIParts(transfer.files).then((parts) => {
      dispatch({ kind: "offer", parts, oversized });
    });
  }, [limitBytes]);

  const remove = useCallback((index: number) => { dispatch({ kind: "remove", index }); }, []);
  const clear = useCallback(() => { dispatch({ kind: "clear" }); }, []);

  const refusal = useMemo(() => (state.refused.length === 0 ? null : (
    `Chat attachments are capped at ${String(limitBytes / (1024 * 1024))} MB per message. `
    + `${state.refused.join(", ")} did not fit. `
    + `Upload larger files via the Files pane on the Environment tab.`
  )), [limitBytes, state.refused]);

  return { parts: state.parts, refusal, add, remove, clear };
}
