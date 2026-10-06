/**
 * The per-message cap is shared by all pending parts, so sizing runs in the reducer against the current list;
 * sizing before the base64 await lets concurrent additions spend the same capacity.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { convertFileListToFileUIParts, type FileUIPart } from "ai";
import { dataUrlRawBytes } from "@/components/AttachmentChip";
import { Cause, Effect, type Exit } from "effect";
import { diagnostics, hold, renderThrownChain } from "@kinu.run/core/obs";

export interface AttachmentAdmission {
  readonly parts: readonly FileUIPart[];
  readonly refused: readonly string[];
}

const partName = (part: FileUIPart): string => part.filename ?? "an attachment";

/** In offer order, not best-fit: best-fit would reorder the user's message. */
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
  readonly refused: readonly string[];
  readonly conversionFailure: string | null;
}

type Action =
  | { readonly kind: "offer"; readonly parts: readonly FileUIPart[]; readonly oversized: readonly string[] }
  | { readonly kind: "conversion_failed"; readonly oversized: readonly string[]; readonly message: string }
  | { readonly kind: "remove"; readonly index: number }
  | { readonly kind: "clear" };

const EMPTY: State = { parts: [], refused: [], conversionFailure: null };

function reduce(state: State, action: Action, limitBytes: number): State {
  if (action.kind === "clear") return EMPTY;

  if (action.kind === "remove") {
    return {
      parts: state.parts.filter((_, index) => index !== action.index),
      refused: [],
      conversionFailure: null,
    };
  }

  if (action.kind === "conversion_failed") {
    return {
      parts: state.parts,
      refused: action.oversized,
      conversionFailure: action.message,
    };
  }

  const admission = admitAttachments(state.parts, action.parts, limitBytes);

  return {
    parts: admission.parts,
    refused: [...action.oversized, ...admission.refused],
    conversionFailure: null,
  };
}

export interface PendingAttachments {
  readonly parts: readonly FileUIPart[];
  readonly refusal: string | null;
  readonly add: (files: FileList | null | undefined) => void;
  readonly offer: (parts: readonly FileUIPart[]) => void;
  readonly remove: (index: number) => void;
  readonly clear: () => void;
}

interface ConversionTask {
  promise: Promise<Exit.Exit<void>> | null;
}

export function usePendingAttachments(limitBytes: number): PendingAttachments {
  const [state, dispatch] = useReducer(
    (current: State, action: Action) => reduce(current, action, limitBytes),
    EMPTY,
  );

  const conversionGeneration = useRef(0);
  const nextConversionTaskId = useRef(0);
  const conversionTasks = useRef(new Map<number, ConversionTask>());
  useEffect(() => () => {
    conversionGeneration.current += 1;
  }, []);

  const add = useCallback((files: FileList | null | undefined): void => {
    if (!files || files.length === 0) return;
    const candidates = [...files];
    const oversized = candidates.filter((file) => file.size > limitBytes).map((file) => file.name);
    const convertible = candidates.filter((file) => file.size <= limitBytes);

    if (convertible.length === 0) {
      dispatch({ kind: "offer", parts: [], oversized });

      return;
    }

    // Materialize now: FileList empties when the input is cleared, dataTransfer when the handler returns.
    const generation = conversionGeneration.current;
    const taskId = ++nextConversionTaskId.current;
    const owner: ConversionTask = { promise: null };
    conversionTasks.current.set(taskId, owner);
    owner.promise = hold(Effect.gen(function* () {
      const thrown = yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
        const transfer = new DataTransfer();

        for (const file of convertible) transfer.items.add(file);
        const parts = yield* Effect.promise(() => convertFileListToFileUIParts(transfer.files));

        if (generation === conversionGeneration.current) dispatch({ kind: "offer", parts, oversized });

        return null;
      }), (failed) => Effect.succeed({ cause: Cause.squash(failed) })), Effect.sync(() => {
        if (conversionTasks.current.get(taskId) === owner) conversionTasks.current.delete(taskId);
      }));

      if (thrown === null || generation !== conversionGeneration.current) return;
      const names = convertible.map((file) => file.name).join(", ");
      const reason = renderThrownChain(thrown);
      diagnostics.event('attachments.conversion_failed', { names, reason });
      dispatch({ kind: "conversion_failed", oversized, message: `Could not read ${names}: ${reason}` });
    }));
  }, [limitBytes]);

  const offer = useCallback((parts: readonly FileUIPart[]) => { dispatch({ kind: "offer", parts, oversized: [] }); }, []);
  const remove = useCallback((index: number) => { dispatch({ kind: "remove", index }); }, []);
  const clear = useCallback(() => { dispatch({ kind: "clear" }); }, []);

  const refusal = useMemo(() => {
    const capacityRefusal = state.refused.length === 0 ? null : (
      `A message can carry ${String(limitBytes / (1024 * 1024))} MB of attachments. `
      + `${state.refused.join(", ")} did not fit. `
      + `Upload larger files in the Files tab.`
    );

    if (state.conversionFailure === null) return capacityRefusal;

    return capacityRefusal === null
      ? state.conversionFailure
      : `${capacityRefusal} ${state.conversionFailure}`;
  }, [limitBytes, state.conversionFailure, state.refused]);

  return { parts: state.parts, refusal, add, offer, remove, clear };
}
