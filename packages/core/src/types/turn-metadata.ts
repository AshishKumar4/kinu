/**
 * A turn's input metadata, as core reads it: every key the harness stamps on a turn, parsed by one schema into
 * {@link TurnTags}. The raw metadata stays the row's payload; readers take fields off its tags.
 *
 * Two axes say who a turn is from, and both stamps live here. `kinuAuthor` is display: whose words the row shows (the
 * operator's, or the harness's card). `kinuAuthorship` is authority: whose reach the turn runs under (the owner's, or
 * the hirer's). They differ on purpose: an owner's answer to a question resumes as a harness-written row under the
 * owner's authority.
 */
import * as v from 'valibot';
import type { JsonObject } from '../utils/json';
import { TierIdSchema, type TierId } from './profile';
import { OWNER_ANSWER_SIGNAL } from './owner-questions';
import { SIGNAL_ID_METADATA_KEY } from './signals';
import { TurnReasonSchema, type TurnAuthorship, type TurnReason, type WorkMode } from './turn';

/** Who wrote a turn's words, stamped at enqueue. Defaults to harness, so a new event kind never renders as the operator's. */
export const TURN_AUTHOR_METADATA_KEY = 'kinuAuthor';

export type TurnAuthor = 'harness' | 'operator';

/** Where the admitting path stores whom a turn answers: written there by the path, never taken from a caller. */
const TURN_AUTHORSHIP_METADATA_KEY = 'kinuAuthorship';

/** Carries a woken turn's mission scope from the schedule that fired it. */
export const MISSION_LABELS_METADATA_KEY = 'missionLabels';

/** A key whose value is malformed reads as absent: one bad key never hides the others. */
const lenient = <Schema extends v.GenericSchema>(schema: Schema) => v.fallback(v.optional(schema), undefined);

const TurnMetadataSchema = v.looseObject({
  kinuEvent: lenient(v.string()),
  drainTurnId: lenient(v.string()),
  askTurn: lenient(v.string()),
  /** The reason of the turn that asked, which the turn its answer opens runs for. */
  askedReason: lenient(TurnReasonSchema),
  kinuMode: lenient(v.picklist(['plan', 'build'])),
  profile_tier: lenient(TierIdSchema),
  kinuRun: lenient(v.string()),
  [SIGNAL_ID_METADATA_KEY]: lenient(v.string()),
  [TURN_AUTHOR_METADATA_KEY]: lenient(v.picklist(['harness', 'operator'])),
  [TURN_AUTHORSHIP_METADATA_KEY]: lenient(v.picklist(['owner', 'hirer'])),
  [MISSION_LABELS_METADATA_KEY]: lenient(v.array(v.pipe(v.string(), v.nonEmpty()))),
  /** A background job's wake. */
  jobId: lenient(v.string()),
  kind: lenient(v.string()),
  status: lenient(v.string()),
});

/** What core reads off a turn's metadata, each field decided once. */
export interface TurnTags {
  /** The event that drove it; undefined for a person's message. */
  readonly event: string | undefined;
  /** Why the turn runs, as the prompt and the questions it asks name it. */
  readonly reason: TurnReason;
  /** The queued turn a drained delivery answers. */
  readonly drainTurnId: string | undefined;
  /** The turn whose question an owner's answer resumes. */
  readonly askTurn: string | undefined;
  /** Only an explicit, recognized `kinuMode` raises the Plan bar; delegated children inherit it. */
  readonly mode: WorkMode;
  /** The mode its producer chose, if one did. */
  readonly chosenMode: WorkMode | undefined;
  /** The tier a producer pinned, if any. */
  readonly tier: TierId | undefined;
  /** The delivered run a held input is. */
  readonly run: string | undefined;
  /** The card a signal's turn carries ({@link SIGNAL_ID_METADATA_KEY}). */
  readonly signalId: string | undefined;
  /** Whose words its row shows. */
  readonly author: TurnAuthor;
  /** Whose reach it runs under. */
  readonly authorship: TurnAuthorship;
  /** Malformed reads as unscoped. */
  readonly missionLabels: readonly string[];
}

/**
 * The tags of a turn, or of a stored row (no `kind`). A person's words (`kind: 'user'`) are the operator's and the
 * owner's. Otherwise the author is the stamp the row was written with, or the event a machine turn names, and words with
 * neither are a person's own, as their composer shows them before any row is written; the authorship is what its
 * admission stored, and the hirer's where it stored none.
 */
export function turnTags(turn: { readonly kind?: 'user' | 'programmatic'; readonly metadata?: unknown }): TurnTags {
  const parsed = v.safeParse(TurnMetadataSchema, turn.metadata ?? {});
  const metadata = parsed.success ? parsed.output : null;
  const event = metadata?.kinuEvent;
  const person = turn.kind === 'user';
  const signalId = metadata?.[SIGNAL_ID_METADATA_KEY];

  return {
    event,
    reason: turnReason(metadata),
    drainTurnId: metadata?.drainTurnId,
    askTurn: metadata?.askTurn,
    mode: metadata?.kinuMode === 'plan' ? 'plan' : 'build',
    chosenMode: metadata?.kinuMode,
    tier: metadata?.profile_tier,
    run: metadata?.kinuRun,
    signalId: signalId === '' ? undefined : signalId,
    author: person || metadata === null ? 'operator' : metadata[TURN_AUTHOR_METADATA_KEY] ?? (event === undefined ? 'operator' : 'harness'),
    authorship: person ? 'owner' : metadata?.[TURN_AUTHORSHIP_METADATA_KEY] ?? 'hirer',
    missionLabels: metadata?.[MISSION_LABELS_METADATA_KEY] ?? [],
  };
}

function turnReason(metadata: v.InferOutput<typeof TurnMetadataSchema> | null): TurnReason {
  const event = metadata?.kinuEvent;

  if (metadata === null || event === undefined || event === '') return { provenance: 'chat' };

  // The turn an answer starts runs for the asking turn's reason: it continues that turn, from its call.
  if (event === OWNER_ANSWER_SIGNAL) return metadata.askedReason ?? { provenance: 'chat' };

  if (event !== 'background_job') return { provenance: 'signal', event };
  const { jobId, kind, status } = metadata;

  return { provenance: 'background_resume', job: jobId !== undefined && kind !== undefined && status !== undefined ? `job ${jobId}, ${kind}, ${status}` : null };
}

/** Stamp at the row-writing seam. Idempotent; a producer's declared author wins. */
export function stampTurnAuthor(metadata?: JsonObject): JsonObject {
  const declared = v.safeParse(TurnMetadataSchema, metadata ?? {});

  return { ...metadata, [TURN_AUTHOR_METADATA_KEY]: (declared.success ? declared.output[TURN_AUTHOR_METADATA_KEY] : undefined) ?? 'harness' };
}

/** A turn's metadata as its row is written: a person's words stamped the operator's, any other the harness's unless
 *  its producer declared otherwise. */
export function authoredTurnMetadata(item: { readonly kind: 'user' | 'programmatic'; readonly metadata?: JsonObject }): JsonObject {
  return item.kind === 'user' ? { ...item.metadata, [TURN_AUTHOR_METADATA_KEY]: 'operator' } : stampTurnAuthor(item.metadata);
}

/** `metadata` with the admitting path's own authorship, over any a caller put there. */
export function stampAuthorship(metadata: JsonObject | undefined, authorship: TurnAuthorship): JsonObject {
  return { ...metadata, [TURN_AUTHORSHIP_METADATA_KEY]: authorship };
}
