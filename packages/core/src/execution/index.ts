/**
 * Execution Layer — capability-based multi-executor routing.
 */

export type {
  ExecutorCapability,
  ExecutorKind,
  ExecutorProvider,
  ExecutorInfo,
  ExecutionRouter,
} from './types.js';

export { DefaultExecutionRouter } from './router.js';
export { createInlineExecutor, type InlineExecutorDeps } from './inline.js';
export {
  createSandboxExecutor, type SandboxHandle,
  type BackupOptions, type DirectoryBackup, type RestoreBackupResult,
  shouldBackupWorkspace, workspaceBackupOptions, BACKUP_MIN_INTERVAL_MS, BACKUP_TTL_SECONDS,
} from './sandbox.js';
export { createSSHTunnelExecutor, type DeviceTransport } from './ssh.js';
export { DeviceTunnel, type TunnelSocket, TUNNEL_DISCONNECTED } from './device-tunnel.js';

// Nimbus — WebSocket client for github.com/AshishKumar4/Nimbus.
// Stays in this directory because Nimbus is just another ExecutorProvider.
export { createNimbusExecutor, type NimbusExecutorOpts } from './nimbus.js';
