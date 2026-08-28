import { forkTransferFrames, nanoid, FORK_FRAME_BYTES } from '@kinu.run/core';
import type { ForkFrame } from '@kinu.run/core';
import type { SqlExecutor, ForkFileSource } from '@kinu.run/core';
import type { UserCaller } from './workspace-capability';
import type { WorkspaceEntry } from './user-do';

export interface CloudForkRegistry {
  reserveWorkspace(caller: UserCaller, name: string, displayName?: string): Promise<{
    entry: WorkspaceEntry; reserved: boolean;
  }>;
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
  /** The workspace plane, with the ranged read the wire streams each inherited
   *  file through. */
  vfs: ForkFileSource;
  untilMessageId: string;
}

/** Register a pending roster name, stream source frames straight to the target,
 * then publish that exact reservation only after the target committed. */
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

  const destroy = async <Cause>(cause: Cause): Promise<never> => {
    try { await input.registry.removeWorkspace(input.caller, input.name, input.ownerUserId); }
    catch (rollback) {
      throw new AggregateError([cause, rollback], `fork creation failed and cleanup also failed for "${input.name}"`, { cause: rollback });
    }
    throw cause;
  };

  let landed: Extract<ForkFrameAck, { status: 'published' }> | null = null;
  try {
    for await (const frame of forkTransferFrames({
      ...input.source,
      transferId: nanoid(),
      targetAuthority: 'pane',
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
    }
  } catch (cause) { return destroy(cause); }
  if (!landed) return destroy(new Error(`fork transfer to "${input.name}" ended before the target published it`));

  try {
    await input.registry.publishWorkspaceReservation(
      input.caller, input.name, registration.entry.createdAt, landed.capabilityHash,
    );
    return { workspaceId: landed.agentId, forkPointMs: landed.forkPointMs };
  } catch (cause) { return destroy(cause); }
}
