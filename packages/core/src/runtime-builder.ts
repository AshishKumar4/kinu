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
} from './types/primitives';
import type { AgentRuntime, CraftStore, SpawnBranch, AbortBranch, ReleaseBranch, RequestShellApproval } from './types/agent-runtime';
import type { ExecutionRouter } from './execution/types';
import type { FileCheckpoints } from './checkpoints/types';
import type { TurnFileLedger } from './tools/file-ledger';
import { resolveModelRoute } from './profiles/model-route';
import type { ModelRouteResolution } from './profiles/model-route';
import type { ResolvedTurnProfile } from './profiles/resolve';
import type { SpendSource } from './events/model-call';
/**
 * Where the fixed-tier producer lanes come from. The route POLICY is core's
 * (profiles/model-route.ts); this component supplies what only a backend
 * knows: how to read the current turn profile, and how to build an LLM for a
 * resolved tier. Read per call — never cached here — so a role or catalog
 * change lands on the next producer call without a rebuild.
 */
export interface ModelLaneComponents {
  /** The immutable turn profile for the current context, or null when no
   *  profile authority has resolved one yet. Read fresh on every lane call. */
  turnProfile(): ResolvedTurnProfile | null;
  /** Build one producer LLM from its resolved tier. */
  llm(resolution: ModelRouteResolution): LLM;
  /** What a producer uses before any authority exists (pre-claim facets,
   *  bare fixtures). Undefined leaves the lane unset so consumers' documented
   *  `?? rt.llm` fallback runs. */
  fallbackLlm?(): LLM | undefined;
}

export interface RuntimeComponents {
  sql: SqlExecutor;
  execRaw: RawSqlExec;
  vfs: VFS;
  /** Where this agent's own state lives when `vfs` is a shared plane. The CLI
   *  enters through this builder and can split the two. Cloudflare constructs
   *  CFRuntime directly and sets AgentRuntime.agentStateVfs to workspaceVfs. */
  agentStateVfs?: VFS;
  llm: LLM;
  executor: Executor;
  schedule: Schedule;
  /** Agent stable identity */
  agentId: string;
  agentName: string;
  /** Platform-specific CraftStore */
  craftStore: CraftStore;
  /** Platform-specific memory (wraps VFS + FTS5) */
  memory: Memory;
  /** Fixed-tier producer lanes (judge/deep, fast/tiny, advisor/slow),
   *  composed through MODEL_ROUTE_POLICY from the live turn profile. This is
   *  a buildRuntime input. CFRuntime wires the same three AgentRuntime getters
   *  directly because its provider resolver needs the actor and environment. */
  modelLanes?: ModelLaneComponents;
  /** Branch lifecycle callbacks */
  spawnBranch: SpawnBranch;
  abortBranch: AbortBranch;
  releaseBranch: ReleaseBranch;
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
 * A pinned client per producer lane.
 *
 * The lanes are DERIVED — read fresh from the live turn profile on every access
 * — but `AgentRuntime` declares them as ordinary mutable fields and callers
 * assign them: a harness scripting a judge, a caller pinning one client for a
 * runtime that has no profile yet. A derived getter with no setter turns that
 * assignment into `TypeError: Attempted to assign to readonly property`, which
 * is how four suites failed rather than being told anything. So an assignment
 * PINS, and a pin wins over routing for the rest of this runtime's life.
 */
interface PinnedLanes {
  judge?: LLM;
  fast?: LLM;
  advisor?: LLM;
}

/** One routed producer's lane, read fresh: resolve the current turn profile,
 *  push it through the exhaustive route table, and let the backend build the
 *  client. No profile → the backend's fallback; no lanes component → unset. */
function resolveRoutedLane(lanes: ModelLaneComponents | undefined, source: SpendSource): LLM | undefined {
  if (!lanes) return undefined;
  const profile = lanes.turnProfile();
  if (!profile) return lanes.fallbackLlm?.();
  const resolution = resolveModelRoute(source, profile);
  return resolution ? lanes.llm(resolution) : undefined;
}

/**
 * Build a complete AgentRuntime from platform-specific components.
 * Constructs the Identity.scaffold interface from VFS + SQL.
 */
export function buildRuntime(components: RuntimeComponents): AgentRuntime {
  const { sql, execRaw, vfs, llm, executor, schedule, memory, craftStore } = components;
  const agentStateVfs = components.agentStateVfs ?? vfs;

  const identity: Identity = {
    id: components.agentId,
    name: components.agentName,
    scaffold: {
      path: 'scaffold/agent.js',
      exists: () => agentStateVfs.exists('scaffold/agent.js'),
      read: async () => {
        const content = await agentStateVfs.readFile('scaffold/agent.js', { encoding: 'utf8' });
        return content instanceof Uint8Array ? new TextDecoder().decode(content) : content;
      },
      write: (code: string) => agentStateVfs.writeFile('scaffold/agent.js', code),
      version: async () =>
        (sql<{ v: number }>`SELECT COALESCE(MAX(version), 0) as v FROM scaffold_versions`)[0]?.v ?? 0,
    },
  };
  const lanes = components.modelLanes;
  const pinned: PinnedLanes = {};

  return {
    storage: { vfs, sql, execRaw },
    agentStateVfs,
    memory,
    executor,
    llm,
    schedule,
    identity,
    craftStore,
    get judgeModel() { return pinned.judge ?? resolveRoutedLane(lanes, 'judge'); },
    set judgeModel(llm: LLM | undefined) { pinned.judge = llm; },
    get fastLlm() { return pinned.fast ?? resolveRoutedLane(lanes, 'fast'); },
    set fastLlm(llm: LLM | undefined) { pinned.fast = llm; },
    get advisorLlm() { return pinned.advisor ?? resolveRoutedLane(lanes, 'advisor'); },
    set advisorLlm(llm: LLM | undefined) { pinned.advisor = llm; },
    spawnBranch: components.spawnBranch,
    abortBranch: components.abortBranch,
    releaseBranch: components.releaseBranch,
    executionRouter: components.executionRouter,
    shell: components.shell,
    checkpoints: components.checkpoints,
    setShellApprovalChannel: components.setShellApprovalChannel,
    setTurnFileLedgerProvider: components.setTurnFileLedgerProvider,
  };
}
