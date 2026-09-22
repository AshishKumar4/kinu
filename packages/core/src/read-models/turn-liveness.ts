/**
 * Whether a turn is live, folded from the durable `actor_turn_claims` claim. A claim the isolate no
 * longer executes is stranded: it cannot end by itself, so the surface offers recovery, never Stop.
 */

/** The durable claim, as the workspace snapshot reports it. */
export type TurnClaimState =
  /** No claim this actor admitted is open. */
  | { readonly kind: 'settled' }
  /** A claim is open and this isolate is executing it. */
  | { readonly kind: 'admitted'; readonly turnId: string; readonly claimedAt: number }
  /** Open, but the admitting isolate died mid-turn; it never settles on its own. */
  | { readonly kind: 'stranded'; readonly turnId: string; readonly claimedAt: number };

export type TurnLiveness =
  /** Nothing is running: the composer sends, the thread paints no indicator. */
  | { readonly kind: 'idle' }
  /** Work is in flight: Stop is offered and the thread carries one indicator. */
  | { readonly kind: 'live'; readonly turnId: string | null }
  /** A claim nobody is executing: recovery is offered, never Stop. */
  | { readonly kind: 'stranded'; readonly turnId: string; readonly claimedAt: number };

/** `streaming` (the client's own socket) covers a turn opened before the next snapshot, but never
 * overrides a stranded claim. */
export function turnLiveness(input: { readonly claim: TurnClaimState | null; readonly streaming: boolean }): TurnLiveness {
  const claim = input.claim;

  if (claim?.kind === 'stranded') return { kind: 'stranded', turnId: claim.turnId, claimedAt: claim.claimedAt };

  if (claim?.kind === 'admitted') return { kind: 'live', turnId: claim.turnId };

  return input.streaming ? { kind: 'live', turnId: null } : { kind: 'idle' };
}
