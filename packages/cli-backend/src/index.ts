/**
 * CLI backend — Linux/Bun runtime for the self-evolving agent.
 */

export {
  createCLIRuntime, buildCLIHeadRuntime, makeSql, makeExecRaw, makeSqlExec, makeWorkspaceSchemaSql,
  createHostShell, withCheckpointedShell, type CLIRuntimeConfig, type LocalDb,
} from './runtime.js';
export { createHostCheckpoints, type HostCheckpointsOpts } from './checkpoints.js';
export { proteusHome } from './home.js';
export { openWorkspaceCLI, type WorkspaceInfo, type CLIOpenConfig } from './open.js';
export { createSandboxedExecutor, createNodeExecutor } from './executor.js';
export { createLinuxFiber, detectOrphanedFibers } from './fiber.js';
export { createBranchSpawner } from './branch-process.js';
export { createNodeCraftedExecute } from './craft-executor.js';
export { discoverAgentsMd } from './agents-md.js';
export { createNodeExecuteToolFactory, type NodeExecuteToolFactoryDeps } from './execute-tools-factory.js';
export {
  LocalAgentSession, resolveChatModel, LOCAL_MAX_INLINE_ATTACHMENT_BYTES,
  type LocalAgentSessionOpts, type SessionEvent, type LocalSessionDb,
  type ShellApprovalHandler,
} from './local-session.js';
export {
  createLocalModelResolver, cloudProxyBaseURL,
  type LocalModelResolver, type LocalModelResolverConfig, type LocalCloudSession,
  type LocalProviderCredentials, type LocalOpenAICompatCredential,
} from './model-resolver.js';
export { createFileCodexAuthStore, type LocalCodexAuthStore } from './codex-auth-store.js';
export {
  createClaudeCliProvider, checkClaudeAvailability, buildClaudePrompt,
  CLAUDE_CLI_PROVIDER_ID, CLAUDE_CLI_DEFAULT_MODEL,
  type ClaudeCliProviderOptions, type ClaudeSpawn, type SpawnedClaude, type ClaudeAvailability,
} from './claude-cli-provider.js';

export {
  createOpenCodeProvider, probeOpenCode, checkOpenCodeAvailability,
  OPENCODE_PROVIDER_ID, OPENCODE_LABEL,
  type OpenCodeProviderOptions, type OpenCodeAvailability,
  type OpenCodeModelInfo, type OpenCodeSpawn, type SpawnedOpenCode,
} from './opencode-provider.js';

export { createCLIHeadRuntime } from './head-runtime.js';
export { connectMcpServers, type McpServerConfig, type McpConnection } from './mcp.js';
