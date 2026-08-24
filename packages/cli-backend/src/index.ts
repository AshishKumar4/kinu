/**
 * CLI backend — Linux/Bun runtime for the self-evolving agent.
 */

export {
  createCLIRuntime, buildCLIHeadRuntime, makeSql, makeExecRaw, makeSqlExec, makeWorkspaceSchemaSql,
  createHostShell, withCheckpointedShell,
  type CLIRuntime, type CLIRuntimeConfig, type LocalDb,
} from './runtime';
export { createHostCheckpoints, type HostCheckpointsOpts } from './checkpoints';
export { kinuHome } from './home';
export {
  writeSecretFile, enforceOwnerOnly, ensureSecretDir, SECRET_FILE_MODE, SECRET_DIR_MODE,
} from './secret-file';
export { openWorkspaceCLI, type WorkspaceInfo, type CLIOpenConfig } from './open';
export { createSandboxedExecutor } from './executor';
export { hostToolchainCapabilities } from './host-toolchain';
export { createLinuxFiber, detectOrphanedFibers } from './fiber';
export { createBranchSpawner } from './branch-process';
export { createNodeCraftedExecute } from './craft-executor';
export { discoverAgentsMd } from './agents-md';
export { createNodeExecuteToolFactory, type NodeExecuteToolFactoryDeps } from './execute-tools-factory';
export {
  LocalAgentSession, LOCAL_MAX_INLINE_ATTACHMENT_BYTES,
  type LocalAgentSessionOpts, type SessionEvent, type LocalSessionDb,
  type ShellApprovalHandler,
} from './local-session';
export {
  LocalAgentHost,
  type AgentEventListener,
  type LocalAgentHostOptions,
  type LocalHostedAgent,
} from './agent-host';
export {
  createLocalModelResolver, cloudProxyBaseURL, CLOUD_PROXY_PROVIDER_IDS,
  type LocalModelResolver, type LocalModelResolverConfig, type LocalCloudSession,
  type LocalProviderCredentials, type LocalOpenAICompatCredential,
} from './model-resolver';
export { createFileCodexAuthStore, type LocalCodexAuthStore } from './codex-auth-store';
export {
  createClaudeCliProvider, checkClaudeAvailability, buildClaudePrompt,
  CLAUDE_CLI_PROVIDER_ID, CLAUDE_CLI_DEFAULT_MODEL,
  type ClaudeCliProviderOptions, type ClaudeSpawn, type SpawnedClaude, type ClaudeAvailability,
} from './claude-cli-provider';

export {
  createOpenCodeProvider, probeOpenCode, checkOpenCodeAvailability,
  OPENCODE_PROVIDER_ID, OPENCODE_LABEL,
  type OpenCodeProviderOptions, type OpenCodeAvailability,
  type OpenCodeModelInfo, type OpenCodeSpawn, type SpawnedOpenCode,
} from './opencode-provider';

export { createCLIHeadRuntime } from './head-runtime';
export { connectMcpServers, type McpServerConfig, type McpConnection } from './mcp';
