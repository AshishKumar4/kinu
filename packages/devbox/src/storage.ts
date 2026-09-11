/**
 * The one storage seam.
 *
 * A devbox runs on a container whose disk is ephemeral. Something has to make
 * the disk look permanent, and a box with no store at all is a real state
 * rather than a broken one, so the two live behind an interface. It is three
 * methods because three is what making an ephemeral disk look permanent needs:
 *
 *   attach      — make the durable bytes readable at the work directory
 *   checkpoint  — commit what changed since the last commit
 *   discard     — forget the durable bytes entirely
 *
 * `attach()` takes no deadline. The restoration is what has a budget, and the
 * box spends it around the whole attach: `openStartBudget` opens it and
 * `racedRestoreSteps` in lifecycle.ts is what every step is raced against. The
 * attach itself would not read a deadline argument, so it does not get one.
 */

/**
 * Why a checkpoint is happening. The occasion decides what a commit may
 * decline for, so the caller states the occasion rather than passing flags.
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
   * BYTES HELD, NOT BYTES THIS COMMIT WROTE. Held bytes are what the store
   * actually contains once the commit lands, so a caller can check the number
   * against the prefix; "bytes written" can only be taken on trust.
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
   * Bytes THIS checkpoint moved into the store, where the commit can answer
   * that. `undefined` means it cannot, not that it moved none.
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
   * package's life. A caller was found DERIVING this number by differencing
   * consecutive `bytes` readings, which is invalid across a fold or a rebase:
   * it produced NEGATIVE per-tick costs on two ticks of a real run, because
   * held bytes legitimately fall when a generation is superseded. A consumer
   * already computing a quantity, and computing it wrongly because the
   * interface withheld it, is the bar for adding a field.
   */
  readonly movedBytes: number | undefined;
}

/** The failure stamp the durable state row carries, so a repeatedly failing
 *  checkpoint stays visible across restarts. */
export interface RecordedFailure {
  readonly at: number;
  readonly reason: string;
}

/** A durable row, seen only as the one field a stamp writes. */
type StampableRow = { readonly lastFailure: RecordedFailure | undefined };

/** What writing a failure stamp needs: the row's writer, a clock and a
 *  console. The chain's port set already satisfies it. */
export interface FailureStampDeps<S> {
  readonly writeState: (next: S) => Promise<void>;
  readonly log: (line: string) => void;
  readonly now: () => number;
}

/**
 * Stamp `reason` on the durable row, and treat a failure to write it as a
 * console line.
 *
 * THE STAMP IS A NOTE ABOUT SOMETHING THAT HAS ALREADY HAPPENED, and the writer
 * it needs is the one that just failed. Letting its rejection travel is how one
 * storage failure became two outcomes it must never produce: a scheduled
 * callback that throws instead of a classified answer, and — where the stamp
 * follows a commit — a caller's catch re-writing the record it read BEFORE that
 * commit over the published one. So the stamp is best effort, by construction,
 * everywhere it is written.
 *
 * The cause of the failed write is not rendered here: this module imports
 * nothing, `describeThrown` is the package's one renderer and it reads these
 * types. What an operator needs is on the line above this one — the failure
 * itself, in full — plus the fact that it did not reach the record.
 */
export async function stampFailure<S extends StampableRow>(
  deps: FailureStampDeps<S>,
  state: S,
  reason: string,
): Promise<void> {
  try {
    await deps.writeState({ ...state, lastFailure: { at: deps.now(), reason } });
  } catch {
    deps.log(`${DEVBOX_WORKDIR} that failure could not be stamped on the durable record`);
  }
}

/**
 * Write a checkpoint failure down, then return it as a value.
 *
 * A scheduled callback reduces a throw to a console line, so a failure that
 * matters has to be something the caller can turn into an incident. One
 * implementation, shared: two copies of this body drifted once.
 *
 * THE DIAGNOSTIC GOES FIRST, because it is the only part that cannot fail. It
 * used to follow the stamp, so the one storage failure that could suppress it
 * was a storage failure — the case where a reader most needs the line.
 *
 * `bytes`/`movedBytes` are `undefined`, not 0: a checkpoint that threw
 * mid-flight may have landed objects before it failed, so "how much moved" is
 * genuinely unanswerable here. Reporting 0 would assert nothing moved, which
 * is a stronger claim than this path can make.
 */
export async function recordCheckpointFailure<S extends StampableRow>(
  deps: FailureStampDeps<S>,
  state: S | null,
  reason: string,
): Promise<CheckpointOutcome> {
  deps.log(`${DEVBOX_WORKDIR} checkpoint failed: ${reason}`);
  if (state !== null) await stampFailure(deps, state, reason);
  return { kind: 'failed', reason, bytes: undefined, movedBytes: undefined };
}

export interface DevboxStorage {
  /**
   * Make the durable bytes readable at the work directory.
   *
   * Called from the box's one single-flight restore attempt, on a delivered
   * frame, under the raced budget; the readiness gate admits nobody until it
   * settles. Must be safe to call again on an already-attached container —
   * the container-start hook fires at least once per start and the attempt
   * runs once per instance. Throws only when stored state exists but cannot
   * be served — an agent handed a silently empty workspace is worse than a
   * failed start.
   */
  attach(): Promise<AttachOutcome>;
  /**
   * Commit what changed. Returns its outcome; does not throw for an ordinary
   * failure.
   *
   * A FAILURE TO RECORD A FAILURE IS ORDINARY, and it is the defect this
   * contract was written around: the durable write a refusal is stamped with
   * can be refused by the same storage. So recording is best effort — see
   * {@link stampFailure} — the classification is always the operation's own,
   * and an outcome that had already committed stays `committed`.
   */
  checkpoint(kind: CheckpointKind): Promise<CheckpointOutcome>;
  /** Release live mounts that the host SDK tracks before the container stops. */
  detach?(): Promise<void>;
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

/** The storage strategy, by name. One name, because bytes written by one
 * format are not readable by another: the choice belongs to the class rather
 * than a call, and it is carried as a name so a box records which format its
 * bytes are in. */
export type DevboxStrategyName = 'snapshot-chain';

/** The strategy a devbox uses unless its class says otherwise. The measured
 * basis is `bench/measure-first/DECISIVE-2026-09-05.md`, which states the run
 * and the numbers; a change here is a new decision and gets a new dated report
 * beside that one, never an edit to the incumbent's. That report soundly
 * establishes merkle-pack's whole-tree index property
 * (`src/candidates/merkle-pack/build.ts:768-810`,
 * `src/candidates/merkle-pack/read.ts:296` at the 2026-09-06 tree,
 * fixed-change experiment `local-merklepack-index-1`) and completes no ladder
 * for anything (G3/G6 refused for both arms there): bounded-layers is
 * UNSETTLED (2026-09-09 section), and the 2026-09-10 single-arm run refused
 * admission at the cold attach (gate cancelled at 30 s), so the chunked
 * delta's C3 win (89,664 B in one object, local harness) is not yet a
 * deployed measurement. */
export const DEFAULT_DEVBOX_STRATEGY: DevboxStrategyName = 'snapshot-chain';

export function parseDevboxStrategyName(value: string | null | undefined): DevboxStrategyName | null {
  return value === 'snapshot-chain' ? value : null;
}

/**
 * The directory a devbox makes durable, and the default working directory for
 * every command it runs.
 *
 * A constant rather than a setting. Nothing in the class, any strategy, the
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
