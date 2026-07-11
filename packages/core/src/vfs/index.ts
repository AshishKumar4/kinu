/**
 * Workspace file plane — CompositeVFS mount table + raw-handle mount adapters.
 */

export {
  CompositeVFS, EXECUTOR_MOUNT_PREFIX, cleanAbsolutePath, makeVfsError,
  type MountPolicy, type MountSpec, type MountInfo, type MountConsistency,
  type ResolvedPath, type VfsError,
} from './composite.js';
export {
  createSandboxMountVFS, createNimbusMountVFS, createDeviceMountVFS,
  type DeviceMountConsent,
} from './mount-adapters.js';
