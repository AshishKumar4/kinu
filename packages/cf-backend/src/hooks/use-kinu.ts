/**
 * Kinu agent hooks — useAgent() + useAgentChat() from Agents SDK.
 */

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useAgent } from "agents/react";
import {
  activateMctsProgressActor, applyMctsProgress, createMctsProgressState,
  branchHeadId, ORCHESTRATOR_AGENT_SLUG, SUBORDINATE_AGENT_SLUG,
  type AgentViewSummary, type PendingAction, type PlanReview, type RoleSelection,
} from "@kinu.run/core";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { FileUIPart, UIMessage } from "ai";
import * as v from "valibot";
import { explorationForkTree } from "../lib/fork-tree-rows";
import type {
  ToolInfo,
  MemoryEntry,
  ForkNode,
  BackgroundJob,
  ExecutorCommandResult,
  PendingConsent,
  Rpc,
  SubordinateActivityEvent,
  SubordinateRosterEntry,
  TabPresence,
} from "../lib/protocol";
import type { ExecutorInfo } from "../lib/executors";
import { applySignalCard, parseSignalCardEvent, type SignalCard } from "../components/background-event";
import {
  appendHeadDelta, retireHeadDelta, type HeadDelta, type HeadDeltas,
} from "../components/head-chat";
import type { InlineSteer } from "@kinu.run/core";
import { diagnostics, renderThrownChain, toKinuError, tolerate } from "@kinu.run/core/obs";
import {
  reconcilePreviewPorts,
  type ExecutorPortRefresh,
  type PinnedPreviewPort,
} from "../lib/preview-ports";
import {
  createSessionRecovery,
  fetchDeployedBuildSha,
  isNewerDeployedBuild,
  pageDeployedBuildSha,
  type SessionRecovery,
} from "./session-recovery";
import { abandonTurn, admitTurn, newSendLatch } from "./send-admission";
import type { AsyncResource } from "./use-async-resource";

export type { ExecutorInfo };

/** One command's row in the executor terminal's scrollback.
 *
 *  `stdout`/`stderr` are CLIPPED by the server; `stdout_len`/`stderr_len` are the
 *  stored lengths. The pane needs both because it must say what it withheld —
 *  showing a prefix as if it were the output is the lie this pair prevents. */
export interface ExecutorOutput {
  id: string; command: string;
  stdout: string; stdout_len: number;
  stderr: string; stderr_len: number;
  exit_code: number; created_at: number;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export interface KinuActorAddress {
  workspace: string;
  subordinate?: string;
}

const KinuActorAddressSchema = v.object({
  workspace: v.string(),
  subordinate: v.optional(v.string()),
});

/** One Steer-as-Branch run as the chat chip renders it — driven entirely by
 *  the server's branch_status broadcasts (single source of truth). */
export interface BranchRun {
  branchId: string;
  task: string;
  status: "running" | "settled" | "error";
  /** Settled: the persisted takes set + the turn it is claimed against. */
  takeSetId?: string;
  turnId?: string;
  /** Errored: the honest reason the branch produced no comparison. */
  message?: string;
}

/** One mid-turn steer as the chat renders it — driven entirely by the server's
 *  steer_status broadcasts, so every open tab agrees about whether the model
 *  has it yet.
 *
 *  `queued` and `landed` are deliberately separate: "we took your words" and
 *  "the model is reading them" are different facts, and collapsing them is how
 *  a composer ends up silently swallowing input. A `returned` steer is removed
 *  outright — an interrupt dropped it and it goes back to the composer.
 *
 *  The same shape the durable rows resolve to, so the thread places a live
 *  steer and the row it becomes through one function. See read-models/transcript.ts. */
export type { InlineSteer as SteerRun } from "@kinu.run/core";

/** A turn that ended without an answer, and whether the server is REPLAYING an
 *  older one rather than reporting this session's.
 *
 *  The distinction is the whole difference between "your turn just failed" and
 *  "the last thing that happened here failed, some time ago". The server keeps
 *  its terminal record until a later turn supersedes it, so a workspace left
 *  after a failure re-serves it on every connect. */
export interface ChatTurnError {
  body: string;
  replayed: boolean;
}

export interface ForkLineage {
  sourceWorkspaceId: string;
  sourceWorkspaceName: string;
  sourceMessageId: string;
  sourceMessageCreatedAt: number;
  forkedAt: number;
}

export interface AgentStatus {
  name: string;
  displayName: string;
  purpose: string;
  soul: string;
  createdAt: number;
  scaffoldVersion: number;
  searchNodeCount: number;
  craftedToolCount: number;
  messageCount: number;
  model: string;
  forkLineage: ForkLineage | null;
}

/** One-round-trip initial-load payload (server: getWorkspaceSnapshot).
 *
 *  Everything a workspace needs before the chat pane can paint, and nothing a
 *  surface that is not open needs. The exploration canvas and the run timeline
 *  used to ride along and were 95% of the bytes on every workspace open; the
 *  Exploration surface reads its own canvas page and nothing read the timeline
 *  at all. See the server RPC's note for the measurements. */
export interface WorkspaceSnapshot {
  status: AgentStatus;
  tools: ToolDescResult;
  memoryContent: string;

  executors: ExecutorInfo[];
  executorOutputs: Array<{ name: string; outputs: ExecutorOutput[] }>;
  lastActiveExecutor: string | null;
  /** The plan waiting on the owner, if any. On the snapshot because it decides
   *  the composer's mode and the opening surface: fetching it a beat later made
   *  a plan-gated workspace paint in build mode and then jump. */
  activePlan: unknown;
  /** Whether the gated right-pane tabs have content. On the snapshot so the
   *  strip is right from the first paint; re-read by the live cycle. */
  tabPresence: TabPresence;
  /** The steers the server has ACKNOWLEDGED and not yet landed, from its
   *  durable `pending_steers` rows. On the snapshot because a tab that
   *  reconnects learns queued work no live broadcast will repeat. */
  pendingSteers: InlineSteer[];
  /** Branch runs still running, from the durable head journal. Same reason:
   *  a branch that started or settled while this tab was gone is invisible to
   *  a state fed only by broadcasts. */
  branchRuns: Array<{ branchId: string; task: string; status: "running" }>;
}

const PlanAnnotationTextPositionSchema = v.object({
  parentTagName: v.string(),
  parentIndex: v.number(),
  textOffset: v.number(),
});
const PlanAnnotationMathTargetSchema = v.object({
  blockId: v.string(),
  tex: v.string(),
  displayMode: v.boolean(),
});
const PlanReviewSchema = v.object({
  id: v.string(),
  sessionId: v.string(),
  revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  content: v.string(),
  status: v.picklist(["pending", "changes_requested", "approved", "superseded"]),
  annotations: v.array(v.object({
    id: v.string(),
    blockId: v.string(),
    startOffset: v.number(),
    endOffset: v.number(),
    type: v.picklist(["DELETION", "COMMENT", "GLOBAL_COMMENT"]),
    text: v.optional(v.string()),
    originalText: v.string(),
    createdA: v.number(),
    author: v.optional(v.string()),
    startMeta: v.optional(PlanAnnotationTextPositionSchema),
    endMeta: v.optional(PlanAnnotationTextPositionSchema),
    mathTargets: v.optional(v.array(PlanAnnotationMathTargetSchema)),
  })),
  feedback: v.nullable(v.string()),
  handoffAccepted: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
  decidedAt: v.nullable(v.number()),
});

const MctsRowSchema = v.object({
  id: v.string(),
  parent_id: v.nullable(v.string()),
  root_id: v.optional(v.nullable(v.string())),
  depth: v.number(),
  visits: v.number(),
  value: v.number(),
  status: v.picklist(["open", "pruned", "terminal", "failed", "running"]),
  action: v.string(),
  task: v.string(),
  observation: v.string(),
  code_used: v.optional(v.nullable(v.string())),
  branch_agent_key: v.optional(v.nullable(v.string())),
  msg_id: v.optional(v.nullable(v.string())),
  created_at: v.optional(v.number()),
});

const MctsProgressUsageSchema = v.object({
  input: v.optional(v.number()),
  output: v.optional(v.number()),
  cacheRead: v.optional(v.number()),
  cacheWrite: v.optional(v.number()),
  cacheWrite1h: v.optional(v.number()),
  reasoning: v.optional(v.number()),
  neurons: v.optional(v.number()),
});

const MctsProgressHeadSchema = v.object({
  rootId: v.string(),
  task: v.string(),
  rationale: v.string(),
  status: v.string(),
  spawnedAt: v.number(),
  heads: v.array(v.object({
    id: v.string(),
    parentId: v.nullable(v.string()),
    depth: v.number(),
    task: v.string(),
    rationale: v.string(),
    status: v.string(),
    summary: v.nullable(v.string()),
    errorMessage: v.nullable(v.string()),
    usage: MctsProgressUsageSchema,
    wallClockMs: v.number(),
    spawnedAt: v.number(),
    lastStepAt: v.nullable(v.number()),
    decisions: v.array(v.object({
      question: v.string(),
      choice: v.string(),
      rationale: v.string(),
    })),
  })),
  merge: v.nullable(v.object({
    narrative: v.string(),
    headCount: v.number(),
    totalTokens: v.nullable(v.number()),
  })),
});

const MctsProgressMessageSchema = v.object({
  type: v.literal("mcts-progress"),
  rootId: v.string(),
  isolateGen: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  pushSeq: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  nodes: v.array(MctsRowSchema),
  head: v.nullable(MctsProgressHeadSchema),
});

export type MctsProgress = v.InferOutput<typeof MctsProgressMessageSchema>;

const SubordinateRosterEntrySchema = v.object({
  name: v.string(),
  displayName: v.string(),
  role: v.string(),
  nameOrigin: v.optional(v.picklist(["user", "auto"])),
  createdBy: v.picklist(["orchestrator", "user"]),
  status: v.picklist(["idle", "working", "awaiting_input", "dismissed"]),
  currentTask: v.nullable(v.string()),
  createdAt: v.number(),
  dismissedAt: v.nullable(v.number()),
});

const SubordinateMutationEnvelopeSchema = v.object({
  subordinate: SubordinateRosterEntrySchema,
});

const SubordinateActivityEventSchema = v.object({
  type: v.literal("subordinate_event"),
  id: v.string(),
  kind: v.picklist(["task", "report"]),
  subordinate: v.string(),
  status: v.optional(v.string()),
  content: v.string(),
  task: v.optional(v.string()),
  timestamp: v.number(),
});

const SocketMessageSchema = v.variant("type", [
  v.object({ type: v.literal("workspace_renamed"), displayName: v.optional(v.string()) }),
  // The server's statement of what this conversation IS, sent unconditionally
  // on an idle connect (`Think._buildIdleConnectMessages`). Its ARRIVAL is what
  // the chat pane waits on — the payload is the SDK's business, so nothing is
  // parsed out of it here.
  v.looseObject({ type: v.literal("cf_agent_chat_messages") }),
  v.object({
    type: v.literal("cf_agent_use_chat_response"),
    error: v.optional(v.boolean()), done: v.optional(v.boolean()), body: v.optional(v.string()),
    id: v.optional(v.string()),
  }),
  // The server announcing which request id it is about to resume. For a
  // RETAINED terminal record that id is the failed turn's, and the error frame
  // that follows carries the same one — which is how a replay is told from a
  // live failure without guessing.
  v.object({ type: v.literal("cf_agent_stream_resuming"), id: v.string() }),
  MctsProgressMessageSchema,
  v.object({
    type: v.literal("device_consent"), consentId: v.string(), deviceLabel: v.string(),
    method: v.optional(v.string()), command: v.string(),
    scope: v.picklist(["all_local_actions", "full_filesystem"]),
    workspaceName: v.optional(v.nullable(v.string())),
  }),
  v.object({ type: v.literal("device_consent_resolved"), consentId: v.string() }),
  v.object({ type: v.literal("work_cancelled") }),
  v.object({ type: v.literal("pending_actions_changed") }),
  v.object({
    type: v.literal("branch_status"), branchId: v.string(), task: v.optional(v.string()),
    status: v.optional(v.string()), takeSetId: v.optional(v.string()),
    turnId: v.optional(v.string()), message: v.optional(v.string()),
  }),
  v.object({ type: v.literal("head_activity"), headId: v.string() }),
  /** Transient intra-step output from a running head — the provider's own
   *  deltas, in the two streams it separates. Best-effort paint: the durable
   *  step is the truth, and `head_activity` above retires this. */
  v.object({
    type: v.literal("head_stream"), headId: v.string(),
    kind: v.picklist(["text", "reasoning"]), delta: v.string(),
  }),
  v.object({
    type: v.literal("steer_status"), steerId: v.string(), text: v.string(),
    status: v.picklist(["queued", "landed", "returned"]),
    /** Present on `landed`: the step of the running turn the model read it in,
     *  which is where the thread draws it. */
    atStep: v.optional(v.number()),
  }),
  v.looseObject({ type: v.literal("signal_card") }),
  v.object({ type: v.literal("plan_updated"), plan: PlanReviewSchema }),
  v.object({ type: v.literal("subordinates_changed"), subordinates: v.array(SubordinateRosterEntrySchema) }),
  SubordinateActivityEventSchema,
  v.object({
    type: v.literal("executor-output"), executor: v.string(), command: v.string(),
    stdout: v.optional(v.string()), stderr: v.optional(v.string()),
    exitCode: v.optional(v.number()), timestamp: v.number(),
  }),
]);

function parseSocketMessage(data: MessageEvent["data"]) {
  const text = v.safeParse(v.string(), data);
  if (!text.success) return null;
  // A frame that is not JSON is not one of ours. Any other failure here is a
  // real fault and must not be read back as "no message".
  const decoded = v.safeParse(
    SocketMessageSchema,
    tolerate<unknown>(() => JSON.parse(text.output), "malformed-input"),
  );
  return decoded.success ? decoded.output : null;
}


/** Runtime admission for plan broadcasts/RPC results. The browser treats the
 * actor boundary as untrusted even though both ends share the TypeScript type. */
export function parsePlanReview<Value>(value: Value): PlanReview | null {
  const parsed = v.safeParse(PlanReviewSchema, value);
  return parsed.success ? parsed.output : null;
}
/** Where a surfaced failure came from — each source owns (and clears) its own
 *  message so a recovery in one never hides a still-broken other.
 *
 *  Every entry is a READ of this actor, the one-round-trip snapshot included:
 *  they fail together when the transport does. Each source stores the bare
 *  reason and never a sentence, because the sentence has one author, below. */
export type LiveRefreshSource =
  | "snapshot"
  | "roster"
  | "jobs"
  | "pendingActions"
  | "presence"
  | "mcts"
  | "memoryContent"
  | "tools"
  | "executors"
  | "views"
  | "consents"
  | "consentResolution"
  | "plan";

export type LiveRefreshErrors = Partial<Record<LiveRefreshSource, string>>;

interface LiveRefreshDescriptor {
  source: LiveRefreshSource;
  label: string;
}

const LIVE_REFRESH_DESCRIPTORS: readonly LiveRefreshDescriptor[] = [
  { source: "snapshot", label: "this workspace" },
  { source: "roster", label: "the agent roster" },
  { source: "jobs", label: "background jobs" },
  { source: "pendingActions", label: "pending actions" },
  { source: "mcts", label: "MCTS" },
  { source: "memoryContent", label: "memory content" },
  { source: "tools", label: "tools" },
  { source: "presence", label: "tab presence" },
  { source: "executors", label: "executors" },
  { source: "views", label: "agent views" },
  { source: "consents", label: "device consents" },
  { source: "consentResolution", label: "device consents" },
  { source: "plan", label: "active plan" },
];

/** The live sources the workspace snapshot reads for itself (`loadAllData`).
 *  A snapshot that landed IS a fresh read of each of them, so its success
 *  clears their failures: leaving them set left the banner reporting stale
 *  data for surfaces the same round trip had just refreshed, and across a
 *  flapping socket no 5s poll ever completed to clear them. */
const SNAPSHOT_SEEDED_SOURCES: readonly LiveRefreshSource[] = [
  "memoryContent",
  "tools",
  "executors",
  "presence",
  "plan",
];

/** A failed read, plus the two failures that belong to an action the user
 *  asked for: those name what did not happen, which no refresh sentence can
 *  say for them, so they keep their own prose. */
type ErrorSource = LiveRefreshSource | "model" | "memory";

export type WorkspaceErrors = Partial<Record<ErrorSource, string>>;

type LiveRefreshReporter = (source: LiveRefreshSource, message: string | null) => void;
type ConsentResolutionReporter = (consentId: string, message: string | null) => void;

export interface LiveRefreshAdmission {
  activateActor(actorKey: string): void;
  admit(actorKey: string, requestKey: string): () => boolean;
  invalidateActor(actorKey: string): void;
}

export function createLiveRefreshAdmission(): LiveRefreshAdmission {
  let activeActor: string | null = null;
  let actorEpoch = 0;
  let requestSequence = 0;
  const latestRequest = new Map<string, number>();
  const advanceActor = (actorKey: string | null) => {
    activeActor = actorKey;
    actorEpoch += 1;
    latestRequest.clear();
  };
  return {
    activateActor(actorKey) {
      advanceActor(actorKey);
    },
    admit(actorKey, requestKey) {
      const admittedActor = actorEpoch;
      if (actorKey !== activeActor) return () => false;
      const requestId = ++requestSequence;
      latestRequest.set(requestKey, requestId);
      return () => actorKey === activeActor
        && admittedActor === actorEpoch
        && latestRequest.get(requestKey) === requestId;
    },
    invalidateActor(actorKey) {
      if (actorKey === activeActor) advanceActor(null);
    },
  };
}

/**
 * Every failed read's label, and the distinct reasons behind them.
 *
 * A snapshot failure SUBSUMES the surfaces the snapshot re-reads when they
 * failed on its reason: that is one round trip dropping, and naming each of its
 * five surfaces beside the workspace is one outage listed six times. A seeded
 * surface that failed for a reason of its own keeps its label.
 */
function collectReadFailures(errors: LiveRefreshErrors) {
  const subsumed = errors.snapshot;
  const labels: string[] = [];
  const reasons: string[] = [];
  for (const descriptor of LIVE_REFRESH_DESCRIPTORS) {
    const reason = errors[descriptor.source];
    if (!reason) continue;
    if (!reasons.includes(reason)) reasons.push(reason);
    if (reason === subsumed && SNAPSHOT_SEEDED_SOURCES.includes(descriptor.source)) continue;
    if (!labels.includes(descriptor.label)) labels.push(descriptor.label);
  }
  return { labels, reasons };
}

/**
 * The one line the workspace banner shows.
 *
 * `loaded` is whether this workspace has ever produced a snapshot. Until it
 * has there is no last known data, so a failed read is a failed OPEN and the
 * line says that: "Showing last known data" over a workspace that has never
 * shown any is a claim about data the reader cannot see.
 *
 * Every read shares one sentence and each distinct reason appears once. One
 * dropped connection fails the snapshot and every poll in the same instant,
 * and this banner used to print that single reason twice in one line:
 *
 *   Workspace snapshot failed: Network connection lost. Couldn't refresh live
 *   data for memory content. Showing last known data. Network connection lost.
 */
export function formatWorkspaceError(errors: WorkspaceErrors, loaded: boolean): string | null {
  const { labels, reasons } = collectReadFailures(errors);
  // The labels are a noun list; the reasons are whatever an RPC rejected with,
  // so they are set down one after another rather than conjoined — "Network
  // connection lost. and MEMORY.md is unreadable" is not a sentence.
  const read = labels.length === 0
    ? null
    : loaded
      ? `Couldn't refresh ${formatNaturalList(labels)}. Showing last known data. ${reasons.join(" ")}`
      : `Couldn't open this workspace. ${reasons.join(" ")}`;
  return combineErrorMessages(errors.model ?? errors.memory ?? null, read);
}

/** What one snapshot load settled as. `superseded` is neither outcome: a newer
 *  load, or a different actor, took the surface while this one was in flight,
 *  so it reports nothing and nothing may be scheduled for it. */
export type SnapshotLoad = "loaded" | "superseded" | { failed: string };

/**
 * Read the workspace snapshot and settle every source it speaks for.
 *
 * The snapshot is a read like any poll, so it is admitted the same way: its own
 * key for the load, plus one per surface it re-seeds. A snapshot that landed IS
 * a fresh read of each of those surfaces, so its success clears their failures
 * — except any whose own refresh was admitted after this load started, because
 * that read is newer and owns the surface.
 *
 * The reason is returned rather than acted on: the retry cadence belongs to the
 * caller, and nothing else has to interpret a transport error.
 */
export async function loadWorkspaceSnapshot(
  read: (
    isCurrent: () => boolean,
    isSourceCurrent: (source: LiveRefreshSource) => boolean,
  ) => Promise<void>,
  report: LiveRefreshReporter,
  admit: (requestKey: LiveRefreshSource) => () => boolean,
  seeded: readonly LiveRefreshSource[],
): Promise<SnapshotLoad> {
  const isCurrent = admit("snapshot");
  const seededReads = new Map(
    seeded.map((source) => [source, admit(source)] as const),
  );
  const isSourceCurrent = (source: LiveRefreshSource): boolean =>
    seededReads.get(source)?.() ?? false;
  try {
    await read(isCurrent, isSourceCurrent);
    if (!isCurrent()) return "superseded";
    report("snapshot", null);
    for (const [source, stillCurrent] of seededReads) if (stillCurrent()) report(source, null);
    return "loaded";
  } catch (error) {
    if (!isCurrent()) return "superseded";
    const failed = errorMessage(error);
    report("snapshot", failed);
    return { failed };
  }
}

export async function refreshLiveResource<Value>(
  source: LiveRefreshSource,
  read: () => Promise<Value>,
  apply: (value: Value) => void,
  report: LiveRefreshReporter,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return;
  try {
    const value = await read();
    if (!isCurrent()) return;
    apply(value);
    report(source, null);
  } catch (error) {
    if (!isCurrent()) return;
    report(source, errorMessage(error));
  }
}

export type ConsentDecision = "once" | "always" | "deny";

export function resolvePendingConsent(
  consentId: string,
  decision: ConsentDecision,
  resolve: (id: string, choice: ConsentDecision) => Promise<void>,
  remove: (id: string) => void,
  report: ConsentResolutionReporter,
  isCurrent: () => boolean,
): Promise<void> {
  return refreshLiveResource(
    "consentResolution",
    () => resolve(consentId, decision),
    () => remove(consentId),
    (_source, message) => report(consentId, message),
    isCurrent,
  );
}

/** Initial-load retry backoff. Doubling from 1s, capped so a long outage keeps
 *  a slow heartbeat instead of hammering the DO. */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** Memory search fires from an onChange handler, so it settles on the typed
 *  query rather than issuing an RPC per keystroke. */
const MEMORY_SEARCH_DEBOUNCE_MS = 200;

/**
 * The cadence every surface-level read the server never pushes runs at.
 *
 * Exported because a surface that renders TWO of those reads side by side has
 * to poll both on the same clock or it will contradict itself: the needs-you
 * queue and the journal below it are the same ledger seen twice, and the
 * journal reading once at mount while the queue re-read every tick is exactly
 * how "1 self-change you have not seen" ended up over "nothing has settled".
 */
export const LIVE_DATA_REFRESH_MS = 5_000;

interface CallableAgent {
  call<T>(method: string, args: unknown[]): Promise<T>;
}

function bindRpc(agent: CallableAgent): Rpc {
  return <T = unknown>(method: string, args: unknown[] = []) => agent.call<T>(method, args);
}

/** A lightweight agent connection for surfaces that only need callable RPCs. */
export function useWorkspaceRpc(agentId: string) {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const agent = useAgent({
    agent: ORCHESTRATOR_AGENT_SLUG,
    name: agentId,
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(() => setConnectionStatus("error"), []),
  });
  const rpc = useMemo(() => bindRpc(agent), [agent]);
  return { rpc, connectionStatus };
}


/**
 * Full agent hook for WorkspacePage — connects to a specific DO instance.
 * Fetches all surface data via @callable RPCs on connect.
 */
export function useKinu(target?: string | KinuActorAddress) {
  const targetString = v.safeParse(v.string(), target);
  const targetAddress = v.safeParse(KinuActorAddressSchema, target);
  const workspace = targetString.success
    ? targetString.output
    : targetAddress.success ? targetAddress.output.workspace : undefined;
  const subordinate = targetAddress.success ? targetAddress.output.subordinate : undefined;
  const actorAddress = useMemo<KinuActorAddress>(() => {
    const address: KinuActorAddress = { workspace: workspace || "default" };
    if (subordinate) address.subordinate = subordinate;
    return address;
  }, [workspace, subordinate]);
  const actorKey = useMemo(
    () => JSON.stringify([actorAddress.workspace, subordinate ?? null]),
    [actorAddress.workspace, subordinate],
  );
  const isSubordinate = subordinate !== undefined;
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [memory, setMemory] = useState<MemoryEntry[]>([]);
  const [mctsTrees, setMctsTrees] = useState<ReadonlyMap<string, ForkNode>>(new Map());
  const [memoryContent, setMemoryContent] = useState<string>("");
  // Failures keyed by source, so one source recovering never erases another's
  // error, and none of them expire on a timer: an unread failure that quietly
  // vanishes leaves the surfaces it broke looking authoritative.
  const [errors, setErrors] = useState<Partial<Record<ErrorSource, string>>>({});
  const [consentResolutionErrors, setConsentResolutionErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const setSourceError = useCallback((source: ErrorSource, message: string | null) => {
    setErrors((prev) => {
      if ((prev[source] ?? null) === message) return prev;
      const next = { ...prev };
      if (message) next[source] = message; else delete next[source];
      return next;
    });
  }, []);
  const setConsentResolutionError = useCallback((consentId: string, message: string | null) => {
    setConsentResolutionErrors((previous) => {
      if ((previous.get(consentId) ?? null) === message) return previous;
      const next = new Map(previous);
      if (message) next.set(consentId, message); else next.delete(consentId);
      return next;
    });
  }, []);
  const liveRefreshAdmissionRef = useRef<LiveRefreshAdmission | null>(null);
  if (liveRefreshAdmissionRef.current === null) {
    liveRefreshAdmissionRef.current = createLiveRefreshAdmission();
  }
  const liveRefreshAdmission = liveRefreshAdmissionRef.current;
  const refreshCurrentLiveResource = useCallback(<Value,>(
    source: LiveRefreshSource,
    read: () => Promise<Value>,
    apply: (value: Value) => void,
  ) => refreshLiveResource(
    source,
    read,
    apply,
    setSourceError,
    liveRefreshAdmission.admit(actorKey, source),
  ), [actorKey, liveRefreshAdmission, setSourceError]);
  useEffect(() => {
    liveRefreshAdmission.activateActor(actorKey);
    return () => liveRefreshAdmission.invalidateActor(actorKey);
  }, [actorKey, liveRefreshAdmission]);
  const consentResolutionReasons = [...new Set(consentResolutionErrors.values())];
  const liveErrors = consentResolutionReasons.length === 0
    ? errors
    : { ...errors, consentResolution: formatNaturalList(consentResolutionReasons) };
  // `agentStatus` is written only by a completed snapshot and cleared only by a
  // workspace switch, so it IS "this workspace has last known data" — the fact
  // the banner needs to choose its sentence and the panes need before any of
  // them may say "none".
  const snapshot: AsyncResource<AgentStatus> = errors.snapshot !== undefined
    ? { status: "error", message: errors.snapshot, last: agentStatus }
    : agentStatus === null ? { status: "loading" } : { status: "ready", value: agentStatus };
  const error = formatWorkspaceError(liveErrors, agentStatus !== null);
  const [executors, setExecutors] = useState<ExecutorInfo[]>([]);
  const [executorOutputs, setExecutorOutputs] = useState<Map<string, ExecutorOutput[]>>(new Map());
  const [lastActiveExecutor, setLastActiveExecutor] = useState<string | null>(null);
  // Pinned ports for canonical-workspace and sandbox previews. Refreshed with the live-data
  // poll on every surface so auto-switch-to-preview, the Output badge and the
  // Environment preview auto-focus stay live wherever the user is. Listing
  // ports never provisions a sandbox: getExposedPorts returns [] server-side
  // unless the executor is already active.
  const [pinnedPorts, setPinnedPorts] = useState<PinnedPreviewPort[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const exposedPortsRefreshGeneration = useRef(0);
  const subordinateRefreshGeneration = useRef(0);
  // Background jobs (auto-detached >30s tool calls) — single source for the
  // Work surface's Now half and its journal.
  const [backgroundJobs, setBackgroundJobs] = useState<BackgroundJob[]>([]);
  // Dashboards Kinu published for this workspace — the agent-authored tabs
  // at the right of the work-surface strip. Refreshed with the rest of the
  // live data, because publishing one is a mid-turn `workspace.createView`.
  const [agentViews, setAgentViews] = useState<AgentViewSummary[]>([]);
  // Pending device-consent requests — an agent wants to use a connected device;
  // the chat renders a card and the user decides (ask-once-then-remember).
  const [pendingConsents, setPendingConsents] = useState<PendingConsent[]>([]);
  // Everything asynchronous waiting on the owner — pending release approvals,
  // a scaffold version under trial, failed jobs, unseen self-changes,
  // curriculum proposals. ONE read behind both the Work tab's queue and the one
  // accent badge on the strip, so the badge can never say something the queue
  // does not show. Host-owned: see the RPC's note on VIEW_DATA_SOURCES.
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  // Whether the gated right-pane tabs (Releases, Exploration) have content.
  // Seeded by the snapshot, refreshed with the live cycle; a fresh workspace
  // starts with neither tab until its first release change or search run.
  const [tabPresence, setTabPresence] = useState<TabPresence>({ releases: false, explorations: false });
  // Unseen self-changes, kept only for the sidebar roster's dot — the tab badge
  // is the queue's length now.
  const [changelogUnseen, setChangelogUnseen] = useState(0);
  // Steer-as-Branch runs — the split progress chips near the streaming answer.
  const [branchRuns, setBranchRuns] = useState<BranchRun[]>([]);
  // Per-branch write counter, bumped by the `head_activity` broadcast. Counts
  // rather than timestamps: an open transcript only has to notice that ITS
  // branch moved, and a counter says that unambiguously without a clock the two
  // ends would have to agree on. Keyed by head id — a Map because the keys are
  // whatever branches this workspace has run.
  const [headActivity, setHeadActivity] = useState<ReadonlyMap<string, number>>(new Map());
  const bumpHeadActivity = useCallback((headId: string) => {
    setHeadActivity((previous) => {
      const next = new Map(previous);
      next.set(headId, (previous.get(headId) ?? 0) + 1);
      return next;
    });
  }, []);
  /**
   * The step each running head is writing but has not journalled yet, keyed by
   * head id — its prose and its reasoning, because `head_stream` carries the
   * provider's own deltas and the provider separates those two streams.
   *
   * EPHEMERAL AND SUBORDINATE. The durable step is the truth; this exists only
   * so the step being written is visible while it is written. It is retired the
   * moment that step lands — by the `head_activity` push, by a reader whose own
   * re-read found the step (`HeadDeltas.retire`), by a branch reaching a
   * terminal status, by a cancelled turn, and by the socket dropping. Nothing
   * reads it back, nothing persists it, and a dropped delta needs no repair:
   * the step that replaces it arrives anyway.
   */
  const [headDeltaMap, setHeadDeltaMap] = useState<ReadonlyMap<string, HeadDelta>>(new Map());
  const retireDelta = useCallback((headId: string) => {
    setHeadDeltaMap((previous) => retireHeadDelta(previous, headId));
  }, []);
  // Nothing is being written any more: the socket went away, or the work did.
  const forgetDeltas = useCallback(() => { setHeadDeltaMap(new Map()); }, []);
  const headDeltas = useMemo<HeadDeltas>(() => ({
    get: (headId) => headDeltaMap.get(headId),
    retire: retireDelta,
  }), [headDeltaMap, retireDelta]);
  // Mid-turn steers — what the user typed while the agent was working, shown in
  // the thread from the moment the server takes it until the durable user row
  // it becomes arrives in `messages`.
  const [steerRuns, setSteerRuns] = useState<InlineSteer[]>([]);
  // Chat-turn error — the turn failed (provider error, stream break) and the
  // error card in the thread shows the honest body. Fed by BOTH channels a
  // terminal error can arrive on: useChat's live stream error, and the
  // on-connect `cf_agent_use_chat_response` replay frame (whose request id is
  // no longer active, so the ws transport drops it — the reason a reload used
  // to show nothing). Cleared on the next send.
  //
  // `replayed` separates the two, because they are not the same claim. The
  // server RETAINS its last terminal record until a later turn supersedes it
  // (agents SDK `_replayTerminalOnAck`), so a workspace whose last turn failed
  // and has not been used since re-serves that failure to every client that
  // connects, forever. Measured on `sunlit-stone-4a20`: a turn that ended
  // 2026-08-17T19:08:41Z still answers a resume ACK today with
  // `{"body":"Unauthorized","done":true,"error":true}`, and the card called it
  // "the last turn" as though it had just happened. It IS the last turn — it is
  // just not recent, and a card that cannot say so is a card that misdates the
  // workspace's state.
  //
  // The discriminator is the server's own: it announces the pending record's
  // request id in a `cf_agent_stream_resuming` frame and only then replays the
  // terminal for that same id. An id this connection saw announced is a replay;
  // anything else is this session's turn failing live.
  const resumedRequestIds = useRef(new Set<string>());
  const [chatError, setChatError] = useState<ChatTurnError | null>(null);
  const [subordinates, setSubordinates] = useState<SubordinateRosterEntry[]>([]);
  const [subordinateEvents, setSubordinateEvents] = useState<SubordinateActivityEvent[]>([]);
  /** Background-event cards, from the delivery seam's own lifecycle stream. */
  const [signalCards, setSignalCards] = useState<readonly SignalCard[]>([]);
  const [activePlan, setActivePlan] = useState<PlanReview | null>(null);
  // Has the server said what this conversation is? Set by the connect frame,
  // and the ONLY thing that entitles the pane to draw an empty conversation: a
  // workspace with four hundred messages spent the whole wake-plus-transfer
  // window claiming it had none, and then replaced that claim with the
  // transcript. False is "not yet", never "nothing".
  const [transcriptSeeded, setTranscriptSeeded] = useState(false);

  const agentOptions: Parameters<typeof useAgent>[0] = {
    agent: ORCHESTRATOR_AGENT_SLUG,
    name: actorAddress.workspace,
    // onOpen always wins — even if a prior onError pinned the status to
    // "error", a successful reopen must recover the UI. Without this, a
    // single transient error event traps the user on the disconnect
    // banner forever (STABILITY-AUDIT §A1).
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => {
      // No close-code list here. The SDK classifies a terminal close itself
      // (`isTerminalCloseEvent`: 1008 or 4000-4999) and publishes the outcome
      // as `connectionError`, so a second reading of the same codes in this
      // file would be a duplicate authority that could disagree with it.
      setConnectionStatus("disconnected");
      // The live paint belongs to this socket. Across the gap a head keeps
      // working and nothing here hears it, so a half-written step left on
      // screen would claim to be current for as long as the reconnect takes.
      // The durable steps arrive again either way.
      forgetDeltas();
    }, [forgetDeltas]),
    // Don't clobber a healthy status; partysocket auto-reconnects in the
    // background and the next onOpen recovers. onError is a transient no-op.
    onError: useCallback(() => {}, []),
    // Live AI auto-title: update both actor state and the shared roster store.
    onMessage: useCallback((ev: MessageEvent) => {
      const data = parseSocketMessage(ev.data);
      if (data?.type === "workspace_renamed") {
        const displayName = data.displayName;
        if (displayName?.trim()) {
          setAgentStatus((prev) => prev ? { ...prev, displayName } : prev);
        }
        window.dispatchEvent(new CustomEvent("kinu:workspace-renamed", {
          detail: { name: actorAddress.workspace, displayName },
        }));
      } else if (data?.type === "cf_agent_stream_resuming") {
        resumedRequestIds.current.add(data.id);
      } else if (data?.type === "cf_agent_use_chat_response" && data.error === true && data.done === true) {
        // Terminal-error frame. During a live stream the transport also
        // surfaces it as useChat's `error`; on connect the server REPLAYS
        // the last terminal error with a stale request id the transport
        // drops — this handler is the only place that frame is seen.
        setChatError({
          body: data.body?.trim() ? data.body : "The turn failed with an unknown error.",
          replayed: data.id !== undefined && resumedRequestIds.current.has(data.id),
        });
      }
    }, [actorAddress.workspace]),
  };
  if (subordinate) {
    agentOptions.sub = [{ agent: SUBORDINATE_AGENT_SLUG, name: subordinate }];
  }
  const agent = useAgent(agentOptions);

  const {
    messages,
    sendMessage,
    regenerate,
    clearHistory,
    stop,
    isStreaming: streamingTokens,
    status: chatStatus,
    error: streamError,
    connectionError,
  } = useAgentChat({
    agent,
    // Throttle UI updates during high-frequency token deltas (50ms ≈ 20fps).
    // The chat library forwards this option to @ai-sdk's useChat.
    experimental_throttle: 50,
  });

  /**
   * A turn this pane started or observed is live — what every surface reading
   * `isStreaming` means by "busy".
   *
   * The SDK's own flag is `status === 'streaming' || isServerStreaming`, so it
   * is FALSE for the whole `submitted` window: the message is on the socket and
   * the turn has begun, but no token has arrived yet. Over that window the old
   * value said idle — the composer offered Send, the working chip was absent,
   * and a second press was admitted. `status` is the SDK's own reactive state
   * for exactly that phase, so this is one derivation over state that already
   * exists rather than a second flag to keep in step with the latch below.
   */
  const isStreaming = streamingTokens || chatStatus === "submitted";

  /**
   * SEND ADMISSION. The latch lives in `send-admission.ts` — a ref mutated in
   * the same statement that reads it, so a second press inside one tick sees it
   * held. `isStreaming` above only MIRRORS it for rendering; it never decides.
   */
  const sendLatch = useRef(newSendLatch());
  const startTurn = useCallback(
    (begin: () => Promise<void>): boolean => admitTurn(sendLatch.current, begin),
    [],
  );

  // The live-stream error channel: the ws transport turns an in-band
  // `error:true` frame into useChat's `error` state — fold it into the same
  // exposed chat-error surface as the on-connect replay. This one is always
  // live: the transport only reaches it for a request id still in flight.
  useEffect(() => {
    if (streamError) setChatError({ body: streamError.message || String(streamError), replayed: false });
  }, [streamError]);

  // ── Version-skew signal: /api/health's build sha, read once per PAGE as the
  // baseline and compared on each reconnect. A supersede the socket rode
  // through leaves the running SPA stale against the deployment now serving
  // it — say so once, with a reload affordance, instead of waiting for the
  // next dynamic import to fail on a chunk that no longer exists.
  //
  // The baseline is `pageDeployedBuildSha`, not a ref this hook fills at mount:
  // WorkspacePage is keyed on the workspace, so this hook is remounted on every
  // workspace navigation and a per-hook baseline re-read itself onto whatever
  // was live at that moment — losing the skew it exists to report. One read per
  // document also means the render-failure report and this notice can never
  // disagree about which build the page is running.
  const [newerDeployedBuild, setNewerDeployedBuild] = useState(false);
  const refreshDeployedBuild = useCallback(async () => {
    const [baseline, live] = await Promise.all([pageDeployedBuildSha(), fetchDeployedBuildSha()]);
    if (isNewerDeployedBuild(baseline, live)) setNewerDeployedBuild(true);
  }, []);

  // ── A2: resume the durable stream on EVERY reconnect, not just first mount.
  // The framework's resume effect fires once; partysocket reconnects don't
  // retrigger it. We listen for the agent's "open" event and request the
  // server's buffered chunks from
  // cf_ai_chat_stream_chunks. (STABILITY-AUDIT §A2.)
  const isFirstOpen = useRef(true);
  useEffect(() => {
    if (!agent) return;
    const onOpen = () => {
      // Skip the very first open — useChat's mount-time resume handles it.
      if (isFirstOpen.current) { isFirstOpen.current = false; return; }
      if (agent.readyState !== WebSocket.OPEN) return;
      agent.send(JSON.stringify({ type: "cf_agent_stream_resume_request" }));
    };
    agent.addEventListener("open", onOpen);
    return () => agent.removeEventListener("open", onOpen);
  }, [agent]);



  const isConnected = connectionStatus === "connected";

  // The live overlay is keyed by root just like the canvas's polled tree map.
  // Its payload folds the search rows and in-progress journal together, so a
  // push cannot hide a running node that the poll already knows about.
  //
  // A socket can replay a frame after reconnect. `pushSeq` is per root, so an
  // old A cannot reject a fresh B and an old A cannot replace A's newer tree.
  const mctsProgressState = useRef(createMctsProgressState<ForkNode>(actorKey));
  const setMctsTreeFromProgress = useCallback((progress: MctsProgress) => {
    const next = applyMctsProgress(
      mctsProgressState.current,
      actorKey,
      progress,
      explorationForkTree({ tree: progress.nodes, head: progress.head }),
    );
    if (next === mctsProgressState.current) return;
    mctsProgressState.current = next;
    setMctsTrees(next.trees);
  }, [actorKey]);

  // Fetch all tab data. Keyed on a generation counter because a ref cannot
  // retrigger an effect: on failure the error is sticky and a backoff retry
  // bumps the counter; every WS 'open' beyond the session's first bumps it
  // too (session-recovery), so a reconnect re-fetches even when React never
  // observed an intermediate disconnected state; `retryLoad` is the same
  // path, driven by the user. The load no longer waits for `isConnected`:
  // while the socket is down the call queues client-side and flushes on the
  // next dial, so recovery starts the moment transport returns.
  const [loadGeneration, setLoadGeneration] = useState(0);
  const failureStreak = useRef(0);
  // Loads can overlap during reconnect and a workspace switch. Retain each
  // lifecycle task through settlement; admission still decides what may publish.
  const snapshotLoadTaskId = useRef(0);
  const snapshotLoadTasks = useRef(new Map<number, Promise<void>>());

  // The corpse detector + forced-redial policy. Created once; `agentRef`
  // indirection keeps its callbacks stable across renders.
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const sessionRecoveryRef = useRef<SessionRecovery | null>(null);
  if (sessionRecoveryRef.current === null) {
    sessionRecoveryRef.current = createSessionRecovery({
      refetch: () => setLoadGeneration((g) => g + 1),
      forceRedial: () => agentRef.current?.reconnect(),
    });
  }
  const sessionRecovery = sessionRecoveryRef.current;
  // ── Session recovery: every reconnect re-fetches what the dead transport
  // silently missed, and a corpse socket — OPEN by readyState, timed-out by
  // every RPC — is forced to redial once the evidence is unambiguous. The
  // policy lives in hooks/session-recovery.ts; this is the wiring.
  const recoveryFirstOpen = useRef(true);
  useEffect(() => {
    if (!agent) return;
    const onOpen = async () => {
      const isFirst = recoveryFirstOpen.current;
      recoveryFirstOpen.current = false;
      sessionRecovery.socketOpened(isFirst);
      if (!isFirst) {
        try {
          await refreshDeployedBuild();
        } catch (error) {
          diagnostics.failure('session.build_check_failed', toKinuError({
            doing: 'check the deployed build after reconnect', cause: error, otherwise: 'io',
          }));
        }
      }
    };
    agent.addEventListener("open", onOpen);
    return () => agent.removeEventListener("open", onOpen);
  }, [agent, refreshDeployedBuild, sessionRecovery]);

  // Typed RPC — the single boundary cast (unknown → T) lives here so call sites
  // read rpc<T>("getFoo", []) cast-free. Memoized on `agent` so it's a stable
  // identity (surface effects keyed on [rpc] don't refetch each render). Every
  // outcome feeds the corpse detector: a timeout while the socket claims OPEN
  // is evidence, any other outcome is proof of life.
  const rpc = useMemo(() => {
    const call = bindRpc(agent);
    return async <T,>(method: string, args: unknown[] = []): Promise<T> => {
      try {
        const value = await call<T>(method, args);
        sessionRecovery.rpcSucceeded();
        return value;
      } catch (cause) {
        sessionRecovery.rpcFailed(cause, agent.readyState === WebSocket.OPEN);
        throw cause;
      }
    };
  }, [agent, sessionRecovery]);

  // Root sockets keep the existing application heartbeat. Subordinate sockets
  // need an acknowledged frame: without the root surface's live-data polls, an
  // OPEN corpse otherwise produces no RPC evidence for the recovery controller.
  useEffect(() => {
    if (connectionStatus !== "connected") return;
    const id = setInterval(async () => {
      if (agent.readyState !== WebSocket.OPEN) return;
      if (!isSubordinate) {
        agent.send(JSON.stringify({ type: "ping" }));
        return;
      }
      try {
        await rpc("getSubordinateSnapshot", []);
        setSourceError("snapshot", null);
      } catch (error) {
        setSourceError("snapshot", errorMessage(error));
      }
    }, 25_000);
    return () => clearInterval(id);
  }, [agent, connectionStatus, isSubordinate, rpc, setSourceError]);

  // A subordinate's snapshot seeds none of the polled surfaces, so it speaks
  // only for itself. The cancellation this effect used to also track is the
  // admission's job: re-running it admits a newer load, which retires this one.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const taskId = ++snapshotLoadTaskId.current;
    let task: Promise<void> | null = null;
    task = (async () => {
      try {
        const outcome = await loadWorkspaceSnapshot(
          isSubordinate ? loadSubordinateData : loadAllData,
          setSourceError,
          (requestKey) => liveRefreshAdmission.admit(actorKey, requestKey),
          isSubordinate ? [] : SNAPSHOT_SEEDED_SOURCES,
        );
        if (disposed || outcome === "superseded") return;
        if (outcome === "loaded") {
          failureStreak.current = 0;
          return;
        }
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** failureStreak.current);
        failureStreak.current += 1;
        timer = setTimeout(() => setLoadGeneration((g) => g + 1), delay);
      } catch (cause) {
        diagnostics.failure('workspace.initial_snapshot_task_failed', toKinuError({
          doing: 'refreshing live workspace data',
          cause,
          otherwise: 'io',
        }));
      } finally {
        snapshotLoadTasks.current.delete(taskId);
      }
    })();
    snapshotLoadTasks.current.set(taskId, task);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [actorKey, isSubordinate, liveRefreshAdmission, loadGeneration, rpc, setSourceError, subordinate, workspace]);

  const refreshBackgroundJobs = useCallback(() => refreshCurrentLiveResource(
    "jobs",
    () => rpc<BackgroundJob[]>("listBackgroundJobs", [50]),
    setBackgroundJobs,
  ), [refreshCurrentLiveResource, rpc]);

  // The queue and the changelog's unseen count come from one call: the queue
  // already folds the unseen digest into a row, and the sidebar dot reads the
  // same answer rather than a second poll that could disagree with it.
  const refreshPendingActions = useCallback(() => refreshCurrentLiveResource(
    "pendingActions",
    () => rpc<PendingAction[]>("listPendingActions", []),
    (actions) => {
      setPendingActions(actions);
      const unseen = actions.find((a) => a.kind === "unseen_changes");
      setChangelogUnseen(unseen ? 1 : 0);
    },
  ), [refreshCurrentLiveResource, rpc]);

  // The gated tabs' presence rides the same live cycle as every other
  // workspace read — no loop of its own. A release created or a search run
  // started mid-session therefore surfaces within one refresh tick (and at
  // once when the turn that created it ends).
  const refreshTabPresence = useCallback(() => refreshCurrentLiveResource(
    "presence",
    () => rpc<TabPresence>("getWorkspaceTabPresence", []),
    setTabPresence,
  ), [refreshCurrentLiveResource, rpc]);

  // Stable identity: it is an effect dependency in the changelog hook, which
  // re-reads on a timer now — an inline arrow re-armed that effect on every
  // render and fired a markChangelogSeen RPC with it.
  const clearChangelogUnseen = useCallback(() => {
    setChangelogUnseen(0);
    setPendingActions((prev) => prev.filter((a) => a.kind !== "unseen_changes"));
  }, []);

  /**
   * Stop this turn. Resolves with the mid-turn steers the abort DROPPED, so the
   * surface that clicked Stop can put them back in its composer — the server
   * hands them over rather than eating them, and only the tab that asked for
   * the stop should end up with the text in its draft (every other tab learns
   * they were returned from the `steer_status` broadcast).
   */
  const abortChat = useCallback(async (): Promise<string[]> => {
    try {
      const [, outcome] = await Promise.all([
        stop(),
        rpc<{ returnedSteers?: string[] }>("cancelCurrentWork", []),
      ]);
      return outcome.returnedSteers ?? [];
    } finally {
      if (!isSubordinate) {
        try {
          await refreshBackgroundJobs();
        } catch (cause) {
          diagnostics.failure('workspace.abort_refresh_failed', toKinuError({
            doing: 'refreshing live workspace data',
            cause,
            otherwise: 'io',
          }));
        }
      }
    }
  }, [stop, rpc, refreshBackgroundJobs, isSubordinate]);

  /**
   * Send a message WITHOUT stopping the running turn.
   *
   * The actor decides in its own turn queue: `"mid-turn"` means it was spliced
   * into the running turn's next step, `"queued"` means that turn had already
   * ended and the actor enqueued it as the next ordinary turn. Either way the
   * text has landed somewhere, which is why nothing here re-sends it. The shape
   * this replaced answered `"idle"` and left the client to call `sendChat`
   * afterwards — a decision and an enqueue that were not atomic, so guidance
   * meant for one turn could become an ordinary turn after another had started.
   */
  const steerChat = useCallback(async (
    text: string, mode: "plan" | "build" = "build",
  ): Promise<"mid-turn" | "queued"> => {
    // `mode` rides the enqueued turn as its `kinuMode`, the same way `sendChat`
    // binds it: a Plan-locked composer whose steer missed its turn must queue a
    // PLAN turn, not silently become a build one.
    const { landed } = await rpc<{ landed: "mid-turn" | "queued" }>("steerTurn", [text, mode]);
    return landed;
  }, [rpc]);

  // Listen for MCTS progress broadcasts from the server. We attach to the
  // outer `agent` EventTarget — NOT the inner `_ws` private field — so the
  // listener survives partysocket auto-reconnects without a close→open gap
  // dropping events. (STABILITY-AUDIT §A3.)
  useEffect(() => {
    if (!agent) return;
    const handler = async (event: MessageEvent) => {
      const msg = parseSocketMessage(event.data);
      if (!msg) return;
        if (msg.type === "cf_agent_chat_messages") {
          setTranscriptSeeded(true);
        } else if (msg.type === "mcts-progress") {
          setMctsTreeFromProgress(msg);
        } else if (msg.type === "device_consent") {
          setPendingConsents((prev) => {
            if (prev.some((c) => c.consentId === msg.consentId)) return prev;
            const card: PendingConsent = {
              consentId: msg.consentId,
              deviceLabel: msg.deviceLabel,
              method: msg.method ?? "exec",
              command: msg.command,
              scope: msg.scope,
              createdAt: Date.now(),
            };
            if (msg.workspaceName) card.workspaceName = msg.workspaceName;
            return [...prev, card];
          });
        } else if (msg.type === "device_consent_resolved") {
          setPendingConsents((prev) => prev.filter((c) => c.consentId !== msg.consentId));
          setConsentResolutionError(msg.consentId, null);
        } else if (msg.type === "work_cancelled") {
          // Every head stopped mid-step. Whatever they had written is either
          // journalled or gone, and neither case is still being written.
          forgetDeltas();
          try {
            await refreshBackgroundJobs();
          } catch (cause) {
            diagnostics.failure('workspace.cancelled_work_refresh_failed', toKinuError({
              doing: 'refreshing live workspace data',
              cause,
              otherwise: 'io',
            }));
          }
        } else if (msg.type === "pending_actions_changed") {
          // A command was parked on the owner, or they decided one. The queue
          // is polled, so the server pushes the fact rather than the rows —
          // one re-read keeps the tab badge and the queue the same answer,
          // and updates every open tab, not just the one that clicked.
          try {
            await refreshPendingActions();
          } catch (cause) {
            diagnostics.failure('workspace.pending_actions_refresh_failed', toKinuError({
              doing: 'refreshing live workspace data',
              cause,
              otherwise: 'io',
            }));
          }
        } else if (msg.type === "branch_status") {
          const status = msg.status === "settled" ? "settled" : msg.status === "error" ? "error" : "running";
          // A branch that has stopped is writing nothing. Its head id is
          // derived from the run id, so the accumulator can be retired without
          // waiting for a journal write that a failed branch never makes.
          if (status !== "running") retireDelta(branchHeadId(msg.branchId));
          setBranchRuns((prev) => [
            ...prev.filter((b) => b.branchId !== msg.branchId),
            {
              branchId: msg.branchId,
              task: msg.task ?? "",
              status,
              takeSetId: msg.takeSetId,
              turnId: msg.turnId,
              message: msg.message,
            },
          ]);
        } else if (msg.type === "head_activity") {
          // A branch recorded a step or filed its report. Same push-the-fact
          // shape as `pending_actions_changed`: an open transcript re-reads the
          // journal it already renders from, so the stream and the store cannot
          // drift, and a reader with nothing open pays nothing.
          //
          // This also RETIRES the in-progress paint for that head: the step it
          // was painting has landed, so the durable read replaces it and the
          // two can never both be on screen.
          retireDelta(msg.headId);
          bumpHeadActivity(msg.headId);
        } else if (msg.type === "head_stream") {
          setHeadDeltaMap((previous) => appendHeadDelta(previous, msg.headId, msg.kind, msg.delta));
        } else if (msg.type === "steer_status") {
          // `returned` is a removal: the abort dropped it and the composer has
          // it back, so leaving a bubble in the thread would claim the agent
          // was given something it never saw.
          setSteerRuns((prev) => msg.status === "returned"
            ? prev.filter((s) => s.id !== msg.steerId)
            : [
              ...prev.filter((s) => s.id !== msg.steerId),
              {
                id: msg.steerId, text: msg.text, state: msg.status,
                atStep: msg.atStep ?? null,
              },
            ]);
        } else if (msg.type === "signal_card") {
          const card = parseSignalCardEvent(msg);
          if (card) setSignalCards((current) => applySignalCard(current, card));
        } else if (msg.type === "plan_updated") {
          const plan = parsePlanReview(msg.plan);
          if (plan) setActivePlan(plan);
        } else if (!isSubordinate && msg.type === "subordinates_changed") {
          const roster = parseSubordinateRoster(msg.subordinates);
          if (roster) {
            ++subordinateRefreshGeneration.current;
            setSubordinates(roster);
          }
        } else if (!isSubordinate && msg.type === "subordinate_event") {
          const subordinateEvent = parseSubordinateActivityEvent(msg);
          if (subordinateEvent) {
            setSubordinateEvents((current) => current.some((event) => event.id === subordinateEvent.id)
              ? current
              : [...current.slice(-49), subordinateEvent]);
          }
        }
    };
    agent.addEventListener("message", handler);
    return () => {
      agent.removeEventListener("message", handler);
      // The paint belongs to a socket. A new one cannot know what a running
      // head had half-written, and the durable steps arrive again anyway.
      forgetDeltas();
    };
  }, [
    agent, bumpHeadActivity, forgetDeltas, refreshBackgroundJobs, refreshPendingActions,
    retireDelta, setConsentResolutionError, setMctsTreeFromProgress, isSubordinate,
  ]);

  const resolveConsent = useCallback((consentId: string, decision: ConsentDecision) => resolvePendingConsent(
    consentId,
    decision,
    (id, choice) => rpc("resolveDeviceConsent", [id, choice]),
    (id) => setPendingConsents((previous) => previous.filter((consent) => consent.consentId !== id)),
    setConsentResolutionError,
    liveRefreshAdmission.admit(actorKey, `consentResolution:${consentId}`),
  ), [actorKey, liveRefreshAdmission, rpc, setConsentResolutionError]);

  const refreshExposedPorts = useCallback(async () => {
    const generation = ++exposedPortsRefreshGeneration.current;
    const results = await Promise.all(["workspace", "sandbox"].map(async (executor) => {
      try {
        const result = await rpc<{
          ports: Array<{ port: number; url: string; name?: string }>;
          error?: string;
        }>("getExposedPorts", [executor]);
        return { executor, result } satisfies ExecutorPortRefresh;
      } catch (error) {
        return {
          executor,
          result: { ports: [], error: errorMessage(error) },
        } satisfies ExecutorPortRefresh;
      }
    }));
    if (generation !== exposedPortsRefreshGeneration.current) return;
    setPinnedPorts((previous) => {
      const next = reconcilePreviewPorts(previous, results);
      setPreviewError(next.error);
      return next.ports;
    });
  }, [rpc]);
  // Timer ticks and user/reconnect refreshes may overlap. Each cycle retains
  // its own task through settlement instead of borrowing a global catch sink.
  const liveRefreshTaskId = useRef(0);
  const liveRefreshTasks = useRef(new Map<number, Promise<void>>());
  const refreshLiveData = useCallback((): void => {
    const taskId = ++liveRefreshTaskId.current;
    let task: Promise<void> | null = null;
    task = (async () => {
      try {
        await Promise.all([
          refreshExposedPorts(),
          refreshCurrentLiveResource("memoryContent", () => rpc<string>("getMemoryContent", []), setMemoryContent),
          refreshCurrentLiveResource(
            "tools",
            () => rpc<ToolDescResult>("getToolDescriptions", []),
            (result) => setTools(mapToolDescriptions(result)),
          ),
          refreshCurrentLiveResource("executors", () => rpc<ExecutorInfo[]>("getExecutors", []), setExecutors),
          refreshBackgroundJobs(),
          refreshCurrentLiveResource("views", () => rpc<AgentViewSummary[]>("listAgentViews", []), setAgentViews),
          refreshPendingActions(),
          refreshTabPresence(),
          refreshCurrentLiveResource(
            "consents",
            () => rpc<PendingConsent[]>("listPendingConsents", []),
            setPendingConsents,
          ),
          refreshCurrentLiveResource(
            "plan",
            () => rpc<unknown>("getActivePlanReview", []),
            (plan) => setActivePlan(parseActivePlanReview(plan)),
          ),
        ]);
      } catch (cause) {
        diagnostics.failure('workspace.live_refresh_failed', toKinuError({
          doing: 'refreshing live workspace data',
          cause,
          otherwise: 'io',
        }));
      } finally {
        liveRefreshTasks.current.delete(taskId);
      }
    })();
    liveRefreshTasks.current.set(taskId, task);
  }, [
    refreshBackgroundJobs,
    refreshCurrentLiveResource,
    refreshExposedPorts,
    refreshPendingActions,
    refreshTabPresence,
    rpc,
  ]);

  const retryLoad = useCallback(() => {
    failureStreak.current = 0;
    setSourceError("model", null);
    // The SDK stops auto-redialling exactly when it sets `connectionError`,
    // so that is the condition under which Retry must force one.
    sessionRecovery.manualRetry(agentRef.current?.connectionError != null);
    if (!isSubordinate) refreshLiveData();
  }, [isSubordinate, refreshLiveData, sessionRecovery, setSourceError]);

  // Refresh surface data when a turn completes (streaming ends).
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (isSubordinate) return;
    if (isStreaming) {
      wasStreaming.current = true;
    } else if (wasStreaming.current) {
      wasStreaming.current = false;
      refreshLiveData();
    }
  }, [isStreaming, isSubordinate, refreshLiveData]);

  // Full surface refresh on a steady 5s cadence. The chat stream already
  // carries the conversation, so streaming only adds a faster (1s) poll of
  // the run timeline for near-real-time spans — not every surface RPC.
  useEffect(() => {
    if (!isConnected || isSubordinate) return;
    const interval = setInterval(refreshLiveData, LIVE_DATA_REFRESH_MS);
    return () => clearInterval(interval);
  }, [isConnected, isSubordinate, refreshLiveData]);

  // Initial load — ONE round-trip, and it stays one: the active plan used to be
  // a second awaited RPC here, so a plan-gated workspace painted its composer in
  // build mode and moved a beat later.
  //
  // The exploration canvas is deliberately NOT seeded from here any more. It was
  // the largest thing on this path (499-824 KiB per workspace, measured against
  // production 2026-08-20) and its only effect was to pre-fill a tree map that
  // the Exploration surface rebuilds from its own `getExplorationCanvas` when it
  // mounts, and that `useForkRunTree` fetches per run when it does not. Live
  // trees still arrive on the `mcts_update` broadcast.
  async function loadAllData(
    isCurrent: () => boolean,
    isSourceCurrent: (source: LiveRefreshSource) => boolean,
  ): Promise<void> {
    const snap = await rpc<WorkspaceSnapshot>("getWorkspaceSnapshot", []);
    if (!isCurrent()) return;
    setAgentStatus(snap.status);
    if (isSourceCurrent("tools")) setTools(mapToolDescriptions(snap.tools));
    if (isSourceCurrent("memoryContent")) {
      setMemoryContent(snap.memoryContent);
      if (snap.memoryContent) setMemory(parseMemoryContent(snap.memoryContent));
    }
    if (isSourceCurrent("executors")) {
      setExecutors(snap.executors);
      setLastActiveExecutor(snap.lastActiveExecutor);
      const outputs = new Map<string, ExecutorOutput[]>();
      for (const eo of snap.executorOutputs) outputs.set(eo.name, eo.outputs.slice().reverse());
      setExecutorOutputs(outputs);
    }
    if (isSourceCurrent("plan")) setActivePlan(parsePlanReview(snap.activePlan));
    if (isSourceCurrent("presence")) setTabPresence(snap.tabPresence);
    // REPLACE, never merge. The durable rows are the authority for what is
    // queued and what is running, so a tab that reconnects after a deploy or a
    // corpse redial both LEARNS transitions it missed and DROPS chips for work
    // that settled while it was away. A live broadcast that races this upserts
    // by id afterwards, so the newer fact still wins.
    setSteerRuns(snap.pendingSteers);
    setBranchRuns(snap.branchRuns.map((run) => ({
      branchId: run.branchId, task: run.task, status: run.status,
    })));
    try {
      await Promise.all([refreshExposedPorts(), refreshPendingActions()]);
    } catch (cause) {
      diagnostics.failure('workspace.snapshot_followup_refresh_failed', toKinuError({
        doing: 'refreshing live workspace data',
        cause,
        otherwise: 'io',
      }));
    }
  }

  async function loadSubordinateData(isCurrent: () => boolean): Promise<void> {
    const snapshot = await rpc<{
      name: string;
      displayName: string;
      role: RoleSelection;
      mission: string;
      model: string | null;
      activePlan: unknown;
      /** The facet's own acknowledged-and-not-landed steers, from its durable
       *  rows. Read here for the same reason the root reads them off its
       *  snapshot: no live broadcast repeats a queue for a tab that was gone
       *  when the steer was taken. */
      pendingSteers: InlineSteer[];
    }>("getSubordinateSnapshot", []);
    if (!isCurrent()) return;
    setAgentStatus({
      name: snapshot.name,
      displayName: snapshot.displayName,
      purpose: snapshot.role.kind === 'catalog' ? snapshot.role.roleId : snapshot.role.text,
      soul: snapshot.mission,
      createdAt: 0,
      scaffoldVersion: 0,
      searchNodeCount: 0,
      craftedToolCount: 0,
      messageCount: messages.length,
      model: snapshot.model ?? "",
      forkLineage: null,
    });
    setActivePlan(parseActivePlanReview(snapshot.activePlan));
    setSteerRuns(snapshot.pendingSteers);
  }
  // Roster loads may overlap across reconnects; their generation decides which
  // result is current, while this map keeps every started task owned to settle.
  const subordinateRefreshTasks = useRef(new Map<number, Promise<void>>());

  const refreshSubordinates = useCallback((): void => {
    if (isSubordinate) return;
    const generation = ++subordinateRefreshGeneration.current;
    let task: Promise<void> | null = null;
    task = (async () => {
      try {
        const value = await rpc<unknown>("listSubordinates", []);
        if (generation !== subordinateRefreshGeneration.current) return;
        const roster = parseSubordinateRoster(value);
        if (!roster) throw new Error('Subordinate roster returned an invalid response');
        setSubordinates(roster);
        setSourceError("roster", null);
      } catch (err) {
        if (generation !== subordinateRefreshGeneration.current) return;
        setSourceError("roster", errorMessage(err));
      } finally {
        subordinateRefreshTasks.current.delete(generation);
      }
    })();
    subordinateRefreshTasks.current.set(generation, task);
  }, [isSubordinate, rpc, setSourceError]);

  useEffect(() => {
    if (isSubordinate) return;
    refreshSubordinates();
  }, [isSubordinate, refreshSubordinates, loadGeneration]);

  useEffect(() => {
    ++exposedPortsRefreshGeneration.current;
    ++subordinateRefreshGeneration.current;
    setLoadGeneration(0);
    failureStreak.current = 0;
    wasStreaming.current = false;
    isFirstOpen.current = true;
    // This conversation is a different one now, so the send latch belongs to
    // nobody. The abandoned turn's own settle can no longer release it — the
    // owner token it holds is stale — which is exactly the ordering that keeps
    // a late completion from opening the door for whoever holds it next.
    abandonTurn(sendLatch.current);
    searchSeq.current += 1;
    clearTimeout(searchTimer.current);
    setErrors({});
    setConsentResolutionErrors(new Map());
    setAgentStatus(null);
    setTools([]);
    setMemory([]);
    setMemoryContent("");
    mctsProgressState.current =
      activateMctsProgressActor<ForkNode>(mctsProgressState.current, actorKey);
    setMctsTrees(mctsProgressState.current.trees);
    setExecutorOutputs(new Map());
    setLastActiveExecutor(null);
    setPinnedPorts([]);
    setPreviewError(null);
    setBackgroundJobs([]);
    setAgentViews([]);
    setPendingConsents([]);
    setActivePlan(null);
    setPendingActions([]);
    setChangelogUnseen(0);
    setBranchRuns([]);
    setChatError(null);
    setSubordinates([]);
    setSubordinateEvents([]);
    setSignalCards([]);
  }, [workspace, subordinate]);

  /**
   * Start a turn with this text and these attachments.
   *
   * Answers whether the send was ADMITTED. `false` means a turn already holds
   * this conversation's send latch and nothing was sent, so the caller must
   * keep the composer's contents; callers must not pre-check streaming state,
   * because a reactive pre-check is the race this closes.
   *
   * File attachments ride as data-URL FileUIParts ahead of the text part — the
   * whole downstream pipeline (WS transport, DO persistence, Think's
   * convertToModelMessages) natively carries them to multimodal models.
   */
  const sendChat = useCallback((
    content: string,
    files: FileUIPart[] = [],
    mode: "plan" | "build" = "build",
  ): boolean => {
    const parts: UIMessage["parts"] = [
      ...files,
      ...(content ? [{ type: "text" as const, text: content }] : []),
    ];
    if (parts.length === 0) return false;
    return startTurn(() => {
      setChatError(null);
      return sendMessage({ role: "user", parts, metadata: { kinuMode: mode } });
    });
  }, [startTurn, sendMessage]);

  /**
   * Re-run the turn that failed — the SDK's own `regenerate`, not a fresh send.
   *
   * `sendMessage` APPENDED a copy of the last user message on every press, so
   * three attempts at one failed turn left three identical user turns in the
   * durable transcript and three chances for the model to answer the same
   * question twice. `regenerate` drops the assistant message being retried
   * (or keeps the trailing user message when the turn produced none), sends
   * `trigger: 'regenerate-message'`, and the host reconciles against its own
   * history rather than growing it.
   *
   * Under the SAME latch as `sendChat`: a retry starts a turn, so two presses
   * of the error card's Retry are one turn for the same reason two presses of
   * Send are. One admission authority, not two.
   */
  const retryLastMessage = useCallback((): boolean => {
    if (messages.length === 0) return false;
    return startTurn(() => {
      setChatError(null);
      return regenerate();
    });
  }, [startTurn, messages.length, regenerate]);

  // Every keystroke used to fire its own searchMemoryHybrid with nothing
  // ordering the replies, so a slow early query could land last and leave the
  // pane showing results for a prefix the user had already typed past.
  const searchSeq = useRef(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(searchTimer.current), []);

  const searchMemory = useCallback((q: string) => {
    clearTimeout(searchTimer.current);
    const seq = ++searchSeq.current;
    if (!q.trim()) {
      // Empty search — re-parse full content
      setSourceError("memory", null);
      if (memoryContent) setMemory(parseMemoryContent(memoryContent));
      return;
    }
    searchTimer.current = setTimeout(async () => {
      try {
        const results = await rpc<Array<{ path: string; startLine?: number; endLine?: number; snippet: string; rrfScore: number }>>("searchMemoryHybrid", [q]);
        if (seq !== searchSeq.current) return;
        setSourceError("memory", null);
        setMemory((results ?? []).map(r => ({
          path: r.path,
          content: r.snippet,
          matchScore: r.rrfScore,
          updatedAt: r.startLine ? `lines ${r.startLine}-${r.endLine}` : "",
        })));
      } catch (err) {
        if (seq !== searchSeq.current) return;
        setSourceError("memory", `Memory search failed: ${errorMessage(err)}`);
      }
    }, MEMORY_SEARCH_DEBOUNCE_MS);
  }, [rpc, memoryContent, setSourceError]);

  /** Switch this agent's model. Resolves `null` once the write landed, or the
   *  failure reason when it didn't — the reason is recorded on `error` and the
   *  picker is rolled back before returning, so a caller that reports "Saved"
   *  (Workspace settings) must check the result instead of assuming success.
   *  Reporting here and rejecting as well would force every fire-and-forget
   *  picker to silence a rejection it has nothing to add to. */
  const setModel = useCallback(async (modelId: string): Promise<string | null> => {
    // Optimistically reflect in the UI so the dropdown doesn't snap back
    // while the RPC is in flight.
    setAgentStatus(prev => prev ? { ...prev, model: modelId } : prev);
    try {
      const r = await rpc<{ ok?: boolean; spec?: string }>("setModel", [modelId]);
      // Server may have normalized the spec — sync the UI to authoritative value.
      if (r?.spec) setAgentStatus(prev => prev ? { ...prev, model: r.spec! } : prev);
      setSourceError("model", null);
      return null;
    } catch (err) {
      // Roll the picker back to the actually-stored spec so it can't keep
      // showing a model that was never saved.
      let reason = `Couldn't switch model: ${errorMessage(err)}`;
      try {
        const stored = await rpc<{ spec?: string | null }>("getStoredModelSpec", []);
        setAgentStatus(prev => prev ? { ...prev, model: stored.spec ?? '' } : prev);
      } catch (rollbackErr) {
        // The rollback read failed too, so the picker is still showing a model
        // that was never stored. Say so rather than leaving it looking saved.
        reason += ` — and the stored model couldn't be re-read (${errorMessage(rollbackErr)}), so the model shown may not be what's saved`;
      }
      setSourceError("model", reason);
      return reason;
    }
  }, [rpc, setSourceError]);

  const setDisplayName = useCallback(async (displayName: string): Promise<string> => {
    const result = await rpc<{ displayName: string }>("setDisplayName", [displayName]);
    const saved = result.displayName;
    setAgentStatus((prev) => prev ? { ...prev, displayName: saved } : prev);
    return saved;
  }, [rpc]);

  // Single source of truth: the server-side broadcast. executeInExecutor ONLY
  // fires the RPC; the broadcast handler below renders the row. This prevents
  // the double-output bug where the optimistic append AND the broadcast both
  // fired for one invocation (race-ordering made dedup windows unreliable).
  const executeInExecutor = useCallback((executorId: string, command: string) => {
    return rpc<ExecutorCommandResult>("executeInExecutor", [executorId, command]);
  }, [rpc]);

  // Listen for executor-output broadcasts — emitted by the orchestrator on
  // every exec completion (user- or agent-triggered). Attach to the outer
  // `agent` EventTarget so the listener survives reconnects (STABILITY-AUDIT
  // §A3, D5).
  useEffect(() => {
    if (!agent) return;
    const handler = (event: MessageEvent) => {
      const msg = parseSocketMessage(event.data);
      if (msg?.type === "executor-output") {
          setExecutorOutputs(prev => {
            const next = new Map(prev);
            const existing = next.get(msg.executor) ?? [];
            // The live echo is the whole output of a command that just ran, so
            // the stored length IS what is shown — nothing was withheld here.
            // A reload reads the same row back through the clipped SQL and the
            // pane says so then.
            const stdout = msg.stdout ?? "";
            const stderr = msg.stderr ?? "";
            next.set(msg.executor, [...existing, {
              id: crypto.randomUUID(), command: msg.command,
              stdout, stdout_len: stdout.length,
              stderr, stderr_len: stderr.length,
              exit_code: msg.exitCode ?? 0, created_at: msg.timestamp,
            }]);
            return next;
          });
      }
    };
    agent.addEventListener("message", handler);
    return () => agent.removeEventListener("message", handler);
  }, [agent]);

  return {
    messages,
    isStreaming,
    /** True once the server has stated this conversation's contents. Until then
     *  `messages` being empty means "not delivered", not "there is nothing". */
    transcriptSeeded,
    connectionStatus,
    /** Set when the socket closed for a reason reconnecting cannot change —
     *  the workspace is not this caller's, or it is not there. Carries the
     *  close code and the server's own reason. The SDK owns the
     *  classification and clears this on open, so there is nothing to
     *  mirror. */
    terminalClose: connectionError,
    /** The deployment's build sha changed since this page loaded — the tab is
     *  stale against the server now answering it. Latched once per page load;
     *  the surface renders the reload affordance from this. */
    newerDeployedBuild,
    /** The one sticky failure line — never auto-expires. Says the workspace
     *  could not OPEN while nothing has loaded, and names the stale surfaces
     *  once a snapshot has. */
    error,
    /** Re-run the initial load now (also cancels the pending backoff retry and
     *  clears a stale action error). The `error` banner's way out. */
    retryLoad,
    /** The last chat turn's terminal error (live stream error or the
     *  on-connect replay) — rendered as an error card in the thread. */
    chatError,
    clearChatError: () => setChatError(null),
    retryLastMessage,
    agentStatus,
    /** The snapshot as this repo's tri-state, for the surfaces it seeds: a pane
     *  may only report "none" for a read that came back, and `agentStatus`
     *  alone cannot tell a load still coming from one that failed. Carries no
     *  reason — `error` says why, once. */
    snapshot,
    tools,
    memory,
    memoryContent,
    mctsTrees,
    activePlan,
    sendChat,
    abortChat,
    searchMemory,
    clearHistory,
    setModel,
    setDisplayName,
    executors,
    executorOutputs,
    lastActiveExecutor,
    executeInExecutor,
    /** Exposed ports across the canonical Workspace and Sandbox executors. */
    pinnedPorts,
    previewError,
    refreshExposedPorts,
    /** Background jobs — the Work surface's Now half and its journal. */
    backgroundJobs,
    refreshBackgroundJobs,
    /** Everything waiting on the owner: the Work queue and its strip badge. */
    pendingActions,
    /** Whether the gated tabs (Releases, Exploration) have content. */
    tabPresence,
    /** Agent-authored dashboards, as tabs. */
    agentViews,
    /** Pending device-consent requests + the resolver (chat consent cards). */
    pendingConsents,
    resolveConsent,
    /** Whether unseen self-changes remain — the sidebar roster's dot. Work
     *  marks them seen server-side, then calls the clear. */
    changelogUnseen,
    clearChangelogUnseen,
    /** Steer-as-Branch chips (running → settled/error) + the dismiss. */
    branchRuns,
    dismissBranchRun: (branchId: string) =>
      setBranchRuns((prev) => prev.filter((b) => b.branchId !== branchId)),
    /** Per-branch write counter — what makes an open node transcript live. A
     *  reader whose branch id ticked re-reads the journal; every other reader
     *  sees an unchanged number and does nothing. */
    headActivity,
    /** The step each running head is writing — prose and reasoning — with the
     *  retire a reader calls when its own re-read found that step. Best-effort
     *  paint under `headActivity`: retired the moment the step lands, so a
     *  reader never shows the same text twice. */
    headDeltas,
    /** Mid-turn steers the server has taken, queued → landed. Dropped ones are
     *  removed by the server's `returned` broadcast, not by the surface. */
    steerRuns,
    steerChat,
    /**
     * Fork this agent at a message. Returns the new agent's navigation URL
     * on success, or throws on error ('agent busy', 'fork point not found',
     * 'agent name already exists', etc.).
     */
    forkAgent: (untilMessageId: string, opts?: { name?: string }) =>
      rpc<{ id: string; name: string; url: string; forkPointMs: number }>("forkAgent", [untilMessageId, opts ?? {}]),
    rpc,
    rawAgent: agent,
    actorAddress,
    isSubordinate,
    subordinates,
    subordinateEvents,
    signalCards,
    refreshSubordinates,
    /** One-click additional agent: identity only, no role/mission form. The
     *  server answers with a blank displayName — the UI shows "New agent"
     *  until the first-message titler lands over `subordinates_changed`. */
    createSubordinate: async () => {
      const result = await rpc<{
        name: string;
        displayName: string;
        subordinate: SubordinateRosterEntry;
      }>("createSubordinateAgent", []);
      ++subordinateRefreshGeneration.current;
      setSubordinates((current) => [
        ...current.filter((entry) => entry.name !== result.subordinate.name),
        result.subordinate,
      ]);
      setSourceError("roster", null);
      return result;
    },
    /** Owner rename. Lands on the parent roster AND the child's own identity;
     *  a user-chosen name permanently blocks auto-retitling (server-side). */
    renameSubordinate: async (name: string, displayName: string) => {
      const result = v.parse(
        SubordinateMutationEnvelopeSchema,
        await rpc<unknown>("renameSubordinateAgent", [name, displayName]),
      );
      const entry = result.subordinate;
      ++subordinateRefreshGeneration.current;
      setSubordinates((current) => current.map(
        (existing) => existing.name === entry.name ? entry : existing,
      ));
      setSourceError("roster", null);
      return entry;
    },
    dismissSubordinate: async (name: string) => {
      const result = await rpc<{ ok: true; name: string; historyKept: boolean }>("dismissSubordinate", [name]);
      ++subordinateRefreshGeneration.current;
      setSubordinates((current) => current.filter((entry) => entry.name !== result.name));
      setSourceError("roster", null);
      return result;
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────

/** The chain, then the two shapes an RPC can reject with that are not `Error` at
 *  all: a bare string from a JSON error body, and an object with no message.
 *  `renderThrownChain` owns the first case for every reader in the repo; the two
 *  fallbacks are this surface's own, because a browser panel showing
 *  `[object Object]` has told the reader nothing. */
function errorMessage<ErrorValue>(err: ErrorValue): string {
  if (err instanceof Error && err.message) return renderThrownChain({ cause: err });
  const text = v.safeParse(v.string(), err);
  if (text.success && text.output.trim()) return text.output;
  try { return JSON.stringify(err) || "unknown error"; }
  catch (error) { return `unrenderable error: ${renderThrownChain({ cause: error })}`; }
}

function formatNaturalList(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "unknown data";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function combineErrorMessages(primary: string | null, live: string | null): string | null {
  if (!primary) return live;
  if (!live) return primary;
  return `${primary} ${live}`;
}

function parseActivePlanReview<Value>(value: Value): PlanReview | null {
  const parsed = v.safeParse(v.nullable(PlanReviewSchema), value);
  if (!parsed.success) throw new Error("Active plan returned an invalid response");
  return parsed.output;
}

function parseSubordinateRoster<Value>(value: Value): SubordinateRosterEntry[] | null {
  const parsed = v.safeParse(v.array(SubordinateRosterEntrySchema), value);
  return parsed.success ? parsed.output : null;
}

function parseSubordinateActivityEvent<Value>(value: Value): SubordinateActivityEvent | null {
  const parsed = v.safeParse(SubordinateActivityEventSchema, value);
  return parsed.success ? parsed.output : null;
}

interface ToolDescResult {
  builtIn: Array<{
    name: string; summary: string; description: string;
    exposure: ToolInfo["exposure"]; wired: boolean;
  }>;
  crafted: Array<{
    name: string; description: string; exposure: ToolInfo["exposure"]; wired: boolean;
    qualityScore?: number; usageCount?: number;
  }>;
}

/** Map a getToolDescriptions result into the UI's ToolInfo[] — single source
 *  for the mapping used by both the initial load and live refresh.
 *
 *  `exposure` and `wired` both come from the orchestrator: the first is the
 *  registry's declared reach, the second is whether THIS agent wires the
 *  capability. Neither is recomputed here — the panel used to be handed a
 *  single guessed word and could not tell absence from codemode-only reach. */
function mapToolDescriptions(r: ToolDescResult): ToolInfo[] {
  return [
    ...r.builtIn.map((t) => ({ ...t, learned: false, qualityScore: 1, usageCount: 0 })),
    // A crafted tool's description IS its one line — it has no second register.
    ...r.crafted.map((t) => ({ ...t, summary: t.description, learned: true, qualityScore: t.qualityScore ?? 0.5, usageCount: t.usageCount ?? 0 })),
  ];
}

/** Parse MEMORY.md sections into MemoryEntry[] for the UI */
function parseMemoryContent(content: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  const sections = content.split(/\n(?=###|##)/);
  for (const section of sections) {
    const lines = section.trim().split("\n");
    const header = lines[0] ?? "";
    const body = lines.slice(1).join("\n").trim();
    if (!body || !header) continue;
    entries.push({
      path: "memory/MEMORY.md",
      content: body,
      matchScore: 1,
      updatedAt: header.replace(/^#+\s*/, ""),
    });
  }
  return entries;
}
