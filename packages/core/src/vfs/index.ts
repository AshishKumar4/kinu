/**
 * Workspace file plane — CompositeVFS mount table + raw-handle mount adapters.
 */

export {
  CompositeVFS, EXECUTOR_MOUNT_PREFIX, cleanAbsolutePath,
  type MountPolicy, type MountSpec, type MountInfo, type MountConsistency,
  type ResolvedPath, type CompositeWriteEvent, type CompositeWriteObserver,
} from './composite.js';
export {
  makeVfsError, isVfsError, ERRNO,
  type VfsError, type VfsErrorCode,
} from './errno.js';
export {
  createSandboxMountVFS, createNimbusMountVFS, createDeviceMountVFS,
  createParentRpcMountVFS,
  type DeviceMountConsent, type ParentRpcFileHandle, type ParentRpcWrite,
  type ParentRpcResult, type ParentRpcError,
} from './mount-adapters.js';
