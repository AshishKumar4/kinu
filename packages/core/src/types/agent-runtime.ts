/** The one struct the agent core receives, constructed per backend. See docs/ARCHITECTURE.md
 *  "Backends and the AgentRuntime contract". */

import type {
  Storage,
  Memory,
  Executor,
  LLM,
  Schedule,
  Identity,
  Shell,
  VFS,
} from './primitives';
import type { CraftedTool } from './craft';
import type { Usage } from '../usage';
import type { ExecutionRouter } from '../execution/types';
import type { DeviceTransport } from '../execution/device-tunnel-executor';
import type { FileCheckpoints } from '../checkpoints/types';
import type { ShellApprovalRequest, ShellApprovalOutcome } from '../safety/approval-gate';
import type { WorkMode } from './turn';
import type { TurnFileLedger } from '../tools/file-ledger';
import type { ActorHandle } from '../identity/actor-handle';

/** Live channel for 'gate'-tier shell approvals (ACP `session/request_permission`). */
export type RequestShellApproval = (req: ShellApprovalRequest) => Promise<ShellApprovalOutcome | null>;

export interface CraftStore {
  create(tool: Omit<CraftedTool, 'createdAt' | 'updatedAt'>): void;
  update(name: string, patch: Partial<CraftedTool>): void;
  get(name: string): CraftedTool | undefined;
  delete(name: string): void;
  list(): CraftedTool[];
  search(query: string, limit?: number): CraftedTool[];
}

/** One rollout and its cost. A branch runs outside the mission ledger, so `usage` travels back
 *  for the engine to debit; a backend that cannot measure omits it rather than guessing. */
export interface BranchExploration {
  text: string;
  usage?: Usage;
}

/** One failure post-mortem, and what it cost — `usage` as on {@link BranchExploration}. */
export interface BranchReflection {
  text: string;
  usage?: Usage;
}

export interface BranchExplorationRequest {
  priorHistory: Array<{ role: string; content: string }>;
  craftedTools: CraftedTool[];
  /** What the parent executor can run, in preference order. */
  languages: readonly [string, ...string[]];
  /** Trusted parent mode; a branch cannot select or downgrade it. */
  mode: WorkMode;
  /** Angles assigned to siblings in the same expansion; parallel branches never see each
   *  other's output, so this is how each proposes something distinct. */
  siblings?: readonly string[];
}

/** A branch explores and reflects but cannot score itself; the engine scores through the
 *  grounded evaluator, so no backend can reintroduce same-model self-rating. */
export interface BranchHandle {
  explore(request: BranchExplorationRequest): Promise<BranchExploration>;
  /** `outcome` is the environment's verdict from scoring; omitted when nothing executed, so no
   *  unobserved claim reaches MEMORY.md. */
  generateReflection(task: string, outcome?: string): Promise<BranchReflection>;
  /** Release this creation after its final reflection. Never resolve a new actor by name. */
  release(): Promise<void>;
}

export type SpawnBranch = (branchId: string) => Promise<BranchHandle>;

/** Mid-flight eviction: stops the branch but keeps its recorded state, which may still be read. */
export type AbortBranch = (branchId: string, reason?: string) => Promise<void>;

export interface AgentRuntime {
  readonly actor: ActorHandle;
  storage: Storage;
  /** The agent's own state (SOUL.md, scaffold, memory, transcripts) when a shared file plane
   *  must not hold it. Absent when they coincide; readers use `agentStateVfs ?? storage.vfs`. */
  agentStateVfs?: VFS;
  readonly workspaceIsMachine: boolean;
  memory: Memory;
  executor: Executor;
  llm: LLM;
  schedule: Schedule;
  identity: Identity;
  craftStore: CraftStore;
  /** Cross-model judge, a different model from the explorer. */
  judgeModel?: LLM;
  /** Same-vendor cheap tier (`MODEL_ROUTE_POLICY.fast`) for mechanical work; readers fall back
   *  to `llm`. Never for user-visible generation or scaffold authoring. */
  fastLlm?: LLM;
  /** Turn reviewer model; defaults cross-vendor. Absent means the advisor lane is inert, as the
   *  conformance manifest declares per root. */
  advisorLlm?: LLM;
  spawnBranch: SpawnBranch;
  abortBranch: AbortBranch;
  /** Named executor providers (workspace, nimbus, sandbox, device) for the codemode sandbox. */
  executionRouter?: ExecutionRouter;
  /** Device-fleet transport (CF); its cached snapshot feeds the dynamic context's fleet roster.
   *  Absent where the host is the only machine (CLI). */
  deviceTransport?: DeviceTransport;
  /** POSIX shell bound to the agent's VFS; absent degrades the `shell` tool to router-only. */
  shell?: Shell;
  /** Shadow-git checkpoints over real filesystems; absent means no /undo for that surface. */
  checkpoints?: FileCheckpoints;
  /** Read live at exec time, so attaching takes effect on the next command. Backends without an
   *  interactive surface (CF) never call it; 'strict' parks via the deferred-approval queue. */
  setShellApprovalChannel?: (fn: RequestShellApproval | null) => void;
  /** Read lazily by the router, so native `file` and codemode `workspace.*` share one
   *  read-before-write history. */
  setTurnFileLedgerProvider?: (provider: (() => TurnFileLedger | undefined) | null) => void;
}
