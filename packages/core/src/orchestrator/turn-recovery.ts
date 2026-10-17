/**
 * Whether a turn a dead process left open may run on: the one decision for the recovery sweep and for the session
 * re-opening its own open run. A turn the decision closes is settled here; its run is the caller's to close.
 */
import type { ModelMessage } from 'ai';
import { Effect } from 'effect';
import * as v from 'valibot';
import { KinuError } from '../obs/error';
import { attempt, diagnostics } from '../obs/index';
import type { AgentStores } from '../state/agent-stores';
import { sha256Hex } from '../safety/argument-digest';
import { cutsThrough, verifyClaimedProgram, type ClaimOutcome, type ContextRevision, type StoredActorClaim } from './actor-claims';
import { recordRecoverySettled, sameBuildOf } from './turn-recovery-events';
import type { RunEventRecorder } from '../events/recorder';
import type { ReportedTurn } from '../subordinates/turn-reports';

type ClosedBy = 'stopped' | 'answered' | 'record_unreadable' | 'stalled' | 'unverified';

/**
 * `continue`: owed and verified, or never claimed, so it consumed nothing. `active`: a live turn here opened while this
 * read, so this decides nothing. `closed`: settled already (`settled`), or by this decision; `out_of_memory` with the
 * words its owner reads, as a failure.
 */
export type InterruptedTurnVerdict =
  | { readonly kind: 'continue' }
  | { readonly kind: 'active' }
  | { readonly kind: 'closed'; readonly cause: 'settled' | ClosedBy }
  | { readonly kind: 'closed'; readonly cause: 'out_of_memory'; readonly reason: string };

export interface InterruptedTurn {
  /** Reads retained program bytes; recovery never needs a composed execution seat. */
  readonly source: (version: number) => Promise<string | null>;
  readonly stores: Pick<AgentStores, 'claims' | 'history'>;
  /** Where a Stop is recorded (`stop_requested`); none read, none found. */
  readonly runs: Pick<RunEventRecorder, 'stopRequested'> | null;
  /** Whether the turn already gave its hirer the report that answers its assignment; absent where nothing is hired. */
  readonly answered?: (turn: ReportedTurn) => boolean;
  readonly installedBuild: string | null;
  readonly workspace: string;
  readonly actor: string;
  readonly runId: string;
  readonly claim: StoredActorClaim | null;
  /** Read between the awaits: a turn that opened meanwhile owns the claim. */
  readonly turnOpen: () => boolean;
  /** The decider that fails the turn for its memory ({@link OUT_OF_MEMORY_CUTS}): the turn's own session, as it re-opens
   *  the run, so the run ends once, with the words, told to whoever waits on it. The sweep leaves the turn to it. */
  readonly endsOutOfMemory?: true;
}

/** Call only with recovery authority. Verified claims stay owed: bytes alone do not prove the turn finished. */
export function decideInterruptedTurn(turn: InterruptedTurn): Effect.Effect<InterruptedTurnVerdict> {
  return Effect.gen(function* () {
    const { claim, stores } = turn;

    if (claim?.outcome !== undefined && claim.outcome !== null) return { kind: 'closed', cause: 'settled' } as const;

    if (turn.turnOpen()) return { kind: 'active' } as const;
    const stopped = turn.runs?.stopRequested(turn.runId) === true;

    const settled = (open: StoredActorClaim, outcome: ClaimOutcome, cause: ClosedBy | 'out_of_memory'): void => {
      stores.claims.settleRecovered(open.turnId, open.epoch, outcome);
      recordRecoverySettled({ workspace: turn.workspace, actor: turn.actor, cause, sameBuild: sameBuildOf(open.program?.build ?? null, turn.installedBuild) });
    };

    const closed = (open: StoredActorClaim, outcome: ClaimOutcome, cause: ClosedBy): InterruptedTurnVerdict => {
      settled(open, outcome, cause);

      return { kind: 'closed', cause };
    };

    // Its isolate ran out of memory each time the step ran: running it again would die again, so it ends here.
    if (claim !== null && !stopped && diedOfMemory(turn)) {
      const reason = outOfMemoryReason(yield* consumedEvidence(stores, claim));

      settled(claim, 'error', 'out_of_memory');

      return { kind: 'closed', cause: 'out_of_memory', reason } as const;
    }

    // Never claimed, or claimed only to prepare: it consumed nothing, so it prepares again under the next epoch.
    if (claim === null || claim.status === 'preparing') {
      if (!stopped) return { kind: 'continue' } as const;

      return claim === null ? { kind: 'closed', cause: 'stopped' } as const : closed(claim, 'aborted', 'stopped');
    }

    // The outcome the stopped turn would have settled its claim with.
    if (stopped) return closed(claim, 'aborted', 'stopped');

    // Its hirer holds the answer already: run again, it would answer a closed assignment a second time.
    if (turn.answered?.(claim) === true) return closed(claim, 'indeterminate', 'answered');

    const evidence = yield* consumedEvidence(stores, claim);

    if (turn.turnOpen()) return { kind: 'active' } as const;

    if ('failure' in evidence) {
      diagnostics.failure('actor.turn_record_unreadable', evidence.failure, { actor: turn.actor, turn: claim.turnId });

      return closed(claim, 'error', 'record_unreadable');
    }

    const verdict = yield* Effect.promise(() => verifyClaimedProgram(
      claim,
      turn.source,
      (source) => sha256Hex(source),
      evidence.context,
    ));

    const cuts = verdict.kind === 'verified' ? cutsOf(stores, claim, turn.installedBuild) : { work: 0, provider: 0 };

    if (turn.turnOpen()) return { kind: 'active' } as const;

    if (cuts.work >= POISON_WORK_CUTS || cuts.provider >= STALLED_PROVIDER_CUTS) {
      diagnostics.event('actor.turn_stalled', { actor: turn.actor, turn: claim.turnId, epoch: claim.epoch, workCuts: cuts.work, providerCuts: cuts.provider });

      return closed(claim, 'error', 'stalled');
    }

    // A host that stamps no build (the CLI) recorded none at admission either: nothing to compare, so nothing changed.
    if (verdict.kind === 'verified' || (verdict.kind === 'build_unknown' && turn.installedBuild === null)) return { kind: 'continue' } as const;

    return closed(claim, 'indeterminate', 'unverified');
  });
}

/** The claim's consumed request, or why its own rows cannot be read: a failure no later sweep reads differently. */
function consumedEvidence(stores: Pick<AgentStores, 'claims'>, claim: StoredActorClaim): Effect.Effect<{ readonly context: ContextRevision } | { readonly failure: KinuError }> {
  return attempt({ doing: 'reading the request record of an interrupted turn', otherwise: 'io' }, () => stores.claims.consumedContext(claim.turnId)).pipe(
    // Absent is as unrecoverable as corrupt.
    Effect.map((context) => (context === null ? { failure: new KinuError('missing', 'claimed request evidence is missing') } : { context })),
    Effect.catch((failure) => Effect.succeed({ failure })),
  );
}

/**
 * Cuts inside a step's own work, in a row on one build with no step finishing, that settle the turn instead of running
 * it again: a step that ends its own process (a tool past the CPU or memory limit) would otherwise run forever. A turn
 * must outlast five resets from outside, the bar tardigrade's kill5 sets (2026-10-08: two such resets inside one long
 * step ended Kinu's turn), so the sixth cut in the step's own work is the step's.
 */
const POISON_WORK_CUTS = 6;

/**
 * Cuts while the step waits on the provider, likewise counted, that settle it. None is the step's fault, but a wait can
 * be the turn's: task-j7gjjr's model wait outlasted the workspace's memory and time limits fifteen times in a day
 * (2026-09-25), dropping every tab's socket each time. Twenty covers five outside resets four times over.
 */
const STALLED_PROVIDER_CUTS = 20;

/**
 * Executions of one step whose isolate the platform reported out of memory, on one build with no step finishing between,
 * that end the turn: the second death of the same request says the request does not fit, and one says only that the
 * isolate did not hold it once (other work shares it).
 */
const OUT_OF_MEMORY_CUTS = 2;

/** The dead execution's cuts, itself counted ({@link TurnCut}); a host that stamps no build counts none. */
function cutsOf(stores: Pick<AgentStores, 'claims'>, claim: StoredActorClaim, installedBuild: string | null) {
  const cut = stores.claims.cutOf(claim.turnId);

  if (installedBuild === null || cut === null || cut.epoch !== claim.epoch || cut.build !== installedBuild) return { work: 0, provider: 0, outOfMemory: 0 };

  return cutsThrough(cut);
}

/** Whether the turn's step died of memory each time it ran, for the decider that ends it ({@link InterruptedTurn.endsOutOfMemory}). */
function diedOfMemory(turn: InterruptedTurn): boolean {
  return turn.endsOutOfMemory === true && turn.claim !== null && cutsOf(turn.stores, turn.claim, turn.installedBuild).outOfMemory >= OUT_OF_MEMORY_CUTS;
}

/** What the owner reads of a turn its memory ended: the images its last request carried inline, and their bytes. */
function outOfMemoryReason(evidence: { readonly context: ContextRevision } | { readonly failure: KinuError }): string {
  const images = 'context' in evidence ? imagesIn(evidence.context.messages) : null;

  if (images === null || images.count === 0) return 'this turn ran out of memory each time it ran the same step';

  return `this turn ran out of memory: its context holds ${String(images.count)} image${images.count === 1 ? '' : 's'}, `
    + `${(images.bytes / 1_000_000).toFixed(1)} MB`;
}

/** Image bytes as a message part holds them: base64 text (a data URL's too), the bytes, or a URL, which has none here. */
const ImageBytesSchema = v.union([v.string(), v.instance(Uint8Array), v.instance(ArrayBuffer), v.instance(URL)]);

/** An image a message carries: the user's, or an entry of a tool's result, its bytes held inline or in a `data` carrier. */
const ImagePartSchema = v.union([
  v.object({ type: v.literal('image'), image: ImageBytesSchema }),
  v.object({
    type: v.picklist(['file', 'media', 'image-data', 'file-data']),
    mediaType: v.pipe(v.string(), v.startsWith('image/')),
    data: v.union([ImageBytesSchema, v.object({ type: v.literal('data'), data: ImageBytesSchema }), v.object({ type: v.literal('url') })]),
  }),
]);

type ImagePart = v.InferOutput<typeof ImagePartSchema>;

/** The images `messages` carry, the user's and the tools', with their decoded bytes. */
function imagesIn(messages: readonly ModelMessage[]) {
  const images: ImagePart[] = [];

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;

    for (const part of message.content) {
      const tools = part.type === 'tool-result' && part.output.type === 'content' ? part.output.value : [];

      for (const entry of part.type === 'tool-result' ? tools : [part]) {
        const image = v.safeParse(ImagePartSchema, entry);

        if (image.success) images.push(image.output);
      }
    }
  }

  return { count: images.length, bytes: images.reduce((total, image) => total + imageBytes(image), 0) };
}

/** An image's decoded bytes. */
function imageBytes(image: ImagePart): number {
  const held = image.type === 'image' ? image.image : image.data;

  if (typeof held === 'object' && 'type' in held) return held.type === 'data' ? imageBytes({ type: 'image', image: held.data }) : 0;
  const bytes = held;

  if (bytes instanceof URL) return 0;

  if (typeof bytes !== 'string') return bytes.byteLength;
  const base64 = bytes.startsWith('data:') ? bytes.slice(bytes.indexOf(',') + 1) : bytes;

  return Math.floor(base64.replace(/=+$/u, '').length * 3 / 4);
}
