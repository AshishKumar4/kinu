/** CLI backend: macOS/Linux Bun runtime for the self-evolving agent. */

export {
  createCLIRuntime, makeSql, makeExecRaw, makeSqlExec, makeWorkspaceSchemaSql, inspectionFiles,
  createHostShell,
  type CLIRuntime,
} from './runtime';

export { createHostCheckpoints } from './checkpoints';

export { kinuHome } from './home';

export {
  writeSecretFile, enforceOwnerOnly, ensureSecretDir,
} from './secret-file';

export { openWorkspaceCLI, type WorkspaceInfo } from './open';

export { withConfigLock } from './config-lock';

export { hostToolchainCapabilities } from './host-toolchain';

export { type ProfileEnvelopeSource } from './profile-authority';

export {
  LocalAgentSession, LOCAL_MAX_INLINE_ATTACHMENT_BYTES,
  type LocalAgentSessionOpts, type SessionEvent,
  type ShellApprovalHandler,
} from './local-session';

export { LocalAgentHost, type LocalAgentHostOptions, type LocalHostedAgent, DriverLeaseHold } from './agent-host';

export { OS_LEASE_PROCESS } from './agent-host/lease-process';

export {
  createLocalModelResolver, cloudProxyBaseURL, CLOUD_PROXY_PROVIDER_IDS,
  defaultSpecForEndpoint, stripProvider,
  type LocalModelResolver, type LocalCloudSession,
  type LocalProviderCredentials,
} from './model-resolver';

export { createFileOAuthStore, type LocalOAuthStore } from './oauth-store';

export {
  createOpenCodeProvider, checkOpenCodeAvailability,
} from './opencode-provider';

export { type McpServerConfig } from './mcp';
