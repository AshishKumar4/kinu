/**
 * The user-level shared Drive, as every workspace of one user sees it.
 *
 * A Kinu user owns one Mossaic tenant. Every workspace that user owns mounts
 * that tenant — the SAME tenant, live — at `/shared`, so a file put in the
 * Drive from the web UI is on the agent's file plane in every one of that
 * user's workspaces at once, and a file the agent writes under `/shared` is in
 * the Drive. Two reserved folders inside it carry user-level assets: skills
 * under `/shared/skills` (every folder there is a skill in every workspace,
 * see skills/discover.ts) and blueprints under `/shared/blueprints`.
 *
 * The tenant is the OWNER's user id, resolved per call the way the owner is
 * resolved everywhere else: a workspace claimed later mounts the Drive from
 * that moment, and an unclaimed workspace has no Drive — a stated absence,
 * never an empty folder. Another user's workspace resolves another tenant, so
 * isolation is by tenant, not by path (pinned in vfs/shared-drive.test.ts).
 */
import type { VfsMount } from './mounts';
import type { MossaicVfs } from './mossaic-vfs';

/** The mount name: the Drive is `/shared` on every workspace plane. */
const SHARED_MOUNT = 'shared';

/** Where user-level skills live ON THE TENANT, the path the Drive UI addresses. */
export const DRIVE_SKILLS_DIR = '/skills';

/** Where blueprints live on the tenant; the Drive shows the library there. */
export const DRIVE_BLUEPRINTS_DIR = '/blueprints';

/** The tenant folders the Drive UI never renames or deletes. */
export const DRIVE_RESERVED_DIRS: readonly string[] = [DRIVE_SKILLS_DIR, DRIVE_BLUEPRINTS_DIR];

/** Where user-level skills live, as every workspace sees them: `/skills` on
 *  the tenant. Blueprints follow the same rule at `/shared/blueprints`. */
export const SHARED_SKILLS_DIR = `/${SHARED_MOUNT}${DRIVE_SKILLS_DIR}`;

/** Why the mount is absent when the workspace has no owner yet. */
export const SHARED_DRIVE_UNCLAIMED = 'the shared Drive mounts once the workspace has an owner';

/** Why the mount is absent on a deployment without the Drive's bindings. */
export const SHARED_DRIVE_UNBOUND = 'the shared Drive is not bound on this deployment';

/**
 * The `/shared` mount over the owner's tenant. `drive` is read LIVE at every
 * file call, as the mount table requires: the owner claim can land after the
 * plane is built, and the tenant it names must never be captured before then.
 */
export function sharedDriveMount(drive: () => MossaicVfs | null, absentReason: () => string): VfsMount {
  return { name: SHARED_MOUNT, files: drive, absentReason };
}
