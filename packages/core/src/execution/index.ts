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
  effectiveDeviceMode, parseDeviceTier, parseSandboxCapability, parseSandboxReason,
  sandboxReasonFix, describeGpuNodes,
  DEVICE_PRESENCE_CONFIG_KEY, DEVICE_TOOLCHAIN_TTL_MS,
  DEVICE_TIERS, DEVICE_SANDBOX_CAPABILITIES, DEVICE_SANDBOX_REASONS,
  type DeviceStatus, type DevicePresence, type DevicePresenceStore,
  type DeviceToolchain, type DeviceFleetEntry,
  type DeviceTier, type DeviceMode, type DeviceSandboxStatus,
  type DeviceSandboxCapability, type DeviceSandboxReason,
} from './device-status';
export {
  TOOLCHAIN_PROBE_BINARIES, TOOLCHAIN_PROBED_CAPABILITIES,
  TOOLCHAIN_UNPROBEABLE, toolchainCapabilities,
} from './toolchain';
export {
  DeviceTunnel, type TunnelSocket,
  TUNNEL_DISCONNECTED, NO_DEVICE_CONNECTED, isDeviceNotConnectedError,
  SANDBOX_UNAVAILABLE, isSandboxUnavailableError,
  DEVICE_UNKNOWN_METHOD, isDeviceUnknownMethodError, DEVICE_TOKEN_ROTATION, DEVICE_TOKEN_ROTATION_ACK,
  DEVICE_CANCEL_METHOD, DEVICE_CANCEL_PROTOCOL, DEVICE_CANCEL_VERSION_REFUSAL, DEVICE_EXEC_ACK_METHOD,
  DEVICE_DUPLICATE_REQUEST, DeviceCancelResultSchema, nextDeviceRequestId,
  DEVICE_CANCEL_MISPAIRED, parseDeviceCancelAnswer,
  DEVICE_PTY_OPEN_METHOD, DEVICE_PTY_INPUT, DEVICE_PTY_RESIZE, DEVICE_PTY_CLOSE,
  DEVICE_PTY_OUTPUT, DEVICE_PTY_EXIT, DEVICE_PTY_MAX_AXIS,
  type DeviceCancelResult,
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
  type NimbusPortInfo,
} from './nimbus';

export {
  createParentExecutor, createParentWorkspaceVfs,
  type ParentWorkspaceHandle, type ParentExecResult,
  type ParentRpcResult, type ParentRpcWrite, type ParentRpcError,
} from './parent';
export { sandboxFiles } from './sandbox';
export { nimbusSessionFiles } from './nimbus';
export { AGENT_FS_CHUNK_BYTES } from './nimbus-agent-files';
export { deviceFiles, type DeviceFileConsent } from './device-tunnel-executor';
