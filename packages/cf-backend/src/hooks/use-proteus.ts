/**
 * Proteus agent hooks — useAgent() + useAgentChat() from Agents SDK.
 */

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useAgent } from "agents/react";
import {
  ORCHESTRATOR_AGENT_SLUG, SUBORDINATE_AGENT_SLUG,
  type AgentViewSummary, type PendingAction, type PlanReview,
} from "@proteus/core";
import type { ExplorationCanvasView, TimelineSpan } from "@proteus/core";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { FileUIPart, UIMessage } from "ai";
import * as v from "valibot";
import { buildTree, groupByRoot, type MctsRow } from "../lib/fork-tree-rows";
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
} from "../lib/protocol";
import type { ExecutorInfo } from "../lib/executors";
import { applySignalCard, parseSignalCardEvent, type SignalCard } from "../components/background-event";
import { tolerate } from "@proteus/core/obs";
import {
  reconcilePreviewPorts,
  type ExecutorPortRefresh,
  type PinnedPreviewPort,
} from "../lib/preview-ports";

export type { ExecutorInfo };

export interface ExecutorOutput {
  id: string; command: string; stdout: string; stderr: string;
  exit_code: number; created_at: number;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export interface ProteusActorAddress {
  workspace: string;
  subordinate?: string;
}

const ProteusActorAddressSchema = v.object({
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

/** One-round-trip initial-load payload (server: getWorkspaceSnapshot). */
export interface WorkspaceSnapshot {
  status: AgentStatus;
  tools: ToolDescResult;
  memoryContent: string;
  /** Every recent fork, its dispatch parameters, and the search rows for the
   *  trees that keep theirs in search_nodes — the Exploration canvas's own
   *  projection, so first paint draws every tree rather than only the newest. */
  exploration: ExplorationCanvasView;
  /** Still returned by the server for `proteus inspect`; no UI reads it. */
  timeline: TimelineSpan[];
  executors: ExecutorInfo[];
  executorOutputs: Array<{ name: string; outputs: ExecutorOutput[] }>;
  lastActiveExecutor: string | null;
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
  task: v.optional(v.string()),
  observation: v.optional(v.string()),
  code_used: v.optional(v.nullable(v.string())),
  branch_agent_key: v.optional(v.nullable(v.string())),
  msg_id: v.optional(v.nullable(v.string())),
  created_at: v.optional(v.number()),
});

const SubordinateRosterEntrySchema = v.object({
  name: v.string(),
  displayName: v.string(),
  role: v.string(),
  createdBy: v.picklist(["orchestrator", "user"]),
  status: v.picklist(["idle", "working", "awaiting_input", "dismissed"]),
  currentTask: v.nullable(v.string()),
  createdAt: v.number(),
  dismissedAt: v.nullable(v.number()),
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
  v.object({
    type: v.literal("cf_agent_use_chat_response"),
    error: v.optional(v.boolean()), done: v.optional(v.boolean()), body: v.optional(v.string()),
  }),
  v.object({
    type: v.literal("mcts-progress"), rootId: v.string(), nodes: v.array(MctsRowSchema),
  }),
  v.object({
    type: v.literal("device_consent"), consentId: v.string(), deviceLabel: v.string(),
    method: v.optional(v.string()), command: v.string(),
  }),
  v.object({ type: v.literal("device_consent_resolved"), consentId: v.string() }),
  v.object({ type: v.literal("work_cancelled") }),
  v.object({ type: v.literal("pending_actions_changed") }),
  v.object({
    type: v.literal("branch_status"), branchId: v.string(), task: v.optional(v.string()),
    status: v.optional(v.string()), takeSetId: v.optional(v.string()),
    turnId: v.optional(v.string()), message: v.optional(v.string()),
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
 *  message so a recovery in one never hides a still-broken other. */
export type LiveRefreshSource =
  | "jobs"
  | "pendingActions"
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
  { source: "jobs", label: "background jobs" },
  { source: "pendingActions", label: "pending actions" },
  { source: "mcts", label: "MCTS" },
  { source: "memoryContent", label: "memory content" },
  { source: "tools", label: "tools" },
  { source: "executors", label: "executors" },
  { source: "views", label: "agent views" },
  { source: "consents", label: "device consents" },
  { source: "consentResolution", label: "device consents" },
  { source: "plan", label: "active plan" },
];

type ErrorSource = "snapshot" | "roster" | "model" | "memory" | LiveRefreshSource;

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

export function formatLiveRefreshError(errors: LiveRefreshErrors): string | null {
  const labels: string[] = [];
  const reasons: string[] = [];
  for (const descriptor of LIVE_REFRESH_DESCRIPTORS) {
    const reason = errors[descriptor.source];
    if (!reason) continue;
    if (!labels.includes(descriptor.label)) labels.push(descriptor.label);
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  if (labels.length === 0) return null;
  return `Couldn't refresh live data for ${formatNaturalList(labels)}. Showing last known data. ${formatNaturalList(reasons)}`;
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
export function useProteus(target?: string | ProteusActorAddress) {
  const targetString = v.safeParse(v.string(), target);
  const targetAddress = v.safeParse(ProteusActorAddressSchema, target);
  const workspace = targetString.success
    ? targetString.output
    : targetAddress.success ? targetAddress.output.workspace : undefined;
  const subordinate = targetAddress.success ? targetAddress.output.subordinate : undefined;
  const actorAddress = useMemo<ProteusActorAddress>(() => {
    const address: ProteusActorAddress = { workspace: workspace || "default" };
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
  const primaryError = errors.snapshot ?? errors.roster ?? errors.model ?? errors.memory ?? null;
  const consentResolutionReasons = [...new Set(consentResolutionErrors.values())];
  const liveErrors = consentResolutionReasons.length === 0
    ? errors
    : { ...errors, consentResolution: formatNaturalList(consentResolutionReasons) };
  const liveError = formatLiveRefreshError(liveErrors);
  const error = combineErrorMessages(primaryError, liveError);
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
  // Dashboards Proteus published for this workspace — the agent-authored tabs
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
  // Unseen self-changes, kept only for the sidebar roster's dot — the tab badge
  // is the queue's length now.
  const [changelogUnseen, setChangelogUnseen] = useState(0);
  // Steer-as-Branch runs — the split progress chips near the streaming answer.
  const [branchRuns, setBranchRuns] = useState<BranchRun[]>([]);
  // Chat-turn error — the turn failed (provider error, stream break) and the
  // error card in the thread shows the honest body. Fed by BOTH channels a
  // terminal error can arrive on: useChat's live stream error, and the
  // on-connect `cf_agent_use_chat_response` replay frame (whose request id is
  // no longer active, so the ws transport drops it — the reason a reload used
  // to show nothing). Cleared on the next send.
  const [chatError, setChatError] = useState<string | null>(null);
  const [subordinates, setSubordinates] = useState<SubordinateRosterEntry[]>([]);
  const [subordinateEvents, setSubordinateEvents] = useState<SubordinateActivityEvent[]>([]);
  /** Background-event cards, from the delivery seam's own lifecycle stream. */
  const [signalCards, setSignalCards] = useState<readonly SignalCard[]>([]);
  const [activePlan, setActivePlan] = useState<PlanReview | null>(null);

  const agentOptions: Parameters<typeof useAgent>[0] = {
    agent: ORCHESTRATOR_AGENT_SLUG,
    name: actorAddress.workspace,
    // onOpen always wins — even if a prior onError pinned the status to
    // "error", a successful reopen must recover the UI. Without this, a
    // single transient error event traps the user on the disconnect
    // banner forever (STABILITY-AUDIT §A1).
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    // Don't clobber a healthy status; partysocket auto-reconnects in the
    // background and the next onOpen recovers. onError is a transient no-op.
    onError: useCallback(() => {}, []),
    // Live AI auto-title: the agent broadcasts `workspace_renamed` after the first
    // turn — nudge the Sidebar roster to refetch so the new name shows at once.
    onMessage: useCallback((ev: MessageEvent) => {
      const data = parseSocketMessage(ev.data);
      if (data?.type === "workspace_renamed") {
        const displayName = data.displayName;
        if (displayName?.trim()) {
          setAgentStatus((prev) => prev ? { ...prev, displayName } : prev);
        }
        window.dispatchEvent(new CustomEvent("proteus:workspace-renamed"));
      } else if (data?.type === "cf_agent_use_chat_response" && data.error === true && data.done === true) {
        // Terminal-error frame. During a live stream the transport also
        // surfaces it as useChat's `error`; on connect the server REPLAYS
        // the last terminal error with a stale request id the transport
        // drops — this handler is the only place that frame is seen.
        setChatError(data.body?.trim() ? data.body : "The turn failed with an unknown error.");
      }
    }, []),
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
    isStreaming,
    error: streamError,
  } = useAgentChat({
    agent,
    // Throttle UI updates during high-frequency token deltas (50ms ≈ 20fps).
    // The chat library forwards this option to @ai-sdk's useChat.
    experimental_throttle: 50,
  });

  // The live-stream error channel: the ws transport turns an in-band
  // `error:true` frame into useChat's `error` state — fold it into the same
  // exposed chat-error surface as the on-connect replay.
  useEffect(() => {
    if (streamError) setChatError(streamError.message || String(streamError));
  }, [streamError]);

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

  // ── A4: 25s heartbeat keeps the WS warm against Cloudflare's edge reaping an
  // idle connection. Server no-ops unknown message types.
  //
  // The threshold is `edge.websocket_idle_reap_ms`, and that entry is labelled
  // SPECULATIVE: this comment used to cite `STABILITY-AUDIT §A4`, which is not
  // in the working tree — only its screenshots survived — and the recovered text
  // says "Cloudflare's documented 100s reap" while citing nothing. Cloudflare
  // publishes no such figure. See also `websocket.protocol_ping_auto_answered`:
  // the runtime answers RFC 6455 ping FRAMES for free without waking the object,
  // and this application-level message does not get that treatment.
  useEffect(() => {
    if (connectionStatus !== "connected") return;
    const id = setInterval(() => {
      if (agent.readyState !== WebSocket.OPEN) return;
      agent.send(JSON.stringify({ type: "ping" }));
    }, 25_000);
    return () => clearInterval(id);
  }, [agent, connectionStatus]);

  const isConnected = connectionStatus === "connected";

  // Rebuild a search's tree only when ITS rows actually changed — the polls
  // return identical data most ticks, and a fresh tree object identity makes
  // the d3 visualization re-render (and drop tooltips) for nothing.
  //
  // Keyed by search root, because a workspace runs several searches at once and
  // one slot made them fight over it: every surface guards the live tree on the
  // selected run's id, so whichever search pushed last was the only live one and
  // every other running search silently fell back to its 1.5s poll. The
  // multi-tree canvas needs all of them at once regardless.
  const mctsFingerprints = useRef(new Map<string, string>());
  const setMctsTreeFromRows = useCallback((rootId: string, rows: MctsRow[]) => {
    if (rows.length === 0) return;
    const fp = rows.map((r) => `${r.id}:${r.visits}:${r.value}:${r.status}`).join("|");
    if (fp === mctsFingerprints.current.get(rootId)) return;
    mctsFingerprints.current.set(rootId, fp);
    const tree = buildTree(rows);
    setMctsTrees((prev) => new Map(prev).set(rootId, tree));
  }, []);

  // Typed RPC — the single boundary cast (unknown → T) lives here so call sites
  // read rpc<T>("getFoo", []) cast-free. Memoized on `agent` so it's a stable
  // identity (surface effects keyed on [rpc] don't refetch each render).
  const rpc = useMemo(() => bindRpc(agent), [agent]);

  // Fetch all tab data on connect.
  //
  // Keyed on an attempt counter, because a ref cannot retrigger an effect: the
  // old code reset `fetched.current` in the catch and nothing ever looked at
  // it again, so one failed snapshot bricked the whole workspace view until a
  // reload. On failure the error is sticky and a backoff retry is scheduled;
  // `retryLoad` is the same path, driven by the user.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const failureStreak = useRef(0);
  useEffect(() => {
    if (!isConnected) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const label = isSubordinate ? "Subordinate" : "Workspace";
    const isCurrent = liveRefreshAdmission.admit(actorKey, "snapshot");
    (isSubordinate ? loadSubordinateData(isCurrent) : loadAllData(isCurrent))
      .then(() => {
        if (cancelled || !isCurrent()) return;
        failureStreak.current = 0;
        setSourceError("snapshot", null);
      })
      .catch((err) => {
        if (cancelled || !isCurrent()) return;
        setSourceError("snapshot", `${label} snapshot failed: ${errorMessage(err)}`);
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** failureStreak.current);
        failureStreak.current += 1;
        timer = setTimeout(() => setLoadAttempt((a) => a + 1), delay);
      });
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [actorKey, isConnected, isSubordinate, liveRefreshAdmission, loadAttempt, rpc, subordinate, workspace]);

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

  // Stable identity: it is an effect dependency in the changelog hook, which
  // re-reads on a timer now — an inline arrow re-armed that effect on every
  // render and fired a markChangelogSeen RPC with it.
  const clearChangelogUnseen = useCallback(() => {
    setChangelogUnseen(0);
    setPendingActions((prev) => prev.filter((a) => a.kind !== "unseen_changes"));
  }, []);

  const abortChat = useCallback(() => {
    stop();
    rpc("cancelCurrentWork", [])
      .then(() => { if (!isSubordinate) void refreshBackgroundJobs(); })
      .catch(() => { if (!isSubordinate) void refreshBackgroundJobs(); });
  }, [stop, rpc, refreshBackgroundJobs, isSubordinate]);

  // Listen for MCTS progress broadcasts from the server. We attach to the
  // outer `agent` EventTarget — NOT the inner `_ws` private field — so the
  // listener survives partysocket auto-reconnects without a close→open gap
  // dropping events. (STABILITY-AUDIT §A3.)
  useEffect(() => {
    if (!agent) return;
    const handler = (event: MessageEvent) => {
      const msg = parseSocketMessage(event.data);
      if (!msg) return;
        if (msg.type === "mcts-progress") {
          setMctsTreeFromRows(msg.rootId, msg.nodes);
        } else if (msg.type === "device_consent") {
          setPendingConsents((prev) => prev.some((c) => c.consentId === msg.consentId) ? prev
            : [...prev, {
              consentId: msg.consentId,
              deviceLabel: msg.deviceLabel,
              method: msg.method ?? "exec",
              command: msg.command,
              // The hub grants exactly one scope today (device-consent.ts).
              scope: "all_local_actions",
              createdAt: Date.now(),
            }]);
        } else if (msg.type === "device_consent_resolved") {
          setPendingConsents((prev) => prev.filter((c) => c.consentId !== msg.consentId));
          setConsentResolutionError(msg.consentId, null);
        } else if (msg.type === "work_cancelled") {
          void refreshBackgroundJobs();
        } else if (msg.type === "pending_actions_changed") {
          // A command was parked on the owner, or they decided one. The queue
          // is polled, so the server pushes the fact rather than the rows —
          // one re-read keeps the tab badge and the queue the same answer,
          // and updates every open tab, not just the one that clicked.
          void refreshPendingActions();
        } else if (msg.type === "branch_status") {
          setBranchRuns((prev) => [
            ...prev.filter((b) => b.branchId !== msg.branchId),
            {
              branchId: msg.branchId,
              task: msg.task ?? "",
              status: msg.status === "settled" ? "settled" : msg.status === "error" ? "error" : "running",
              takeSetId: msg.takeSetId,
              turnId: msg.turnId,
              message: msg.message,
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
    return () => agent.removeEventListener("message", handler);
  }, [agent, refreshBackgroundJobs, refreshPendingActions, setConsentResolutionError, setMctsTreeFromRows, isSubordinate]);

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

  const refreshLiveData = useCallback((): Promise<void> => {
    void refreshExposedPorts();
    return Promise.all([
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
    ]).then(() => {});
  }, [
    refreshBackgroundJobs,
    refreshCurrentLiveResource,
    refreshExposedPorts,
    refreshPendingActions,
    rpc,
  ]);

  const retryLoad = useCallback(() => {
    failureStreak.current = 0;
    setSourceError("model", null);
    setLoadAttempt((attempt) => attempt + 1);
    if (!isSubordinate) void refreshLiveData();
  }, [isSubordinate, refreshLiveData, setSourceError]);

  // Refresh surface data when a turn completes (streaming ends).
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (isSubordinate) return;
    if (isStreaming) {
      wasStreaming.current = true;
    } else if (wasStreaming.current) {
      wasStreaming.current = false;
      void refreshLiveData();
    }
  }, [isStreaming, isSubordinate, refreshLiveData]);

  // Full surface refresh on a steady 5s cadence. The chat stream already
  // carries the conversation, so streaming only adds a faster (1s) poll of
  // the run timeline for near-real-time spans — not every surface RPC.
  useEffect(() => {
    if (!isConnected || isSubordinate) return;
    const interval = setInterval(() => { void refreshLiveData(); }, LIVE_DATA_REFRESH_MS);
    return () => clearInterval(interval);
  }, [isConnected, isSubordinate, refreshLiveData]);

  // Initial load — ONE round-trip (getWorkspaceSnapshot) instead of 6 + N. The
  // server guards each field independently, so a single failing read degrades
  // that surface only. Live updates continue via refreshLiveData + events.
  async function loadAllData(isCurrent: () => boolean): Promise<void> {
    const snap = await rpc<WorkspaceSnapshot>("getWorkspaceSnapshot", []);
    if (!isCurrent()) return;
    setAgentStatus(snap.status);
    setTools(mapToolDescriptions(snap.tools));
    setMemoryContent(snap.memoryContent);
    if (snap.memoryContent) setMemory(parseMemoryContent(snap.memoryContent));
    // Every tree, not just the newest: a workspace can have several searches in
    // flight, and the canvas draws all of them from first paint.
    for (const [rootId, rows] of groupByRoot(snap.exploration.search)) {
      setMctsTreeFromRows(rootId, rows);
    }
    setExecutors(snap.executors);
    setLastActiveExecutor(snap.lastActiveExecutor);
    const outputs = new Map<string, ExecutorOutput[]>();
    for (const eo of snap.executorOutputs) outputs.set(eo.name, eo.outputs.slice().reverse());
    setExecutorOutputs(outputs);
    void refreshExposedPorts();
    void refreshPendingActions();
    const plan = await rpc<unknown>("getActivePlanReview", []);
    if (isCurrent()) setActivePlan(parsePlanReview(plan));
  }

  async function loadSubordinateData(isCurrent: () => boolean): Promise<void> {
    const snapshot = await rpc<{
      name: string;
      displayName: string;
      role: string;
      mission: string;
      model: string | null;
    }>("getSubordinateSnapshot", []);
    if (!isCurrent()) return;
    setAgentStatus({
      name: snapshot.name,
      displayName: snapshot.displayName,
      purpose: snapshot.role,
      soul: snapshot.mission,
      createdAt: 0,
      scaffoldVersion: 0,
      searchNodeCount: 0,
      craftedToolCount: 0,
      messageCount: messages.length,
      model: snapshot.model ?? "",
      forkLineage: null,
    });
  }

  const refreshSubordinates = useCallback(() => {
    if (isSubordinate) return Promise.resolve();
    const generation = ++subordinateRefreshGeneration.current;
    return rpc<unknown>("listSubordinates", [])
      .then((value) => {
        if (generation !== subordinateRefreshGeneration.current) return;
        const roster = parseSubordinateRoster(value);
        if (!roster) throw new Error('Subordinate roster returned an invalid response');
        setSubordinates(roster);
        setSourceError("roster", null);
      })
      .catch((err) => {
        if (generation !== subordinateRefreshGeneration.current) return;
        setSourceError("roster", `Subordinate roster failed: ${errorMessage(err)}`);
      });
  }, [isSubordinate, rpc, setSourceError]);

  useEffect(() => {
    if (!isConnected || isSubordinate) return;
    void refreshSubordinates();
  }, [isConnected, isSubordinate, refreshSubordinates, loadAttempt]);

  useEffect(() => {
    ++exposedPortsRefreshGeneration.current;
    ++subordinateRefreshGeneration.current;
    setLoadAttempt(0);
    failureStreak.current = 0;
    wasStreaming.current = false;
    isFirstOpen.current = true;
    searchSeq.current += 1;
    clearTimeout(searchTimer.current);
    setErrors({});
    setConsentResolutionErrors(new Map());
    setAgentStatus(null);
    setTools([]);
    setMemory([]);
    setMemoryContent("");
    setMctsTrees(new Map());
    mctsFingerprints.current.clear();
    setExecutors([]);
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

  // File attachments ride as data-URL FileUIParts ahead of the text part —
  // the whole downstream pipeline (WS transport, DO persistence, Think's
  // convertToModelMessages) natively carries them to multimodal models.
  const sendChat = useCallback((
    content: string,
    files: FileUIPart[] = [],
    mode: "plan" | "build" = "build",
  ) => {
    const parts: UIMessage["parts"] = [
      ...files,
      ...(content ? [{ type: "text" as const, text: content }] : []),
    ];
    if (parts.length === 0) return;
    setChatError(null);
    sendMessage({ role: "user", parts, metadata: { proteusMode: mode } });
  }, [sendMessage]);

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
   */
  const retryLastMessage = useCallback(() => {
    if (messages.length === 0) return;
    setChatError(null);
    void regenerate();
  }, [messages.length, regenerate]);

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
    searchTimer.current = setTimeout(() => {
      rpc<Array<{ path: string; startLine?: number; endLine?: number; snippet: string; rrfScore: number }>>("searchMemoryHybrid", [q])
        .then(
          (results) => {
            if (seq !== searchSeq.current) return;
            setSourceError("memory", null);
            setMemory((results ?? []).map(r => ({
              path: r.path,
              content: r.snippet,
              matchScore: r.rrfScore,
              updatedAt: r.startLine ? `lines ${r.startLine}-${r.endLine}` : "",
            })));
          },
          (err) => {
            if (seq !== searchSeq.current) return;
            setSourceError("memory", `Memory search failed: ${errorMessage(err)}`);
          },
        );
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
            next.set(msg.executor, [...existing, {
              id: crypto.randomUUID(), command: msg.command,
              stdout: msg.stdout ?? "", stderr: msg.stderr ?? "",
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
    connectionStatus,
    /** The sticky load/action failure, if any — never auto-expires. */
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
    spawnSubordinate: async (role: string, mission: string) => {
      const result = await rpc<{
        name: string;
        displayName: string;
        subordinate: SubordinateRosterEntry;
      }>("spawnSubordinate", [role, mission]);
      ++subordinateRefreshGeneration.current;
      setSubordinates((current) => [
        ...current.filter((entry) => entry.name !== result.subordinate.name),
        result.subordinate,
      ]);
      setSourceError("roster", null);
      return result;
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

function errorMessage<ErrorValue>(err: ErrorValue): string {
  if (err instanceof Error && err.message) return err.message;
  const text = v.safeParse(v.string(), err);
  if (text.success && text.output.trim()) return text.output;
  try { return JSON.stringify(err) || "unknown error"; } catch { return "unknown error"; }
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
