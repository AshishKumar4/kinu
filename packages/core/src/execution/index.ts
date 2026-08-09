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

export { DefaultExecutionRouter } from './router.js';
export { createInlineExecutor, type InlineExecutorDeps } from './inline.js';
export {
  createSandboxExecutor, type SandboxHandle,
  type BackupOptions, type DirectoryBackup, type RestoreBackupResult,
  shouldBackupWorkspace, workspaceBackupOptions, BACKUP_MIN_INTERVAL_MS, BACKUP_TTL_SECONDS,
  isSandboxTransientError,
} from './sandbox.js';
export { createDeviceTunnelExecutor, type DeviceTransport } from './device-tunnel-executor.js';
export {
  devicePresence, parseDevicePresence, deviceChangeNotice, observeDevicePresence,
  DEVICE_PRESENCE_CONFIG_KEY,
  type DeviceStatus, type DevicePresence, type DevicePresenceStore,
} from './device-status.js';
export {
  DeviceTunnel, type TunnelSocket,
  TUNNEL_DISCONNECTED, NO_DEVICE_CONNECTED, isDeviceNotConnectedError,
} from './device-tunnel.js';

// Nimbus — WebSocket client for github.com/AshishKumar4/Nimbus.
// Stays in this directory because Nimbus is just another ExecutorProvider.
export {
  createNimbusExecutor,
  type NimbusExecutorOpts,
  type NimbusSandboxHandle,
  type NimbusExecOptions,
  type NimbusExecResult,
} from './nimbus.js';
