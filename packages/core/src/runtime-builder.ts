/**
 * Shared runtime builder — constructs an AgentRuntime from platform-specific
 * primitives. Both CF and CLI backends use this to avoid duplicating the
 * wiring logic for Memory, Identity, and other derived interfaces.
 *
 * The backend provides the raw primitives (sql, vfs, llm, executor, schedule).
 * This module composes them into a full AgentRuntime.
 */

import type {
  SqlExecutor,
  RawSqlExec,
  VFS,
  Memory,
  Identity,
  LLM,
  Executor,
  Schedule,
  Shell,
  MemorySearchResult,
} from './types/primitives.js';
import type { AgentRuntime, CraftStore, SpawnBranch, AbortBranch } from './types/agent-runtime.js';
import type { ExecutionRouter } from './execution/types.js';

export interface RuntimeComponents {
  sql: SqlExecutor;
  execRaw: RawSqlExec;
  vfs: VFS;
  llm: LLM;
  executor: Executor;
  schedule: Schedule;
  /** Agent stable identity */
  agentId: string;
  agentName: string;
  /** Platform-specific memory (wraps VFS + FTS5) */
  memory: Memory;
  /** Platform-specific CraftStore */
  craftStore: CraftStore;
  /** Optional second LLM for cross-model judging */
  judgeModel?: LLM;
  /** Branch lifecycle callbacks */
  spawnBranch: SpawnBranch;
  abortBranch: AbortBranch;
  /**
   * Optional multi-executor router (workspace/nimbus/sandbox/laptop). When
   * provided, the canonical `run` and `execute_tools` factories in core will
   * consume it for routing. Absent → tools degrade gracefully.
   */
  executionRouter?: ExecutionRouter;
  /**
   * Optional POSIX shell bound to VFS. Required by the canonical `run` tool
   * for workspace-scoped commands (fast path, no router indirection) and by
   * the `execute_tools` new-Function fallback.
   */
  shell?: Shell;
}

/**
 * Build a complete AgentRuntime from platform-specific components.
 * Constructs the Identity.scaffold interface from VFS + SQL.
 */
export function buildRuntime(components: RuntimeComponents): AgentRuntime {
  const { sql, execRaw, vfs, llm, executor, schedule, memory, craftStore } = components;

  const identity: Identity = {
    id: components.agentId,
    name: components.agentName,
    scaffold: {
      exists: () => vfs.exists('scaffold/agent.js'),
      read: () => vfs.readFile('scaffold/agent.js', { encoding: 'utf8' }) as Promise<string>,
      write: (code: string) => vfs.writeFile('scaffold/agent.js', code),
      version: async () =>
        (sql<{ v: number }>`SELECT COALESCE(MAX(version), 0) as v FROM scaffold_versions`)[0]?.v ?? 0,
    },
  };

  return {
    storage: { vfs, sql, execRaw },
    memory,
    executor,
    llm,
    schedule,
    identity,
    craftStore,
    judgeModel: components.judgeModel,
    spawnBranch: components.spawnBranch,
    abortBranch: components.abortBranch,
    executionRouter: components.executionRouter,
    shell: components.shell,
  };
}
