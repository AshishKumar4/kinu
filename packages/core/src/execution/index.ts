/**
 * Execution Layer — capability-based multi-executor routing.
 */

export type {
  ExecutorCapability,
  ExecutorKind,
  ExecutorProvider,
  ExecutorStatus,
  ExecutorLifecycleStatus,
  ExecutorInfo,
  ResourceLimits,
  ExecutionRouter,
} from './types.js';
export { EXECUTOR_CAPABILITIES } from './types.js';

export {
  formatExecResult, type ExecOutcome,
  STDOUT_LABEL, STDERR_LABEL, NO_OUTPUT,
} from './exec-result.js';
export { DefaultExecutionRouter } from './router.js';
export { createInlineExecutor, type InlineExecutorDeps } from './inline.js';
export { withApprovalGatedShell, gateProviderExec } from './approval.js';
export {
  createSandboxExecutor, type SandboxHandle, isSandboxTransientError,
} from './sandbox.js';
export {
  createWorkspaceSnapshots, type WorkspaceSnapshots, type WorkspaceSnapshotPorts,
  type WorkspaceSnapshotState, type WorkspaceRestoreOutcome, type WorkspaceSnapshotOutcome,
  type WorkspaceRestoreOutcomeKind, type WorkspaceSnapshotOutcomeKind,
  WORKSPACE_RESTORE_OUTCOMES, WORKSPACE_SNAPSHOT_OUTCOMES,
  type BackupOptions, type DirectoryBackup, type WorkspaceChangeStatus,
  shouldBackupWorkspace, workspaceBackupOptions, workspaceRestoreMode,
  BACKUP_MIN_INTERVAL_MS, BACKUP_TTL_SECONDS, WORKSPACE_BACKUP_DIR,
  WORKSPACE_RESTORE_DEADLINE_MS, isDirectoryOverlayMounted,
  snapshotIntegrityFailure, snapshotObjectKeys, withContainerStartDeadline,
  type SnapshotObjectKeys, type LateStartFailure,
} from './workspace-snapshot.js';
export { createDeviceTunnelExecutor, type DeviceTransport } from './device-tunnel-executor.js';
export { explainNativeToolReferenceError } from './sandbox-errors.js';
export {
  devicePresence, parseDevicePresence, deviceChangeNotice, observeDevicePresence,
  DEVICE_PRESENCE_CONFIG_KEY,
  type DeviceStatus, type DevicePresence, type DevicePresenceStore,
} from './device-status.js';
export {
  DeviceTunnel, type TunnelSocket,
  TUNNEL_DISCONNECTED, NO_DEVICE_CONNECTED, isDeviceNotConnectedError,
} from './device-tunnel.js';

// Reusable Nimbus adapter. Cloudflare composes the session as its authoritative
// workspace; the standalone factory remains available to other backends.
export {
  createNimbusExecutor,
  createNimbusWorkspaceExecutor,
  nimbusSessionShell,
  type NimbusExecutorOpts,
  type NimbusWorkspaceExecutorOpts,
  type NimbusSandboxHandle,
  type NimbusExecOptions,
  type NimbusExecResult,
  type NimbusStartResult,
} from './nimbus.js';

export {
  createParentExecutor, createParentWorkspaceVfs,
  type ParentWorkspaceHandle, type ParentExecResult,
  type ParentRpcResult, type ParentRpcWrite, type ParentRpcError,
} from './parent.js';
export { sandboxFiles } from './sandbox.js';
export { nimbusSessionFiles } from './nimbus.js';
export { deviceFiles, type DeviceFileConsent } from './device-tunnel-executor.js';
export { parseStatLine } from './exec-result.js';
