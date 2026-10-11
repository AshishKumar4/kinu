import { useCallback, useEffect, useRef, useState } from "react";
import { Cause, Effect } from "effect";
import { PlanDecisionOutcomeSchema, planHandoffShortfall, type PlanReview, type Rpc } from "@kinu.run/core";
import * as v from "valibot";
import { attempt, KinuError, renderThrownChain, settle } from "@kinu.run/core/obs";

type PlanDecisionKind = "request_changes" | "approve";

type DecisionBusy = "request" | "approve" | null;

export interface PlanDecisionInput {
  readonly plan: PlanReview | null | undefined;
  readonly editable: boolean;
  /** Decided revision whose wake is still owed: retry without resaving. */
  readonly handoffPending: boolean;
  readonly rpc: Rpc;
  /** False prevents the decision. */
  readonly save: () => Promise<boolean>;
  readonly onError: (message: string | null) => void;
}

export interface PlanDecision {
  readonly busy: DecisionBusy;
  /** Synchronous guard before React commits the busy state. */
  readonly inFlight: () => boolean;
  readonly decide: (decision: PlanDecisionKind) => Promise<void>;
}

/** Save the comments before the single decision wake; the review renders what they send. */
export function usePlanDecision({ plan, editable, handoffPending, rpc, save, onError }: PlanDecisionInput): PlanDecision {
  const [busy, setBusy] = useState<DecisionBusy>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    inFlight.current = false;
    setBusy(null);
  }, [plan?.id, plan?.revision]);

  const decide = useCallback(async (decision: PlanDecisionKind) => {
    if (!plan || (!editable && !handoffPending) || inFlight.current) return;
    inFlight.current = true;
    setBusy(decision === "approve" ? "approve" : "request");
    onError(null);

    return settle(Effect.gen(function* () {
      if (editable && !(yield* attempt({ doing: "saving plan annotations", otherwise: "io" }, save))) return;

      const result = v.parse(PlanDecisionOutcomeSchema, yield* attempt({ doing: "deciding a plan review", otherwise: "io" }, () =>
        rpc<unknown>("decidePlanReview", [plan.id, plan.revision, decision])));

      if (!result.ok) return yield* Effect.fail(new KinuError("bad_input", result.error));
      const shortfall = planHandoffShortfall(result);

      if (shortfall !== null) onError(shortfall);
    }).pipe(
      // The owner reads the reason as the call gave it; `attempt`'s account of what the page was doing is ours.
      Effect.catchCause((cause) => Effect.sync(() => {
        const failure = Cause.squash(cause);

        onError(renderThrownChain({ cause: failure instanceof KinuError && failure.cause !== undefined ? failure.cause : failure }));
      })),
      Effect.ensuring(Effect.sync(() => {
        inFlight.current = false;
        setBusy(null);
      })),
    ));
  }, [editable, handoffPending, onError, plan, rpc, save]);

  const isInFlight = useCallback(() => inFlight.current, []);

  return { busy, inFlight: isInFlight, decide };
}