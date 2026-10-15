/**
 * A workspace's tile on its owner's roster, pushed as it changes: one push in flight at a time, with every change
 * meanwhile riding it; a tile like the last one pushed is not sent again; and a failure the platform may clear is
 * retried on a backoff, which a durable wake keeps. The workspace object folds the tile and says when it changed;
 * where the tile goes, and how work runs detached, are its host's.
 */
import { Cause, Effect } from 'effect';
import { diagnostics } from '../obs/log';
import { KinuError, toKinuError } from '../obs/error';
import { recoveryBackoffMs } from '../utils/recovery-backoff';
import type { WorkspaceOverview } from './workspace-overview';

export interface OverviewPushHost {
  /** Read per push: the object names itself after its fields are made. */
  readonly workspace: () => string;
  readonly ownerUserId: () => string | null;
  /** The tile as the workspace stands now. */
  readonly fold: () => Promise<WorkspaceOverview>;
  /** Installing the workspace's capability pushes; until then a push waits for it. */
  readonly hasCapability: () => boolean;
  /** A workspace being deleted pushes no tile: its owner's roster drops it, and its capability is about to go. */
  readonly deleting: () => boolean;
  /** Puts the tile on the owner's roster. */
  readonly put: (overview: WorkspaceOverview) => Promise<void>;
  /** Runs a push detached, as the workspace's own background work. */
  readonly detach: (work: Effect.Effect<void>) => void;
  /** Arms the durable wake a retry is owed by. */
  readonly scheduleRetry: (at: number) => Promise<void>;
}

/** The next retry a failed push owes, and how many failed before it. */
interface Retry {
  readonly at: number;
  readonly attempts: number;
}

export class OverviewPush {
  /** The owner's object ignores a repeat. */
  private pushed: string | null = null;

  private dirty = false;

  private pushing = false;

  private readonly settlers: Array<(failure: KinuError | null) => void> = [];

  /** Changes meanwhile ride its push. */
  private retry: Retry | null = null;

  constructor(private readonly host: OverviewPushHost) {}

  /** When a failed push is owed again, if one is. */
  get retryAt(): number | null {
    return this.retry?.at ?? null;
  }

  /** The tile may have moved: pushed now, unless a push is in flight, which takes it, or a retry is not due yet and
   *  `force` does not override it. */
  changed(force = false): void {
    this.dirty = true;

    if (this.pushing || this.host.ownerUserId() === null) return;

    const retry = this.retry;

    if (!force && retry !== null && Date.now() < retry.at) return;
    this.pushing = true;

    // In flight, it owes the wake a failure would arm.
    if (retry !== null) this.retry = { at: Date.now() + recoveryBackoffMs(retry.attempts + 1), attempts: retry.attempts };
    let failed: KinuError | null = null;

    this.host.detach(Effect.ensuring(Effect.catchCause(this.pushes(), (cause) => Effect.gen({ self: this }, function* () {
      this.dirty = true;
      const failure = toKinuError({ doing: "pushing this workspace's tile to its owner's roster", cause: Cause.squash(cause), otherwise: 'unavailable' });
      const attempts = (this.retry?.attempts ?? 0) + 1;
      // A refusal meets the next push.
      const retrying = failure.code === 'unavailable' || failure.code === 'timeout';
      failed = failure;
      const next = retrying ? { at: Date.now() + recoveryBackoffMs(attempts), attempts } : null;
      this.retry = next;
      diagnostics.failure('workspace.overview_push_failed', failure, { workspace: this.host.workspace(), attempts, retrying });

      if (next !== null) yield* Effect.promise(() => this.host.scheduleRetry(next.at));
    })), Effect.sync(() => {
      this.pushing = false;

      for (const settleWaiter of this.settlers.splice(0)) settleWaiter(failed);
    })));
  }

  /** Once its tile moved, or the failure that left the roster behind. */
  async settled(): Promise<KinuError | null> {
    if (!this.pushing) return null;

    return await new Promise<KinuError | null>((resolve) => { this.settlers.push(resolve); });
  }

  /** Every change pushed, until none is left. */
  private pushes(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      while (this.dirty) {
        this.dirty = false;
        const overview = yield* Effect.promise(() => this.host.fold());
        const pushed = JSON.stringify(overview);

        if (pushed === this.pushed) continue;

        if (!this.host.hasCapability()) {
          this.dirty = true;
          break;
        }

        if (this.host.deleting()) break;
        yield* Effect.promise(() => this.host.put(overview));
        this.pushed = pushed;
      }

      this.retry = null;
    });
  }
}
