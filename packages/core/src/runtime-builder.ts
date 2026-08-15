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
} from './types/primitives.js';
import type { AgentRuntime, CraftStore, SpawnBranch, AbortBranch, RequestShellApproval } from './types/agent-runtime.js';
import type { ExecutionRouter } from './execution/types.js';
import type { FileCheckpoints } from './checkpoints/types.js';
import type { TurnFileLedger } from './tools/file-ledger.js';

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
  /** Optional small-tier LLM for the mechanical evolution calls. */
  fastLlm?: LLM;
  /** Branch lifecycle callbacks */
  spawnBranch: SpawnBranch;
  abortBranch: AbortBranch;
  /**
   * Optional router for the runtime's registered execution environments. When
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
  /** Shadow-git file checkpoints over real filesystems (host backends only). */
  checkpoints?: FileCheckpoints;
  /** See AgentRuntime.setShellApprovalChannel. Only a backend that owns a
   *  live interactive surface (the CLI's ACP channel) supplies this. */
  setShellApprovalChannel?: (fn: RequestShellApproval | null) => void;
  setTurnFileLedgerProvider?: (provider: (() => TurnFileLedger | undefined) | null) => void;
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
      path: 'scaffold/agent.js',
      exists: () => vfs.exists('scaffold/agent.js'),
      read: async () => {
        const content = await vfs.readFile('scaffold/agent.js', { encoding: 'utf8' });
        return content instanceof Uint8Array ? new TextDecoder().decode(content) : content;
      },
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
    fastLlm: components.fastLlm,
    spawnBranch: components.spawnBranch,
    abortBranch: components.abortBranch,
    executionRouter: components.executionRouter,
    shell: components.shell,
    checkpoints: components.checkpoints,
    setShellApprovalChannel: components.setShellApprovalChannel,
    setTurnFileLedgerProvider: components.setTurnFileLedgerProvider,
  };
}
