/** `attach()` takes no deadline: `racedRestoreSteps` budgets the whole restore around it. */

/** `tick` may decline when nothing changed or the minimum interval has not elapsed.
 *  `quiesce` declines only when nothing changed: the interval is efficiency, not correctness. */
export type CheckpointKind = 'tick' | 'quiesce';

/** `empty` is the normal first start, not a failure; `already-attached` makes attach re-callable.
 *  A runtime array so a suite asserts every kind is exercised; a new kind turns it red. */
export const ATTACH_OUTCOME_KINDS = ['empty', 'attached', 'already-attached'] as const;

export interface AttachOutcome {
  readonly kind: (typeof ATTACH_OUTCOME_KINDS)[number];
  /** One line, ids and counts only, for the event line and the bench driver.
   *  Never a key, a URL, or a credential. */
  readonly detail: string;
}

/** `failed` is returned, not thrown: the alarm loop reduces a throwing scheduled callback
 *  to a console line, so the failure must reach the caller as a value to become an incident. */
export const CHECKPOINT_OUTCOME_KINDS = ['skipped', 'committed', 'failed'] as const;

export interface CheckpointOutcome {
  readonly kind: (typeof CHECKPOINT_OUTCOME_KINDS)[number];
  /** Present for `skipped` (why it declined) and `failed` (what went wrong). */
  readonly reason: string | undefined;
  /** Durable bytes the store holds after a `committed` commit, not bytes this commit wrote;
   *  required so a caller can assert success against the prefix, not take it on trust. */
  readonly bytes: number | undefined;
  /** Bytes this checkpoint moved: `skipped` reports 0; `failed` is `undefined` (objects may have
   *  landed). Differencing `bytes` is invalid: held bytes fall when a generation is superseded. */
  readonly movedBytes: number | undefined;
}

/** The failure stamp the durable state row carries, so a repeatedly failing
 *  checkpoint stays visible across restarts. */
interface RecordedFailure {
  readonly at: number;
  readonly reason: string;
}

type StampableRow = { readonly lastFailure: RecordedFailure | undefined };

export interface FailureStampDeps<S> {
  readonly writeState: (next: S) => Promise<void>;
  readonly log: (line: string) => void;
  readonly now: () => number;
}

/** Best effort: a rejected stamp would make a scheduled callback throw, or let a caller's
 *  catch rewrite the pre-commit record over the published one. */
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

/** Log first: it cannot fail, and a storage failure could suppress a later line.
 *  `bytes`/`movedBytes` are `undefined`, not 0: a throw mid-flight may have landed objects. */
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
  /** Must be idempotent on an attached container: the start hook can fire more than once per start.
   *  Throws only when stored state exists but cannot be served; an empty workspace is worse. */
  attach(): Promise<AttachOutcome>;
  /** Does not throw for an ordinary failure, including a refused failure stamp: recording is
   *  best effort (`stampFailure`), the classification stays the operation's own. */
  checkpoint(kind: CheckpointKind): Promise<CheckpointOutcome>;
  /** Releases SDK-tracked live mounts before the container stops. A property, not a method:
   *  the metered wrapper and conformance suite call it through a receiver of their choosing. */
  detach?: () => Promise<void>;
  /** Drop the durable bytes and the record pointing at them. Called when the
   *  box itself is deleted. A property for the same reason as `detach`. */
  discard: () => Promise<void>;
}

/** Same bucket twice: `mountBucket` takes the binding name and resolves it in the container;
 *  `bucket` is resolved because the snapshot chain reads/writes R2 from the Durable Object. */
export interface DevboxStore {
  readonly binding: string;
  readonly bucket: R2Bucket;
}

/** One format per class: bytes written by one format are unreadable by another, so
 *  the choice is carried as a name and a box records which format its bytes are in. */
export type DevboxStrategyName = 'snapshot-chain';

/** Measured basis: `bench/measure-first/DECISIVE-2026-09-05.md`; D27 stopped the search. */
export const DEFAULT_DEVBOX_STRATEGY: DevboxStrategyName = 'snapshot-chain';

export function parseDevboxStrategyName(value: string | null | undefined): DevboxStrategyName | null {
  return value === 'snapshot-chain' ? value : null;
}

/** The directory a devbox makes durable, and every command's default working directory. */
export const DEVBOX_WORKDIR = '/workspace';

/** In the SDK's backup-directory allowlist, so the container may touch it. */
export const DEVBOX_RUNTIME_DIR = '/var/tmp/devbox';

/** A stored row may come from any release of this package, so this types only the JSON medium;
 *  the schema that parses it states the contract. */
export type StoredValue =
  | string | number | boolean | null | undefined
  | readonly StoredValue[]
  | { readonly [key: string]: StoredValue };
