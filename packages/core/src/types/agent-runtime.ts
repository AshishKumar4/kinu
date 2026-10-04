import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/** The one struct the agent core receives, constructed per backend. See docs/ARCHITECTURE.md
 *  "Backends and the AgentRuntime contract". */

import type { Storage, Memory, Executor, LLM, Schedule, Identity, Shell } from './primitives';
import type { CraftStore as SqlCraftStore } from '@kinu.run/agent-utils';
import type { ExecutionRouter } from '../execution/types';
import type { DeviceTransport } from '../execution/device-tunnel-executor';
import type { FileCheckpoints } from '../checkpoints/types';
import type { ShellApprovalRequest, ShellApprovalOutcome } from '../safety/approval-gate';
import type { TurnFileLedger } from '../vfs/file-ledger';
import type { PathPlanes } from '../vfs/resolve';
import type { ActorHandle } from '../identity/actor-handle';
import type { DecisionPort } from '../providers/decision-model';

/** Live channel for 'gate'-tier shell approvals (ACP `session/request_permission`). */
export type RequestShellApproval = (req: ShellApprovalRequest) => Promise<ShellApprovalOutcome | null>;

export type CraftStore = Pick<SqlCraftStore, 'create' | 'update' | 'get' | 'delete' | 'list' | 'search'>;

export interface AgentRuntime {
  readonly actor: ActorHandle;
  storage: Storage;
  /** The agent's own state (SOUL.md, scaffold, memory, transcripts) when a shared file plane
   *  must not hold it. Absent when they coincide; readers use `agentStateVfs ?? storage.vfs`. */
  agentStateVfs?: VFS;
  /** `storage.vfs` as the agent's own file tools reach it: gated past its own files. */
  toolFiles: VFS;
  /** Where each `root://` plane, `~` and a relative path land on this machine. */
  readonly planes: PathPlanes;
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
  /** The decision model that rates a turn from the user's reply (evolution/ratings.ts). Absent: turns stay unrated. */
  decide?: DecisionPort;
  /** Named executor providers (workspace, nimbus, sandbox, device) for the codemode sandbox. */
  executionRouter?: ExecutionRouter;
  /** Device-fleet transport (CF), feeding the dynamic context's fleet roster; absent in the CLI. */
  deviceTransport?: DeviceTransport;
  /** POSIX shell bound to the agent's VFS; absent degrades the `shell` tool to router-only. */
  shell?: Shell;
  readonly nodeIsolated?: boolean;
  /** Shadow-git checkpoints over real filesystems; absent means no /undo for that surface. */
  checkpoints?: FileCheckpoints;
  /** Read at exec time, so attaching takes effect on the next command; CF never calls it. */
  setShellApprovalChannel?: (fn: RequestShellApproval | null) => void;
  /** Read lazily by the router, so native `file` and codemode `workspace.*` share one
   *  read-before-write history. */
  setTurnFileLedgerProvider?: (provider: (() => TurnFileLedger | undefined) | null) => void;
  /** Called once as the actor leaves the host. */
  release?(): void;
}
