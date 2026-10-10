/**
 * The account's memory as one resource the shell owns: seeded by a read, and read whole again on each account socket
 * frame, since a proposal decided anywhere can keep a fact or a note. A frame's proposals show at once; the read
 * that follows brings the facts and notes. Settings shows all of it and the attention stack what waits, both from
 * this one owner.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { Cause, Effect } from "effect";
import type { AccountMemoryProposal } from "@kinu.run/core";
import { detach } from "@kinu.run/core/obs";
import { getAccountMemory, type AccountMemoryState } from "@/lib/user-api";
import { lastValue, loadFailed, loadSucceeded, type AsyncResource } from "@/hooks/use-async-resource";

export interface AccountMemory {
  /** The whole memory, as Settings shows it; what waits is always the newest the account sent. */
  readonly resource: AsyncResource<AccountMemoryState>;
  /** What waits on the owner: the newest frame's, else the read's; null before either has answered. */
  readonly pending: readonly AccountMemoryProposal[] | null;
  /** Reads the memory again: after a change the owner made here, or a read that failed. */
  readonly reload: () => void;
  /** The account socket's frame of what waits: shown at once, and the whole memory read again behind it. */
  readonly framed: (pending: readonly AccountMemoryProposal[]) => void;
}

interface State {
  readonly resource: AsyncResource<AccountMemoryState>;
  readonly pending: readonly AccountMemoryProposal[] | null;
}

type Action =
  /** `framedSince`: a frame landed while the read was out, and is newer than the read's own list. */
  | { readonly kind: "read"; readonly memory: AccountMemoryState; readonly framedSince: boolean }
  | { readonly kind: "failed"; readonly cause: unknown }
  | { readonly kind: "framed"; readonly pending: readonly AccountMemoryProposal[] };

function reduce(state: State, action: Action): State {
  if (action.kind === "failed") return { ...state, resource: loadFailed(state.resource, { cause: action.cause }) };

  if (action.kind === "framed") {
    const memory = lastValue(state.resource);

    return {
      pending: action.pending,
      resource: memory === null || state.resource.status !== "ready" ? state.resource : loadSucceeded({ ...memory, pending: [...action.pending] }),
    };
  }

  const pending = action.framedSince && state.pending !== null ? state.pending : action.memory.pending;

  return { pending, resource: loadSucceeded({ ...action.memory, pending: [...pending] }) };
}

const INITIAL: State = { resource: { status: "loading" }, pending: null };

export function useAccountMemory(): AccountMemory {
  const [state, dispatch] = useReducer(reduce, INITIAL);
  const frames = useRef(0);
  const runs = useRef(0);

  const reload = useCallback((): void => {
    const run = ++runs.current;
    const since = frames.current;

    // Only the newest read publishes, its answer or its failure.
    detach(Effect.matchCause(Effect.promise(getAccountMemory), {
      onSuccess: (memory) => { if (run === runs.current) dispatch({ kind: "read", memory, framedSince: frames.current !== since }); },
      onFailure: (failed) => { if (run === runs.current) dispatch({ kind: "failed", cause: Cause.squash(failed) }); },
    }));
  }, []);

  useEffect(() => {
    reload();

    return () => { runs.current += 1; };
  }, [reload]);

  const framed = useCallback((pending: readonly AccountMemoryProposal[]): void => {
    frames.current += 1;
    dispatch({ kind: "framed", pending });
    reload();
  }, [reload]);

  return useMemo(() => ({
    resource: state.resource, pending: state.pending ?? lastValue(state.resource)?.pending ?? null, reload, framed,
  }), [state, reload, framed]);
}
