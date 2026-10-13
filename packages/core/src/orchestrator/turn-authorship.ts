/**
 * Whom a turn answers, decided once for every host (design v2 §1.6, v3 D): set only by the paths that validated it, the
 * owner's send and the owner's decisions (a plan's review, an answer to a question) for the owner, and every other
 * admission for the hirer; stored with the turn's input, and read from there by its reach and its settlement.
 */
import * as v from 'valibot';
import type { JsonObject } from '../utils/json';
import type { TurnAuthorship } from '../types/turn';

export type { TurnAuthorship };

/** Where the admitting path stores it on the turn's input: written there by the path, never taken from a caller. */
const TURN_AUTHORSHIP_METADATA_KEY = 'kinuAuthorship';

const AuthorshipSchema = v.picklist(['owner', 'hirer']);

/** `metadata` with the admitting path's own authorship, over any a caller put there. */
export function stampAuthorship(metadata: JsonObject | undefined, authorship: TurnAuthorship): JsonObject {
  return { ...metadata, [TURN_AUTHORSHIP_METADATA_KEY]: authorship };
}

/** A person's words are the owner's; any other turn is what its admission stored, and the hirer's where it stored none. */
export function turnAuthorship(turn: { readonly kind: 'user' | 'programmatic'; readonly metadata?: JsonObject | undefined }): TurnAuthorship {
  if (turn.kind === 'user') return 'owner';
  const stored = v.safeParse(AuthorshipSchema, turn.metadata?.[TURN_AUTHORSHIP_METADATA_KEY]);

  return stored.success ? stored.output : 'hirer';
}
