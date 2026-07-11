/**
 * Workspace file plane — CompositeVFS mount table + raw-handle mount adapters.
 */

export {
  CompositeVFS, EXECUTOR_MOUNT_PREFIX, cleanAbsolutePath,
  type MountPolicy, type MountSpec, type MountInfo, type MountConsistency,
  type ResolvedPath,
} from './composite.js';
export {
  makeVfsError, isVfsError, ERRNO,
  type VfsError, type VfsErrorCode,
} from './errno.js';
export {
  createSandboxMountVFS, createNimbusMountVFS, createDeviceMountVFS,
  type DeviceMountConsent,
} from './mount-adapters.js';
