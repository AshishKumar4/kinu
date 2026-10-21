import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/** The one struct the agent core receives, constructed per backend. See docs/ARCHITECTURE.md
 *  "Backends and the AgentRuntime contract". */

import type { Storage, Memory, Executor, LLM, RoutedLLM, Schedule, Identity, Shell } from './primitives';
import type { CraftStore as SqlCraftStore } from '@kinu.run/agent-utils';
import type { ExecutionRouter } from '../execution/types';
import type { DeviceTransport } from '../execution/device-tunnel-executor';
import type { FileCheckpoints } from '../checkpoints/types';
import type { ShellApprovalRequest, ShellApprovalOutcome } from '../safety/approval-gate';
import type { PathPlanes } from '../vfs/resolve';
import type { VfsMountRouting } from '../vfs/mounts';
import type { ActorHandle } from '../identity/actor-handle';
import type { DecisionPort } from '../providers/decision-model';

/** Live channel for 'gate'-tier shell approvals (ACP `session/request_permission`). */
/** A prompt in front of the owner; `signal` aborts once another surface decided the ask's row. */
export type RequestShellApproval = (req: ShellApprovalRequest, signal: AbortSignal) => Promise<ShellApprovalOutcome | null>;

export type CraftStore = Pick<SqlCraftStore, 'create' | 'update' | 'get' | 'delete' | 'list' | 'search'>;

export interface AgentRuntime {
  readonly actor: ActorHandle;
  storage: Storage;
  /** The agent's own state (SOUL.md, scaffold, memory, transcripts): its own plane where a shared file plane must not
   *  hold it, else `storage.vfs` itself. */
  agentStateVfs: VFS;
  /** `storage.vfs` as the agent's own file tools reach it: gated past its own files. */
  toolFiles: VFS & Partial<Pick<VfsMountRouting, 'resolve' | 'owner'>>;
  /** Where each `root://` plane, `~` and a relative path land on this machine. */
  readonly planes: PathPlanes;
  memory: Memory;
  executor: Executor;
  llm: LLM;
  schedule: Schedule;
  identity: Identity;
  craftStore: CraftStore;
  /** Cross-model judge, a different model from the explorer: the deep tier (`MODEL_ROUTE_POLICY.judge`), which also
   *  drafts a dream's edits through its structured output. */
  judgeModel?: RoutedLLM;
  /** The fast tier (`MODEL_ROUTE_POLICY.fast`) for mechanical work, answering to a schema where the work reads one
   *  back; readers of plain text fall back to `llm`. Never for user-visible generation or scaffold authoring. */
  fastLlm?: RoutedLLM;
  /** The decision model that rates a turn from the user's reply (evolution/ratings.ts). Absent: turns stay unrated. */
  decide?: DecisionPort;
  /** Named executor providers (workspace, nimbus, sandbox, device) for the codemode sandbox. */
  executionRouter?: ExecutionRouter;
  /** Device-fleet transport (CF), feeding the dynamic context's fleet roster; absent in the CLI. */
  deviceTransport?: DeviceTransport;
  /** POSIX shell bound to the agent's VFS; absent degrades the `shell` tool to router-only. */
  shell?: Shell;
  /** Shadow-git checkpoints over real filesystems; absent means no /undo for that surface. */
  checkpoints?: FileCheckpoints;
  /** Read at exec time, so attaching takes effect on the next command; CF never calls it. */
  setShellApprovalChannel?: (fn: RequestShellApproval | null) => void;
  /** Read lazily by the router, so native `file` and codemode `workspace.*` share one
   *  read-before-write history. */
  /** Called once as the actor leaves the host. */
  release?(): void;
}
