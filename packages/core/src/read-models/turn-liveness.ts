/**
 * Whether a turn is live, folded from the durable `actor_turn_claims` claim. A claim the isolate no
 * longer executes is stranded: it cannot end by itself, so the surface offers recovery, never Stop.
 */
import * as v from 'valibot';

/** The durable claim, as the workspace snapshot and the `turn_claim` frame report it. */
const TurnClaimStateSchema = v.variant('kind', [
  /** No claim this actor admitted is open. */
  v.object({ kind: v.literal('settled') }),
  /** A claim is open and this isolate is executing it. */
  v.object({ kind: v.literal('admitted'), turnId: v.string(), claimedAt: v.number() }),
  /** Open, but the admitting isolate died mid-turn; it never settles on its own. */
  v.object({ kind: v.literal('stranded'), turnId: v.string(), claimedAt: v.number() }),
]);

export type TurnClaimState = v.InferOutput<typeof TurnClaimStateSchema>;

/** Sent to every tab of the root actor when a turn closes or a stranded one is recovered, so no tab keeps the
 *  claim it loaded with. */
export const TURN_CLAIM_FRAME = 'turn_claim';

export const TurnClaimFrameSchema = v.object({ type: v.literal(TURN_CLAIM_FRAME), claim: TurnClaimStateSchema });

export type TurnLiveness =
  /** Nothing is running: the composer sends, the thread paints no indicator. */
  | { readonly kind: 'idle' }
  /** Work is in flight: Stop is offered and the thread carries one indicator. */
  | { readonly kind: 'live'; readonly turnId: string | null }
  /** A claim nobody is executing: recovery is offered, never Stop. */
  | { readonly kind: 'stranded'; readonly turnId: string; readonly claimedAt: number };

/** `streaming` (the client's own socket) covers a turn opened before the claim's frame lands, but never
 * overrides a stranded claim. */
export function turnLiveness(input: { readonly claim: TurnClaimState | null; readonly streaming: boolean }): TurnLiveness {
  const claim = input.claim;

  if (claim?.kind === 'stranded') return { kind: 'stranded', turnId: claim.turnId, claimedAt: claim.claimedAt };

  if (claim?.kind === 'admitted') return { kind: 'live', turnId: claim.turnId };

  return input.streaming ? { kind: 'live', turnId: null } : { kind: 'idle' };
}
