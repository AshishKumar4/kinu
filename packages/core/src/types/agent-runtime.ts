/**
 * AgentRuntime — the one struct the agent core receives.
 * Platform-specific; constructed by either CF or Linux backend.
 *
 * Architecture reference: docs/ARCHITECTURE.md — "Backends and the AgentRuntime contract"
 */

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
import type { FileCheckpoints } from '../checkpoints/types';
import type { ShellApprovalRequest, ShellApprovalOutcome } from '../safety/approval-gate';
import type { WorkMode } from '../prompting/surface';
import type { TurnFileLedger } from '../tools/file-ledger';

/** A live channel a surface that owns a user (ACP's `session/request_permission`)
 *  offers for 'gate'-tier shell approvals — see AgentRuntime.setShellApprovalChannel. */
export type RequestShellApproval = (req: ShellApprovalRequest) => Promise<ShellApprovalOutcome | null>;

/** CraftStore interface — matches agent-utils CraftStore API */
export interface CraftStore {
  create(tool: Omit<CraftedTool, 'createdAt' | 'updatedAt'>): void;
  update(name: string, patch: Partial<CraftedTool>): void;
  get(name: string): CraftedTool | undefined;
  delete(name: string): void;
  list(): CraftedTool[];
  search(query: string, limit?: number): CraftedTool[];
  getAll(): CraftedTool[];
}

/**
 * One rollout: the proposal and what it cost. Code is parsed centrally.
 *
 * `usage` is what the provider that served the branch reported. A branch runs
 * where the mission ledger is not: its own facet on cf, its own child process
 * on the CLI, each resolving its own model. Nothing the fork seam wrapped
 * around `rt.llm` sees these calls, so the spend has to travel back with the
 * result — the engine debits it at the seam that already interposes between
 * every rollout (mcts/engine.ts).
 *
 * Optional, and free to report only some of its fields, because a backend that
 * cannot measure a call meters nothing rather than guessing — and because a
 * branch is a single call either way: the engine still refuses to open the next
 * expansion once the ledger is spent.
 */
export interface BranchExploration {
  text: string;
  usage?: Usage;
}

/** One failure post-mortem, and what it cost — `usage` as on {@link BranchExploration}. */
export interface BranchReflection {
  text: string;
  usage?: Usage;
}

/**
 * A branch EXPLORES and reflects; it deliberately cannot score itself.
 * Scoring happens at the engine seam (mcts/engine.ts) through the grounded
 * evaluator, so no backend can reintroduce same-model self-rating.
 */
export interface BranchHandle {
  explore(
    priorHistory: Array<{ role: string; content: string }>,
    craftedTools: CraftedTool[],
    /** What the parent executor can run, in preference order. */
    languages: readonly [string, ...string[]],
    /** Trusted parent mode. A branch cannot select or downgrade this value. */
    mode: WorkMode,
    /** Distinct solution angles assigned to this branch's siblings in the same
     *  expansion. Threaded so each branch proposes something DISTINCT (MCTS
     *  branches explore in parallel and never see a sibling's output). Optional
     *  so backends/tests that don't enforce diversity still satisfy the type. */
    siblings?: readonly string[],
  ): Promise<BranchExploration>;
  /**
   * Write a post-mortem on this branch's own attempt.
   *
   * `outcome` is the environment's verdict the engine already read while
   * scoring — "the proposed code ran and FAILED: …". Omitted when nothing was
   * executed (prose, plan mode, an unrunnable language): a branch that never
   * reached the environment has no verdict to be shown, and inventing one
   * would put a claim nobody observed into MEMORY.md.
   */
  generateReflection(task: string, outcome?: string): Promise<BranchReflection>;
}

/** Factory for creating isolated branch agents — injected by the backend */
export type SpawnBranch = (branchId: string) => Promise<BranchHandle>;
/**
 * MID-FLIGHT eviction of a branch agent: stop it, but KEEP whatever it has
 * recorded. Used while the branch may still be read — the search prunes a node
 * it has stopped selecting, or a cancellation cuts an in-flight expansion
 * short — so it must not destroy state.
 */
export type AbortBranch = (branchId: string, reason?: string) => Promise<void>;
/**
 * TERMINAL release of a branch agent: it will never be read again, so the
 * backend gives its resources back (CF wipes the facet's SQLite; the CLI reaps
 * the child process).
 *
 * Deliberately separate from {@link AbortBranch}. A branch's recorded traces are
 * wanted right up to the end of its iteration, because that is where
 * `generateReflection` reads them, so the only safe release point is the
 * expansion's `finally` — after exploring, scoring and reflecting are all done.
 * Collapsing the two verbs destroys a branch that is still being reflected on in
 * one direction and leaks its storage forever in the other; the CF backend did
 * the latter for every branch of every search.
 */
export type ReleaseBranch = (branchId: string) => Promise<void>;

export interface AgentRuntime {
  storage: Storage;
  /**
   * Where this agent's own state lives, when that is not the same tree as
   * `storage.vfs`. SOUL.md, the scaffold, memory and transcripts are what the
   * agent knows about ITSELF, and a backend whose canonical file plane is a
   * shared physical directory must not write them there: peers would overwrite
   * each other's identity, and the user's project would carry files that are
   * not the user's.
   *
   * Absent when the two coincide — a hosted workspace's plane IS its own
   * durable filesystem — so every reader spells the fallback
   * `agentStateVfs ?? storage.vfs` and gets the one right tree either way.
   */
  agentStateVfs?: VFS;
  memory: Memory;
  executor: Executor;
  llm: LLM;
  schedule: Schedule;
  identity: Identity;
  craftStore: CraftStore;
  /** Second LLM for cross-model judging (different model from the explorer) */
  judgeModel?: LLM;
  /**
   * The chat vendor's small tier, for MECHANICAL work — outcome
   * classification, pathology labels, one-sentence reflections, pattern
   * extraction, sleep-time compression. Same vendor, same credential, cheaper
   * model (providers/fast-model.ts selectFastModel).
   *
   * Optional, and every reader falls back to `llm`, so a backend that wires
   * none simply keeps today's behaviour. Never used for user-visible
   * generation or for anything that authors a scaffold: those stay on the
   * model the user chose.
   */
  fastLlm?: LLM;
  /**
   * The turn reviewer's model (advisor/review.ts). Reviewing work, so its
   * unset default is the cross-vendor pick — the same reason `judgeModel` is
   * cross-family, applied to the one producer that speaks into the
   * conversation.
   *
   * Absent when this backend wires no reviewer, and then the advisor lane does
   * nothing whatever the owner set. That is the state the conformance manifest
   * declares per root, so a reviewer missing on one backend is a stated fact
   * rather than a quiet one.
   */
  advisorLlm?: LLM;
  /** Platform-specific branch spawning — injected by CF or CLI backend */
  spawnBranch: SpawnBranch;
  abortBranch: AbortBranch;
  releaseBranch: ReleaseBranch;
  /**
   * Multi-executor routing. Manages named executor providers (workspace,
   * nimbus, sandbox, laptop) for the codemode sandbox. Optional — core
   * code that doesn't need multi-executor support ignores this field.
   */
  executionRouter?: ExecutionRouter;
  /**
   * POSIX shell bound to the agent's VFS. Supplied by the backend adapter
   * (CF: createShell(sqliteFS); CLI: createShell(sqliteFS)). The `run` tool
   * reads this directly for workspace-scoped commands; absence degrades to
   * router-only routing.
   */
  shell?: Shell;
  /**
   * Shadow-git file checkpoints over REAL filesystems (the local exec cwd /
   * device project dirs). Backends with host filesystem access supply an
   * engine; absence simply means no /undo for that backend's file surface.
   */
  checkpoints?: FileCheckpoints;
  /**
   * Attach or detach the interactive channel for 'gate'-tier shell approvals
   * under 'strict' mode (the CLI's ACP `session/request_permission`).
   * `shell` and every `executionRouter` provider read it LIVE at exec time
   * (safety/approval-gate.ts's ShellApprovalPolicy), so attaching/detaching
   * takes effect on the very next command — no toolset rebuild needed.
   * Backends with no interactive surface (CF) never call this; 'strict'
   * keeps its explanatory refusal there, same as before this field existed.
   */
  setShellApprovalChannel?: (fn: RequestShellApproval | null) => void;
  /** Bind the current turn's file ledger after the backend loop exists. The
   * execution router is built first and reads this provider lazily, so native
   * `file` and codemode `workspace.*` enforce one read-before-write history. */
  setTurnFileLedgerProvider?: (provider: (() => TurnFileLedger | undefined) | null) => void;
}
