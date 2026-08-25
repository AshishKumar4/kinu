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
export { EXECUTOR_CAPABILITIES, NO_TIMER_DEADLINE_MS } from './types';

export {
  formatExecResult, isFailingResultText, parseRefusal, type ExecOutcome,
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
  WORKSPACE_BACKUP_DIR,
} from './sandbox';
export { createDeviceTunnelExecutor, type DeviceTransport } from './device-tunnel-executor';
export { explainNativeToolReferenceError } from './sandbox-errors';
export {
  devicePresence, parseDevicePresence, deviceChangeNotice, observeDevicePresence,
  deviceToolchainAnswer, freshDeviceToolchain,
  DEVICE_PRESENCE_CONFIG_KEY, DEVICE_TOOLCHAIN_TTL_MS,
  type DeviceStatus, type DevicePresence, type DevicePresenceStore,
  type DeviceToolchain, type DeviceFleetEntry,
} from './device-status';
export {
  TOOLCHAIN_PROBE_BINARIES, TOOLCHAIN_PROBED_CAPABILITIES,
  TOOLCHAIN_UNPROBEABLE, toolchainCapabilities,
} from './toolchain';
export {
  DeviceTunnel, type TunnelSocket,
  TUNNEL_DISCONNECTED, NO_DEVICE_CONNECTED, isDeviceNotConnectedError,
  DEVICE_UNKNOWN_METHOD, isDeviceUnknownMethodError, DEVICE_TOKEN_ROTATION,
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
