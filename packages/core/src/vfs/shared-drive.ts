/**
 * The user-level shared Drive: the owner's Mossaic tenant, mounted live at `/shared` in every workspace
 * they own. Tenant is resolved per call; unclaimed workspaces have no Drive. Isolation is by tenant.
 */
import type { VfsMount } from './mounts';
import type { MossaicVfs } from './mossaic-vfs';

/** The mount name: the Drive is `/shared` on every workspace plane. */
const SHARED_MOUNT = 'shared';

/** Where user-level skills live on the tenant (the path the Drive UI addresses). */
export const DRIVE_SKILLS_DIR = '/skills';

/** Where blueprints live on the tenant; the Drive shows the library there. */
export const DRIVE_BLUEPRINTS_DIR = '/blueprints';

/** The tenant folders the Drive UI never renames or deletes. */
export const DRIVE_RESERVED_DIRS: readonly string[] = [DRIVE_SKILLS_DIR, DRIVE_BLUEPRINTS_DIR];

/** Where user-level skills live as every workspace sees them. */
export const SHARED_SKILLS_DIR = `/${SHARED_MOUNT}${DRIVE_SKILLS_DIR}`;

/** Why the mount is absent when the workspace has no owner yet. */
export const SHARED_DRIVE_UNCLAIMED = 'the shared Drive mounts once the workspace has an owner';

/** Why the mount is absent on a deployment without the Drive's bindings. */
export const SHARED_DRIVE_UNBOUND = 'the shared Drive is not bound on this deployment';

/** The `/shared` mount. `drive` is read live per call: the owner claim can land after the plane is built. */
export function sharedDriveMount(drive: () => MossaicVfs | null, absentReason: () => string): VfsMount {
  return { name: SHARED_MOUNT, files: drive, absentReason };
}
