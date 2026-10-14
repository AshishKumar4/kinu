/** CLI backend: macOS/Linux Bun runtime for the self-evolving agent. */

export {
  createCLIRuntime, makeSql, makeExecRaw, makeSqlExec, makeWorkspaceSchemaSql, inspectionFiles,
  createHostShell, soulIn, soulOf, workspaceHome, workspaceMemory,
  type CLIRuntime,
} from './runtime';

export { createHostCheckpoints } from './checkpoints';

export { createLocalProfileAuthority, resolverModelPlane } from './profile-authority';

export { kinuHome } from './home';

export {
  writeSecretFile, enforceOwnerOnly, ensureSecretDir,
} from './secret-file';

export { openWorkspaceCLI, readWorkspaceInfo, type WorkspaceInfo } from './open';

export { requireSchemaGenesis, schemaGenesisOf, stampSchemaGenesis } from './schema-genesis';

export { localArchiveSource, localArchiveTarget, moveIntoFolder, publishStoreFiles } from './local-archive';

export { tryLock, withConfigLock } from './config-lock';

export {
  KinuAgentConfigSchema, OpenAiCompatConfigSchema, readConfigFile, updateConfigFile,
  type KinuAgentConfig, type KinuConfig, type LocalApiKeyProvider, type LocalOAuthSession,
} from './config-file';

export { hostToolchainCapabilities } from './host-toolchain';

export { type ProfileEnvelopeSource } from './profile-authority';

export {
  LocalAgentSession, LOCAL_MAX_INLINE_ATTACHMENT_BYTES,
  type LocalAgentSessionOpts,
  type ShellApprovalHandler,
} from './local-session';

export { LocalAgentHost, type LocalAgentHostOptions, type LocalHostedAgent } from './agent-host';

export { OS_LEASE_PROCESS } from './agent-host/lease-process';

export {
  createLocalModelResolver,
  defaultSpecForEndpoint, stripProvider,
  type LocalModelResolver, type LocalCloudSession,
  type LocalProviderCredentials,
} from './model-resolver';

export { createFileOAuthStore, signOutChatGptLogin, type ChatGptSignOut, type LocalOAuthStore } from './oauth-store';

export {
  createOpenCodeProvider, checkOpenCodeAvailability,
} from './opencode-provider';

export { type McpServerConfig } from './mcp';
