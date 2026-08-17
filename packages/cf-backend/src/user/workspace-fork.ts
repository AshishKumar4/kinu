import type { ForkSnapshot } from '@proteus/core';
import type { UserCaller } from './workspace-capability.js';
import type { WorkspaceEntry } from './user-do.js';

export interface CloudForkRegistry {
  reserveWorkspace(
    caller: UserCaller,
    name: string,
    displayName?: string,
  ): Promise<{ entry: WorkspaceEntry; reserved: boolean }>;
  releaseWorkspaceReservation(caller: UserCaller, name: string, createdAt: number): Promise<boolean>;
  ensureWorkspaceCapability(name: string, presentedHash: string | null): Promise<void>;
  removeWorkspace(caller: UserCaller, name: string, ownerUserId: string): Promise<void>;
}

export interface CloudForkTarget {
  rawCopyFromFork(
    name: string,
    snapshot: ForkSnapshot,
    ownerUserId: string,
  ): Promise<
    | { ok: true; agentId: string; capabilityHash: string | null }
    | { ok: false; reason: 'owned_by_another_user' }
  >;
}

/**
 * Register and provision a cloud fork as one owner-visible operation. The
 * roster row is reserved before any target bytes are written, which closes
 * same-name races. A failed copy that touched the new target destroys it
 * before releasing the roster reservation. A cross-owner collision releases
 * only this user's reservation; the foreign target is never touched.
 */
export async function deliverCloudFork(input: {
  registry: CloudForkRegistry;
  caller: UserCaller;
  target: CloudForkTarget;
  name: string;
  snapshot: ForkSnapshot;
  ownerUserId: string;
}): Promise<{ workspaceId: string }> {
  const registration = await input.registry.reserveWorkspace(input.caller, input.name, input.name);
  if (!registration.reserved) throw new Error(`agent name already exists: "${input.name}"`);

  const destroyPartialTarget = async <Cause>(cause: Cause): Promise<never> => {
    try {
      await input.registry.removeWorkspace(input.caller, input.name, input.ownerUserId);
    } catch (rollback) {
      throw new AggregateError(
        [cause, rollback],
        `fork creation failed and cleanup also failed for "${input.name}"`,
        { cause: rollback },
      );
    }
    throw cause;
  };

  let copied: Awaited<ReturnType<CloudForkTarget['rawCopyFromFork']>>;
  try {
    copied = await input.target.rawCopyFromFork(input.name, input.snapshot, input.ownerUserId);
  } catch (cause) {
    return destroyPartialTarget(cause);
  }

  if (!copied.ok) {
    const released = await input.registry.releaseWorkspaceReservation(
      input.caller,
      input.name,
      registration.entry.createdAt,
    );
    if (!released) throw new Error(`fork target is owned by another user and reservation cleanup failed for "${input.name}"`);
    throw new Error(`agent name already exists: "${input.name}"`);
  }

  try {
    await input.registry.ensureWorkspaceCapability(input.name, copied.capabilityHash);
    return { workspaceId: copied.agentId };
  } catch (cause) {
    return destroyPartialTarget(cause);
  }
}
