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
export interface CheckpointOutcome {
  readonly kind: 'skipped' | 'committed' | 'failed';
  /** Present for `skipped` (why it declined) and `failed` (what went wrong). */
  readonly reason: string | undefined;
  /** Durable bytes the store holds after a `committed` commit, not bytes this commit wrote;
   *  required so a caller can assert success against the prefix, not take it on trust. */
  readonly bytes: number | undefined;
  /** Bytes this checkpoint moved: `skipped` reports 0; `failed` is `undefined` (objects may have
   *  landed). Differencing `bytes` is invalid: held bytes fall when a generation is superseded. */
  readonly movedBytes: number | undefined;
}

export interface DevboxStorage {
  /** Must be idempotent on an attached container: the start hook can fire more than once per start.
   *  Throws only when stored state exists but cannot be served; an empty workspace is worse. */
  attach(): Promise<AttachOutcome>;
  /** Does not throw for an ordinary failure, including a refused failure stamp: recording is
   *  best effort, the classification stays the operation's own. */
  checkpoint(kind: CheckpointKind): Promise<CheckpointOutcome>;
  /** Releases SDK-tracked live mounts before the container stops. A property, not a method:
   *  the metered wrapper and conformance suite call it through a receiver of their choosing. */
  detach?: () => Promise<void>;
  /** Drop the durable bytes and the record pointing at them. Called when the
   *  box itself is deleted. A property for the same reason as `detach`. */
  discard: () => Promise<void>;
}

/** `binding` names `bucket` in the Worker's env: the store gateway serves the container from it (D41). */
export interface DevboxStore {
  readonly binding: string;
  readonly bucket: R2Bucket;
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
