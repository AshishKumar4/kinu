/**
 * Whether a turn is live, and what the surface may offer because of it.
 *
 * There were three answers to "is a turn running" and the chat showed two of
 * them at once. The composer asked the client's stream status; the transcript
 * asked `isLast && isStreaming && !isUser`, which is false for every turn that
 * has not written an assistant row yet; and the durable truth — an admitted
 * `actor_turn_claims` row — was read by nobody. A turn admitted and streaming
 * with the user's message last therefore painted a Stop button over a silent
 * thread, which is the reported wedge.
 *
 * So the claim is the fact and this is the one fold over it. A claim the
 * isolate is no longer executing is STRANDED: the turn cannot end by itself,
 * and offering Stop for it is a lie — the surface offers recovery instead.
 */

/** The durable claim, as the workspace snapshot reports it. */
export type TurnClaimState =
  /** No claim this actor admitted is open. */
  | { readonly kind: 'settled' }
  /** A claim is open and this isolate is executing it. */
  | { readonly kind: 'admitted'; readonly turnId: string; readonly claimedAt: number }
  /** A claim is open and nothing is executing it — the isolate that admitted
   *  it died mid-turn. It never settles on its own. */
  | { readonly kind: 'stranded'; readonly turnId: string; readonly claimedAt: number };

export type TurnLiveness =
  /** Nothing is running: the composer sends, the thread paints no indicator. */
  | { readonly kind: 'idle' }
  /** Work is in flight: Stop is offered and the thread carries one indicator. */
  | { readonly kind: 'live'; readonly turnId: string | null }
  /** A claim nobody is executing: recovery is offered, never Stop. */
  | { readonly kind: 'stranded'; readonly turnId: string; readonly claimedAt: number };

/**
 * The one answer both the composer and the transcript read.
 *
 * `streaming` is the client's view of its own socket — tokens arriving, or a
 * request it sent and has not seen answered. It is kept because the claim is
 * snapshot-paced and a turn opens before the next snapshot: a client that sees
 * its own stream is live regardless. It cannot OVERRIDE a stranded claim,
 * though, because "tokens are arriving from a dead isolate" is not a state.
 */
export function turnLiveness(input: { readonly claim: TurnClaimState | null; readonly streaming: boolean }): TurnLiveness {
  const claim = input.claim;

  if (claim?.kind === 'stranded') return { kind: 'stranded', turnId: claim.turnId, claimedAt: claim.claimedAt };

  if (claim?.kind === 'admitted') return { kind: 'live', turnId: claim.turnId };

  return input.streaming ? { kind: 'live', turnId: null } : { kind: 'idle' };
}
