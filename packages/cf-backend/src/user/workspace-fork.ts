import { forkTransferFrames, nanoid, FORK_FRAME_BYTES } from '@kinu.run/core';
import type { ForkFrame, ForkFrameReply } from '@kinu.run/core';
import type { SqlExecutor, ForkFileSource, ActorHandle } from '@kinu.run/core';
import type { UserCaller } from '@kinu.run/core';
import type { WorkspaceEntry } from './workspaces';
import { Cause, Effect } from 'effect';
import { KinuError, settle } from '@kinu.run/core/obs';

export interface CloudForkRegistry {
  reserveWorkspace(caller: UserCaller, name: string, displayName?: string): Promise<{
    entry: WorkspaceEntry; reserved: boolean;
  }>;
  /** Extend the reserved name for another lease while the transfer runs; false means it is no longer ours. */
  renewWorkspaceReservation(caller: UserCaller, name: string, createdAt: number): Promise<boolean>;
  releaseWorkspaceReservation(caller: UserCaller, name: string, createdAt: number): Promise<boolean>;
  publishWorkspaceReservation(
    caller: UserCaller, name: string, createdAt: number, capabilityHash: string | null,
  ): Promise<void>;
  removeWorkspace(caller: UserCaller, name: string, ownerUserId: string): Promise<void>;
}

export type ForkFrameAck =
  | ({ ok: true } & (
    | { status: 'staged' }
    /** A page the target could not import yet: send the chunks it lacks, then the page again. */
    | { status: 'want'; hashes: string[] }
    | { status: 'published'; agentId: string; capabilityHash: string | null; forkPointMs: number }
  ))
  | { ok: false; reason: 'owned_by_another_user' };

export interface CloudForkTarget {
  rawCopyFromFork(name: string, frame: ForkFrame, ownerUserId: string): Promise<ForkFrameAck>;
}

export interface CloudForkSource {
  sql: SqlExecutor;
  /**
   * The actor whose transcript is being cut; must be supplied, since conversation rows are keyed per
   * actor and a snapshot without one would carry a sibling's. Same fenced handle the fork point used.
   */
  actor: ActorHandle;
  /** The workspace files the fork inherits, read as one snapshot. */
  vfs: ForkFileSource;
  untilMessageId: string;
  /** Where that actor's payload files live: the carried conversation references
   *  them by absolute path, and the frames carry them relative to it. */
  artifactDirectory: string;
}

/**
 * Reserve the roster name, stream frames to the target, publish only after the target commits.
 * Renewing per acked frame lets a dead sender's reservation lapse instead of wedging the name.
 */
export function deliverCloudFork(input: {
  registry: CloudForkRegistry;
  caller: UserCaller;
  target: CloudForkTarget;
  name: string;
  source: CloudForkSource;
  ownerUserId: string;
}): Promise<{ workspaceId: string; forkPointMs: number }> {
  return settle(Effect.gen(function* () {
    const registration = yield* Effect.promise(() => input.registry.reserveWorkspace(input.caller, input.name, input.name));

    if (!registration.reserved) return yield* new KinuError('bad_input', `agent name already exists: "${input.name}"`);

    const destroy = <E>(failed: Cause.Cause<E>): Effect.Effect<never, E | KinuError> => Effect.andThen(
      Effect.catchCause(
        Effect.promise(() => input.registry.removeWorkspace(input.caller, input.name, input.ownerUserId)),
        (rollback) => Effect.fail(new KinuError('io', `fork creation failed and cleanup also failed for "${input.name}"`, {
          cause: new AggregateError([Cause.squash(failed), Cause.squash(rollback)]),
        })),
      ),
      Effect.failCause(failed),
    );

    const frames = forkTransferFrames({ ...input.source, transferId: nanoid(), frameBytes: FORK_FRAME_BYTES });

    const transferred = Effect.gen(function* () {
      // Each answer goes back into the stream: a page the target wants chunks for is followed by them and itself.
      let reply: ForkFrameReply | undefined;

      for (let next = yield* Effect.promise(() => frames.next()); !next.done; next = yield* Effect.promise(() => frames.next(reply))) {
        const frame = next.value;
        const ack = yield* Effect.promise(() => input.target.rawCopyFromFork(input.name, frame, input.ownerUserId));

        if (!ack.ok) {
          const released = yield* Effect.promise(() => input.registry.releaseWorkspaceReservation(
            input.caller, input.name, registration.entry.createdAt,
          ));

          if (!released) return yield* new KinuError('io', `fork target is owned by another user and reservation cleanup failed for "${input.name}"`);

          return yield* new KinuError('bad_input', `agent name already exists: "${input.name}"`);
        }

        if (ack.status === 'published') return ack;

        reply = ack.status === 'want' ? { want: ack.hashes } : undefined;

        // false: the name was given to someone else; continuing would stream into a target not ours.
        const held = yield* Effect.promise(() => input.registry.renewWorkspaceReservation(
          input.caller, input.name, registration.entry.createdAt,
        ));

        if (!held) return yield* new KinuError('unavailable', `the reservation for "${input.name}" is no longer held by this transfer`);
      }

      return null;
    });

    // Releases the stream's pin on the source however the loop ended.
    const landed = yield* Effect.catchCause(transferred, destroy).pipe(Effect.ensuring(Effect.promise(() => frames.return(undefined))));

    if (!landed) return yield* destroy(Cause.die(new Error(`fork transfer to "${input.name}" ended before the target published it`)));

    return yield* Effect.catchCause(Effect.as(Effect.promise(() => input.registry.publishWorkspaceReservation(
      input.caller, input.name, registration.entry.createdAt, landed.capabilityHash,
    )), { workspaceId: landed.agentId, forkPointMs: landed.forkPointMs }), destroy);
  }));
}
