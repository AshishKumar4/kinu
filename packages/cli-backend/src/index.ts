/**
 * CLI backend — Linux/Bun runtime for the self-evolving agent.
 */

export { createCLIRuntime, makeSql, makeExecRaw, type CLIRuntimeConfig } from './runtime.js';
export { openAgentCLI, type AgentInfo, type CLIOpenConfig } from './open.js';
export { createSandboxedExecutor, createNodeExecutor } from './executor.js';
export { createLinuxFiber, detectOrphanedFibers } from './fiber.js';
export { createBranchSpawner } from './branch-process.js';
export { createNodeCraftedExecute } from './craft-executor.js';
export { createNodeExecuteToolFactory, type NodeExecuteToolFactoryDeps } from './execute-tools-factory.js';
