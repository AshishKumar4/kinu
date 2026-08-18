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
} from './types';
export { EXECUTOR_CAPABILITIES } from './types';

export {
  formatExecResult, isFailingResultText, type ExecOutcome,
  STDOUT_LABEL, STDERR_LABEL, NO_OUTPUT,
} from './exec-result';
export {
  TurnEscalationLedger, ESCALATION_OUTCOMES,
  type EscalationDecision, type EscalationOutcome, type EscalationSnapshot,
} from './escalation';
export { DefaultExecutionRouter } from './router';
export { createInlineExecutor, type InlineExecutorDeps } from './inline';
export { withApprovalGatedShell, gateProviderExec } from './approval';
export {
  createSandboxExecutor, type SandboxHandle, isSandboxTransientError,
} from './sandbox';
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
} from './workspace-snapshot';
export { createDeviceTunnelExecutor, type DeviceTransport } from './device-tunnel-executor';
export { explainNativeToolReferenceError } from './sandbox-errors';
export {
  devicePresence, parseDevicePresence, deviceChangeNotice, observeDevicePresence,
  deviceToolchainAnswer, freshDeviceToolchain,
  DEVICE_PRESENCE_CONFIG_KEY, DEVICE_TOOLCHAIN_TTL_MS,
  type DeviceStatus, type DevicePresence, type DevicePresenceStore,
  type DeviceToolchain,
} from './device-status';
export {
  TOOLCHAIN_PROBE_BINARIES, TOOLCHAIN_PROBED_CAPABILITIES,
  TOOLCHAIN_UNPROBEABLE, toolchainCapabilities,
} from './toolchain';
export {
  DeviceTunnel, type TunnelSocket,
  TUNNEL_DISCONNECTED, NO_DEVICE_CONNECTED, isDeviceNotConnectedError,
  DEVICE_UNKNOWN_METHOD, isDeviceUnknownMethodError,
} from './device-tunnel';

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
} from './nimbus';

export {
  createParentExecutor, createParentWorkspaceVfs,
  type ParentWorkspaceHandle, type ParentExecResult,
  type ParentRpcResult, type ParentRpcWrite, type ParentRpcError,
} from './parent';
export { sandboxFiles } from './sandbox';
export { nimbusSessionFiles } from './nimbus';
export { deviceFiles, type DeviceFileConsent } from './device-tunnel-executor';
export { parseStatLine } from './exec-result';
