/**
 * CLI backend — Linux/Bun runtime for the self-evolving agent.
 */

export { createCLIRuntime, makeSql, makeExecRaw, withCheckpointedShell, type CLIRuntimeConfig } from './runtime.js';
export { createHostCheckpoints, type HostCheckpointsOpts } from './checkpoints.js';
export { openAgentCLI, type AgentInfo, type CLIOpenConfig } from './open.js';
export { createSandboxedExecutor, createNodeExecutor } from './executor.js';
export { createLinuxFiber, detectOrphanedFibers } from './fiber.js';
export { createBranchSpawner } from './branch-process.js';
export { createNodeCraftedExecute } from './craft-executor.js';
export { discoverAgentsMd } from './agents-md.js';
export { createNodeExecuteToolFactory, type NodeExecuteToolFactoryDeps } from './execute-tools-factory.js';
export {
  LocalAgentSession, resolveChatModel,
  type LocalAgentSessionOpts, type SessionEvent, type LocalSessionDb,
} from './local-session.js';
export {
  createLocalModelResolver, cloudProxyBaseURL,
  type LocalModelResolver, type LocalModelResolverConfig, type LocalCloudSession,
  type LocalProviderCredentials, type LocalOpenAICompatCredential,
} from './model-resolver.js';
export { createFileCodexAuthStore, type LocalCodexAuthStore } from './codex-auth-store.js';
export {
  createClaudeCliProvider, buildClaudePrompt,
  CLAUDE_CLI_PROVIDER_ID, CLAUDE_CLI_DEFAULT_MODEL,
  type ClaudeCliProviderOptions, type ClaudeSpawn, type SpawnedClaude, type ClaudeAvailability,
} from './claude-cli-provider.js';
export { createCLIHeadRuntime } from './head-runtime.js';
export { connectMcpServers, type McpServerConfig, type McpConnection } from './mcp.js';
