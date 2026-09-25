/** Composes a backend's raw primitives into a full AgentRuntime. */

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
} from './types/primitives';
import type { AgentRuntime, CraftStore, SpawnBranch, AbortBranch, RequestShellApproval } from './types/agent-runtime';
import type { ExecutionRouter } from './execution/types';
import type { FileCheckpoints } from './checkpoints/types';
import type { TurnFileLedger } from './vfs/file-ledger';
import { createScaffoldSurface } from './scaffold/surface';
import type { ActorHandle } from './identity/actor-handle';
import { createRoutedModelLane, type ModelLaneComponents } from './profiles/model-lane';

/** Read per call, never cached, so a role or catalog change lands on the next producer call. */
export type { ModelLaneComponents } from './profiles/model-lane';

export interface RuntimeComponents {
  actor: ActorHandle;
  /** From {@link actorScaffoldPath}; absent means `scaffold/agent.js`, correct only for the root. */
  scaffoldPath?: string;
  sql: SqlExecutor;
  transactionSync: <T>(write: () => T) => T;
  execRaw: RawSqlExec;
  vfs: VFS;
  /** This agent's own state when `vfs` is a shared plane. */
  agentStateVfs?: VFS;
  workspaceIsMachine: boolean;
  llm: LLM;
  executor: Executor;
  schedule: Schedule;
  craftStore: CraftStore;
  memory: Memory;
  /** Judge/fast/advisor lanes routed through MODEL_ROUTE_POLICY from the live turn profile. */
  modelLanes?: ModelLaneComponents;
  spawnBranch: SpawnBranch;
  abortBranch: AbortBranch;
  executionRouter?: ExecutionRouter;
  /** Required by the `shell` tool's workspace fast path and the `eval` new-Function fallback. */
  shell?: Shell;
  /** Host backends only. */
  checkpoints?: FileCheckpoints;
  /** Only a backend with a live interactive surface (the CLI's ACP channel) supplies this. */
  setShellApprovalChannel?: (fn: RequestShellApproval | null) => void;
  setTurnFileLedgerProvider?: (provider: (() => TurnFileLedger | undefined) | null) => void;
}

/** Lanes are derived getters but callers assign them; an assignment pins and wins over routing thereafter. */
interface PinnedLanes {
  judge?: LLM;
  fast?: LLM;
  advisor?: LLM;
}

export function buildRuntime(components: RuntimeComponents): AgentRuntime {
  const { sql, execRaw, vfs, llm, executor, schedule, memory, craftStore } = components;
  const agentStateVfs = components.agentStateVfs ?? vfs;

  const identity: Identity = {
    id: components.actor.actorId,
    name: components.actor.name,
    scaffold: createScaffoldSurface({
      vfs: agentStateVfs, sql, actor: components.actor,
      path: components.scaffoldPath ?? 'scaffold/agent.js',
    }),
  };

  const lanes = components.modelLanes;

  const routed = lanes ? {
    judge: createRoutedModelLane(components.actor, 'judge', lanes),
    fast: createRoutedModelLane(components.actor, 'fast', lanes),
    advisor: createRoutedModelLane(components.actor, 'advisor', lanes),
  } : {};

  const pinned: PinnedLanes = {};

  return {
    actor: components.actor,
    storage: { vfs, sql, execRaw, transactionSync: components.transactionSync },
    agentStateVfs,
    workspaceIsMachine: components.workspaceIsMachine,
    memory,
    executor,
    llm,
    schedule,
    identity,
    craftStore,
    get judgeModel() { return pinned.judge ?? routed.judge; },
    set judgeModel(model: LLM | undefined) { pinned.judge = model; },
    get fastLlm() { return pinned.fast ?? routed.fast; },
    set fastLlm(model: LLM | undefined) { pinned.fast = model; },
    get advisorLlm() { return pinned.advisor ?? routed.advisor; },
    set advisorLlm(model: LLM | undefined) { pinned.advisor = model; },
    spawnBranch: components.spawnBranch,
    abortBranch: components.abortBranch,
    executionRouter: components.executionRouter,
    shell: components.shell,
    checkpoints: components.checkpoints,
    setShellApprovalChannel: components.setShellApprovalChannel,
    setTurnFileLedgerProvider: components.setTurnFileLedgerProvider,
  };
}
