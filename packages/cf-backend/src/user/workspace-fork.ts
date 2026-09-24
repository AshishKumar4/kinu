import { forkTransferFrames, nanoid, FORK_FRAME_BYTES } from '@kinu.run/core';
import type { ForkFrame } from '@kinu.run/core';
import type { SqlExecutor, ForkFileSource, ActorHandle } from '@kinu.run/core';
import type { UserCaller } from '@kinu.run/core';
import type { WorkspaceEntry } from './user-do';

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
  | { ok: true; status: 'staged' }
  | { ok: true; status: 'published'; agentId: string; capabilityHash: string | null; forkPointMs: number }
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
export async function deliverCloudFork(input: {
  registry: CloudForkRegistry;
  caller: UserCaller;
  target: CloudForkTarget;
  name: string;
  source: CloudForkSource;
  ownerUserId: string;
}): Promise<{ workspaceId: string; forkPointMs: number }> {
  const registration = await input.registry.reserveWorkspace(input.caller, input.name, input.name);

  if (!registration.reserved) throw new Error(`agent name already exists: "${input.name}"`);

  const destroy = async (thrown: { cause: unknown }): Promise<never> => {
    try { await input.registry.removeWorkspace(input.caller, input.name, input.ownerUserId); }
    catch (rollback) {
      throw new AggregateError([thrown.cause, rollback], `fork creation failed and cleanup also failed for "${input.name}"`, { cause: rollback });
    }

    throw thrown.cause;
  };

  let landed: Extract<ForkFrameAck, { status: 'published' }> | null = null;

  try {
    for await (const frame of forkTransferFrames({
      ...input.source,
      transferId: nanoid(),
      frameBytes: FORK_FRAME_BYTES,
    })) {
      const ack = await input.target.rawCopyFromFork(input.name, frame, input.ownerUserId);

      if (!ack.ok) {
        const released = await input.registry.releaseWorkspaceReservation(
          input.caller, input.name, registration.entry.createdAt,
        );

        if (!released) throw new Error(`fork target is owned by another user and reservation cleanup failed for "${input.name}"`);
        throw new Error(`agent name already exists: "${input.name}"`);
      }

      if (ack.status === 'published') { landed = ack; break; }

      // false: the name was given to someone else; continuing would stream into a target not ours.
      const held = await input.registry.renewWorkspaceReservation(
        input.caller, input.name, registration.entry.createdAt,
      );

      if (!held) throw new Error(`the reservation for "${input.name}" is no longer held by this transfer`);
    }
  } catch (cause) { return destroy({ cause }); }

  if (!landed) return destroy({ cause: new Error(`fork transfer to "${input.name}" ended before the target published it`) });

  try {
    await input.registry.publishWorkspaceReservation(
      input.caller, input.name, registration.entry.createdAt, landed.capabilityHash,
    );

    return { workspaceId: landed.agentId, forkPointMs: landed.forkPointMs };
  } catch (cause) { return destroy({ cause }); }
}
