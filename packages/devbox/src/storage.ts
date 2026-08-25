/**
 * The one storage seam.
 *
 * A devbox runs on a container whose disk is ephemeral. Something has to make
 * the disk look permanent, and there is more than one defensible way to do it,
 * so the choice is a seam rather than a branch. The seam is three methods
 * because three is what the strategies need:
 *
 *   attach      — make the durable bytes readable at the work directory
 *   checkpoint  — commit what changed since the last commit
 *   discard     — forget the durable bytes entirely
 *
 * `attach()` takes no deadline. The container-start hook is what has a budget,
 * and `withContainerStartDeadline` in lifecycle.ts applies it around the whole attach.
 * No strategy would read a deadline argument, so none gets one.
 */

/**
 * Why a checkpoint is happening. The strategies read it differently and
 * those readings are real, so the caller states the occasion and the strategy
 * decides what it means.
 *
 * `tick`    — the periodic commit. May decline: nothing changed, or the
 *             minimum interval has not elapsed.
 * `quiesce` — the last commit before the container stops. May still decline
 *             when nothing changed, but never because of the interval: the
 *             container is about to go away and the interval is an efficiency
 *             rule, not a correctness one.
 */
export type CheckpointKind = 'tick' | 'quiesce';

/**
 * What an attach did.
 *
 * `empty` means there is nothing stored yet, which is the normal first start
 * and not a failure. `already-attached` means the work directory was already
 * backed by durable bytes, which is what makes attach safe to call again — the
 * container-start hook fires at least once per start.
 *
 * A runtime array rather than a bare union, so a suite can assert its own
 * denominator: a kind nobody exercised is a decision nobody tested, and adding
 * one has to turn a suite red rather than pass silently.
 */
export const ATTACH_OUTCOME_KINDS = ['empty', 'attached', 'already-attached'] as const;
export type AttachOutcomeKind = (typeof ATTACH_OUTCOME_KINDS)[number];

export interface AttachOutcome {
  readonly kind: AttachOutcomeKind;
  /** One line, ids and counts only, for the event line and the bench driver.
   *  Never a key, a URL, or a credential. */
  readonly detail: string;
}

/** What a checkpoint did. `failed` is returned rather than thrown: a scheduled
 *  callback that throws is reduced to a console line by the alarm loop, so the
 *  failure has to travel as a value the caller can turn into an incident.
 *  Enumerated for the same reason as the attach kinds. */
export const CHECKPOINT_OUTCOME_KINDS = ['skipped', 'committed', 'failed'] as const;
export type CheckpointOutcomeKind = (typeof CHECKPOINT_OUTCOME_KINDS)[number];

export interface CheckpointOutcome {
  readonly kind: CheckpointOutcomeKind;
  /** Present for `skipped` (why it declined) and `failed` (what went wrong). */
  readonly reason: string | undefined;
  /**
   * Durable bytes this box holds after the commit, for `committed` only.
   *
   * ONE QUANTITY, both strategies. It used to be "bytes this commit wrote",
   * which the snapshot chain answered with its new layer's size and r2fs
   * answered with the size of everything the prefix holds — the same field
   * naming two different measurements, so a caller comparing two strategies
   * compared nothing. r2fs cannot answer the first question at all: s3fs
   * uploads a file when its last handle closes, so there is no commit boundary
   * to attribute bytes to. The chain can answer the second, and does.
   *
   * Required rather than decorative. A commit that reports success without a
   * byte count is indistinguishable from a commit that archived nothing, and
   * that is not hypothetical: a live container answered a forced checkpoint
   * with a success-shaped result while its work directory was not attached at
   * all and no object was ever written. A number a caller can assert against
   * the store is what makes the difference observable.
   */
  readonly bytes: number | undefined;
  /**
   * Bytes THIS checkpoint moved into the store, where that is a question the
   * strategy can answer. `undefined` means it cannot, not that it moved none.
   *
   * THREE ANSWERS, AND THEY ARE DIFFERENT CLAIMS. A `committed` outcome
   * reports what it moved. A `skipped` outcome reports 0: a skip KNOWS it
   * moved nothing, and that is measurable rather than unanswerable. A `failed`
   * outcome reports `undefined`, because a checkpoint that threw mid-flight may
   * have landed objects before it failed, so 0 there would assert something the
   * path cannot know. Collapsing the last two onto one value is the ambiguity
   * this field exists to avoid.
   *
   * A SECOND QUANTITY, deliberately, after refusing one earlier in this
   * package's life. The refusal was right at the time — two strategies, no
   * consumer, and a field naming what another field measures is decoration.
   * Both halves of that changed. There are three strategies now, and a caller
   * was found DERIVING this number by differencing consecutive `bytes`
   * readings, which is invalid across a fold or a rebase: it produced NEGATIVE
   * per-tick costs on two ticks of a real run, because held bytes legitimately
   * fall when a generation is superseded. A consumer already computing a
   * quantity, and computing it wrongly because the interface withheld it, is
   * the bar for adding a field.
   *
   * `bytes` is unchanged and stays the comparable cross-strategy figure. This
   * one is not comparable and is not meant to be: r2fs answers `undefined`
   * because s3fs uploads a file when its last handle closes, so there is no
   * commit boundary to attribute bytes to — the same asymmetry `bytes` above
   * records, stated once more where it would otherwise read as a gap.
   */
  readonly movedBytes: number | undefined;
}

/** The failure stamp both strategies carry on their durable state row, so a
 *  repeatedly failing checkpoint stays visible across restarts. */
export interface RecordedFailure {
  readonly at: number;
  readonly reason: string;
}

/**
 * Write a checkpoint failure down, then return it as a value.
 *
 * A scheduled callback reduces a throw to a console line, so a failure that
 * matters has to be something the caller can turn into an incident. One
 * implementation for every strategy: two copies of this body drifted once.
 *
 * `bytes`/`movedBytes` are `undefined`, not 0: a checkpoint that threw
 * mid-flight may have landed objects before it failed, so "how much moved" is
 * genuinely unanswerable here. Reporting 0 would assert nothing moved, which
 * is a stronger claim than this path can make.
 */
export async function recordCheckpointFailure<S extends { readonly lastFailure: RecordedFailure | undefined }>(
  deps: {
    readonly writeState: (next: S) => Promise<void>;
    readonly log: (line: string) => void;
    readonly now: () => number;
  },
  state: S | null,
  reason: string,
): Promise<CheckpointOutcome> {
  if (state !== null) {
    await deps.writeState({ ...state, lastFailure: { at: deps.now(), reason } });
  }
  deps.log(`${DEVBOX_WORKDIR} checkpoint failed: ${reason}`);
  return { kind: 'failed', reason, bytes: undefined, movedBytes: undefined };
}

export interface DevboxStorage {
  /**
   * Make the durable bytes readable at the work directory.
   *
   * Called inside the container-start hook, so it runs while nothing else can
   * observe the container. Must be safe to call again on an already-attached
   * container. Throws only when stored state exists but cannot be served —
   * an agent handed a silently empty workspace is worse than a failed start.
   */
  attach(): Promise<AttachOutcome>;
  /** Commit what changed. Returns its outcome; does not throw for an ordinary
   *  failure. */
  checkpoint(kind: CheckpointKind): Promise<CheckpointOutcome>;
  /** Drop the durable bytes and the record pointing at them. Called when the
   *  box itself is deleted. */
  discard(): Promise<void>;
}

/** Where a devbox keeps its bytes.
 *
 *  Both fields name the same bucket and both are load-bearing. `binding` is a
 *  wrangler binding NAME because `mountBucket` resolves the binding inside the
 *  container and takes a string. `bucket` is that same binding already
 *  resolved, because the snapshot chain reads and writes objects directly from
 *  the Durable Object. Neither can be derived from the other without a cast
 *  through the generic env. */
export interface DevboxStore {
  readonly binding: string;
  readonly bucket: R2Bucket;
}

/** The three strategies, by name. A devbox picks one and keeps it: bytes written
 *  one way are not readable the other way, so the choice belongs to the class,
 *  not to a call. */
export type DevboxStrategyName = 'snapshot-chain' | 'r2fs' | 'overlay-cas';

export function parseDevboxStrategyName(value: string | null | undefined): DevboxStrategyName | null {
  if (value === 'snapshot-chain' || value === 'r2fs' || value === 'overlay-cas') return value;
  return null;
}

/**
 * The directory a devbox makes durable, and the default working directory for
 * every command it runs.
 *
 * A constant rather than a setting. Nothing in the class, either strategy, the
 * bench app or the tests would set it to anything else, and a setting nobody
 * sets is a setting that goes untested.
 */
export const DEVBOX_WORKDIR = '/workspace';

/**
 * Container-side scratch root for mount points, staging and caches.
 *
 * Under `/var/tmp` because it must survive nothing and it holds binaries'
 * worth of bytes. The Sandbox SDK's own backup-directory allowlist includes
 * this path, so every path a devbox names is one the container may legally
 * touch.
 */
export const DEVBOX_RUNTIME_DIR = '/var/tmp/devbox';

/**
 * Anything durable storage can hand back.
 *
 * A stored row was written by some release of this package, so a reader has to
 * establish what it is. This type states the shape of the medium, which is a
 * JSON value; the schema that parses it states the contract.
 */
export type StoredValue =
  | string | number | boolean | null | undefined
  | readonly StoredValue[]
  | { readonly [key: string]: StoredValue };
