/** What the owner and the branches added to a conversation's turns: a rating per answer, and the takes of a turn. */
import { Cause, Effect } from "effect";
import { startTransition, useCallback, useEffect, useState } from "react";
import type { AlternateTakeSet, Rpc, TakePickOutcome } from "@kinu.run/core";
import { settle } from "@kinu.run/core/obs";
import { describeError } from "@/hooks/use-async-resource";

type Rating = "positive" | "negative";

export interface TurnAnnotations {
  readonly feedback: Readonly<Record<string, Rating>>;
  readonly rate: (messageId: string, rating: Rating | null) => Promise<void>;
  readonly takes: Readonly<Record<string, AlternateTakeSet>>;
  readonly pickTake: (takeId: string, nodeId: string) => Promise<TakePickOutcome>;
}

/**
 * Ratings are read once connected and kept only once the workspace took them, so the toggle never misreports scoring
 * input. Takes are read whenever no turn runs, and again when a branch settles: a settled `/branch` redirect may have
 * produced a fresh set. A failed read is reported under its source, and cleared by the next that lands.
 */
export function useTurnAnnotations({ rpc, connected, live, settledBranches, report }: {
  rpc: Rpc;
  connected: boolean;
  live: boolean;
  settledBranches: number;
  report: (source: "feedback" | "takes", message: string | null) => void;
}): TurnAnnotations {
  const [feedback, setFeedback] = useState<Record<string, Rating>>({});
  const [takes, setTakes] = useState<Record<string, AlternateTakeSet>>({});

  const failed = useCallback((source: "feedback" | "takes") => (cause: Cause.Cause<unknown>) => Effect.sync(() => {
    report(source, describeError({ cause: Cause.squash(cause) }));
  }), [report]);

  useEffect(() => {
    if (!connected) return;
    startTransition(() => settle(Effect.catchCause(Effect.gen(function* () {
      setFeedback(yield* Effect.promise(async () => rpc<Record<string, Rating>>("listTurnFeedback")));
      report("feedback", null);
    }), failed("feedback"))));
  }, [connected, rpc, report, failed]);

  useEffect(() => {
    if (!connected || live) return;
    startTransition(() => settle(Effect.catchCause(Effect.gen(function* () {
      setTakes(yield* Effect.promise(async () => rpc<Record<string, AlternateTakeSet>>("listAlternateTakes")));
      report("takes", null);
    }), failed("takes"))));
  }, [connected, live, rpc, settledBranches, report, failed]);

  const rate = useCallback(async (messageId: string, rating: Rating | null) => {
    await rpc("setTurnFeedback", [messageId, rating]);
    setFeedback((prev) => {
      const next = { ...prev };

      if (rating) next[messageId] = rating; else delete next[messageId];

      return next;
    });
  }, [rpc]);

  const pickTake = useCallback(async (takeId: string, nodeId: string): Promise<TakePickOutcome> => {
    const result = await rpc<TakePickOutcome>("pickAlternateTake", [takeId, nodeId]);
    const { turnId } = result.set;

    if (turnId) setTakes((prev) => ({ ...prev, [turnId]: result.set }));

    return result;
  }, [rpc]);

  return { feedback, rate, takes, pickTake };
}
