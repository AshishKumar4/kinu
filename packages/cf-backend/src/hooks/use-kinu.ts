import { useState, useCallback, useEffect, useRef, useMemo, type RefObject, type SetStateAction } from "react";
import { useAgent } from "agents/react";
import { Effect } from "effect";
import {
  activateMctsProgressActor, applyMctsProgress, createMctsProgressState,
  branchHeadId, CHANGES_MOVED_EVENT, followJobOutput, JOB_OUTPUT_EVENT, LIVE_READS, ORCHESTRATOR_AGENT_SLUG, PAGE_KEEPALIVE,
  READS_CHANGED_EVENT, SLATES_CHANGED_EVENT, type JobOutputTail,
  hostedActorSocketPath, type LiveRead, type PendingAction, type PlanReview, type ReasoningEffort, type RoleId, type SlateProblem, type SlateSummary, type TierSource,
} from "@kinu.run/core";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { FileUIPart, UIMessage } from "ai";
import * as v from "valibot";
import { explorationForkTree } from "@kinu.run/core";
import type {
  MemoryEntry,
  ForkNode,
  ExecutorCommandResult,
  PendingConsent,
  Rpc,
  SubordinateActivityEvent,
  TabPresence,
  SendLanding,
} from "@kinu.run/core";
import type { BackgroundJob, SubordinateRosterEntry } from "@kinu.run/core/protocol";
import type { ExecutorInfo, PanelAgent } from "@kinu.run/core";
import { applySignalCard, parseSignalCardEvent, type SignalCard } from "@kinu.run/core";
import {
  appendHeadDelta, retireHeadDelta, type HeadDelta, type HeadDeltas,
} from "@kinu.run/core";
import { looksLikeSecretField, parseMemoryNotes, type InlineSteer } from "@kinu.run/core";
import { detach, diagnostics, KinuError, renderThrownChain, toKinuError } from "@kinu.run/core/obs";
import {
  reconcilePreviewPorts,
  type ExecutorPortRefresh,
  type ExposedPortList,
  type PinnedPreviewPort,
} from "@kinu.run/core";
import {
  createSessionRecovery,
  fetchDeployedBuildSha,
  isNewerDeployedBuild,
  pageDeployedBuildSha,
  reportChatStreamFailure,
  routeTemplateOf,
  type SessionRecovery,
} from "@kinu.run/core";
import { abandonTurn, abandonTurnIfOwner, admitTurn, newSendLatch } from "@kinu.run/core";
import { terminalChatError, type ChatTurnError } from "@kinu.run/core";
import { turnLiveness, TURN_CLAIM_FRAME, type TurnClaimState } from "@kinu.run/core";
import type { AsyncResource } from "./use-async-resource";
import { SubordinateActivityEventSchema, useSocketFrames, type MctsProgress, type SocketFrame } from "./socket-frames";
import { pruneSlateReloads } from "@kinu.run/core";

export { WorkspacePlanUpdatedFrameSchema, type MctsProgress } from "./socket-frames";

export type { ExecutorInfo };

/** `stdout`/`stderr` are clipped by the server; `*_len` are the stored lengths, so the pane
 *  can say what it withheld. */
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

export interface BranchRun {
  branchId: string;
  task: string;
  status: "running" | "settled" | "error";
  takeSetId?: string;
  turnId?: string;
  message?: string;
}

/** `settled` is the server's steer_status for the message and can arrive long after the call;
 *  it rejects when the message did not land. Null: nothing was sent. */
export type SendAdmission =
  | { readonly landed: "turn" }
  | { readonly landed: "mid-turn"; readonly settled: Promise<SendLanding> }
  | null;

type SendLandingResolvers = ReturnType<typeof Promise.withResolvers<SendLanding>>;

export type ReadMoves = Readonly<Partial<Record<LiveRead, number>>>;

/** A call the actor refused takes the waiter with it; the refusal is the answer. */
async function landingAfter(
  admission: Promise<void>,
  landings: Map<string, SendLandingResolvers>,
  id: string,
  landing: Promise<SendLanding>,
): Promise<SendLanding> {
  try {
    await admission;
  } catch (cause) {
    landings.delete(id);
    throw toKinuError({ doing: "sending to the running turn", cause, otherwise: "unavailable" });
  }

  return landing;
}

/** `queued` decides nothing. */
function settleSendLanding(
  landings: Map<string, SendLandingResolvers>,
  status: { readonly steerId: string; readonly status: "queued" | "landed" | "returned" | "turn" },
): void {
  if (status.status === "queued") return;
  const landing = landings.get(status.steerId);

  if (landing === undefined) return;
  landings.delete(status.steerId);

  if (status.status === "returned") {
    landing.reject(new KinuError("cancelled", "The turn was stopped before the agent read this message; it is back in the composer."));
  } else {
    landing.resolve(status.status === "landed" ? "mid-turn" : "turn");
  }
}

/** Driven by steer_status broadcasts. `queued` (taken) and `landed` (model reading it) stay
 *  distinct; a `returned` steer is removed and goes back to the composer. */
export type { InlineSteer as SteerRun } from "@kinu.run/core";

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
  messageCount: number;
  model: string;
  /** The tier source the turn profile resolved. Set on agent panes, where the picker is read-only. */
  modelSource?: TierSource;
  /** Own setting, else the workspace's, else the tier's; null before the server resolves one. */
  reasoningEffort: ReasoningEffort | null;
  forkLineage: ForkLineage | null;
}

/** A field the server's literal or the gallery stub omits reads `undefined` and crashes the composer. */
export interface SubordinateSnapshot {
  name: string;
  /** The pane's own identity, compared by {@link admitsActorFrame}. */
  actorId: string;
  displayName: string;
  role: RoleId;
  mission: string;
  /** The resolution the turn makes, not the actor's own (unset) pin. */
  model: { model: string; source: TierSource };
  reasoningEffort: ReasoningEffort;
  activePlan: unknown;
  messageCount: number;
  /** No live broadcast repeats the queue for a tab that was gone when the steer was taken. */
  pendingSteers: InlineSteer[];
}

export interface WorkspaceSnapshot {
  status: AgentStatus;
  memoryContent: string;
  slates: SlateSummary[];
  executors: ExecutorInfo[];
  executorOutputs: Array<{ name: string; outputs: ExecutorOutput[] }>;
  lastActiveExecutor: string | null;
  /** On the snapshot so a plan-gated workspace does not paint in build mode and then jump. */
  activePlan: unknown;
  /** On the snapshot so the strip is right from first paint. */
  tabPresence: TabPresence;
  /** Acknowledged, not yet landed. A reconnecting tab learns queued work no broadcast repeats. */
  pendingSteers: InlineSteer[];
  /** Same reason: a branch that started or settled while this tab was gone. */
  branchRuns: Array<{ branchId: string; task: string; status: "running" }>;
  /** A turn with no tokens seen yet is still live; a claim nobody executes reads as stuck. */
  turnClaim: TurnClaimState;
}

import { PlanReviewSchema, type WorkspacePlanReference } from "@kinu.run/core";

const SubordinateRosterEntrySchema = v.object({
  name: v.string(),
  actorId: v.nullable(v.string()),
  displayName: v.string(),
  role: v.string(),
  nameOrigin: v.picklist(["user", "auto"]),
  origin: v.picklist(["user", "agent", "evolution"]),
  lifetime: v.picklist(["durable", "task"]),
  status: v.picklist(["idle", "working", "awaiting_input", "dismissed"]),
  currentTask: v.nullable(v.string()),
  createdAt: v.number(),
  dismissedAt: v.nullable(v.number()),
});

const SubordinateMutationEnvelopeSchema = v.object({
  subordinate: SubordinateRosterEntrySchema,
});

function branchRunStatus(status: string | undefined): "settled" | "error" | "running" {
  if (status === "settled") return "settled";

  return status === "error" ? "error" : "running";
}


/** The browser treats the actor boundary as untrusted despite the shared type. */
function parsePlanReview({ value }: { value: unknown }): PlanReview | null {
  const parsed = v.safeParse(PlanReviewSchema, value);

  return parsed.success ? parsed.output : null;
}

/** Each source owns and clears its own message, so one recovery never hides another failure.
 *  Sources store the bare reason; the sentence is composed once, below. */
export type LiveRefreshSource =
  | "snapshot"
  | "roster"
  | "jobs"
  | "pendingActions"
  | "presence"
  | "memoryContent"
  | "executors"
  | "agents"
  | "slates"
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
  { source: "memoryContent", label: "memory content" },
  { source: "presence", label: "tab presence" },
  { source: "executors", label: "executors" },
  { source: "agents", label: "the agents panel" },
  { source: "slates", label: "slates" },
  { source: "consents", label: "device consents" },
  { source: "consentResolution", label: "device consents" },
  { source: "plan", label: "active plan" },
];

/** A landed snapshot is a fresh read of each of these, so it clears their failures. */
const SNAPSHOT_SEEDED_SOURCES: readonly LiveRefreshSource[] = [
  "memoryContent",
  "executors",
  "presence",
  "plan",
  "slates",
];

/** Action failures keep their own prose: they name what did not happen. */
type ErrorSource = LiveRefreshSource | "model" | "memory" | "recover";

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

/** A snapshot failure subsumes seeded surfaces that failed on the same reason (one outage, one line). */
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

/** `blocking`: the essential snapshot read failed. `partial`: an optional read failed; the composer
 *  stays enabled. `retry` is null for user-initiated actions the owner re-issues. */
export interface WorkspaceNotice {
  severity: "blocking" | "partial";
  title: string;
  scope: string;
  detail: string;
  retry: string | null;
}

/** `redactPayload`'s secret-name list applied to `name = value` / `name: value` pairs and `Bearer`;
 *  one policy list, so it cannot drift from core's. */
function redactErrorText(text: string): string {
  return text
    .replace(/([A-Za-z][\w-]*)(\s*[=:]\s*)("([^"\\]|\\.)*"|'[^']*'|\S+)/g,
      (whole, name: string, sep: string) =>
        looksLikeSecretField(name) ? `${name}${sep}<redacted>` : whole)
    .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>");
}

/** Until the first snapshot there is no last known data, so a failed essential read is a failed open.
 *  Each distinct reason appears once. */
export function formatWorkspaceError(errors: WorkspaceErrors, loaded: boolean): WorkspaceNotice | null {
  const action = errors.model ?? errors.memory ?? errors.recover ?? null;
  const { labels, reasons } = collectReadFailures(errors);

  if (action === null && labels.length === 0) return null;

  const detail = reasons.map(redactErrorText).join(" ");
  const blocking = errors.snapshot !== undefined;

  if (labels.length === 0) {
    return { severity: "partial", title: action ?? "", scope: "", detail: "", retry: null };
  }

  const blocked = loaded ? "Showing last known data." : "Nothing has loaded yet.";
  const available = loaded ? "The conversation is available. Showing last known data." : "The conversation is available.";
  const scope = blocking ? blocked : available;

  // Reasons are arbitrary RPC text, so they are listed one after another, not conjoined.
  const list = formatNaturalList(labels);

  const sentenceCased = `${list.slice(0, 1).toUpperCase()}${list.slice(1)}`;
  const blockedTitle = loaded ? `Could not refresh ${list}.` : "Could not open this workspace";

  const readTitle = blocking
    ? blockedTitle
    : `${sentenceCased} could not be ${loaded ? "refreshed" : "loaded"}.`;

  const title = action === null ? readTitle : `${action} ${readTitle}`;

  const retry = !blocking && labels.length === 1 ? `Retry loading ${labels[0]}` : "Retry";

  return { severity: blocking ? "blocking" : "partial", title, scope, detail, retry };
}

/** `superseded`: a newer load or a different actor took the surface; it reports nothing and
 *  nothing may be scheduled for it. */
export type SnapshotLoad = "loaded" | "superseded" | { failed: string };

/** A landed snapshot clears its seeded surfaces' failures, except any whose own refresh was
 *  admitted after this load started. The reason is returned; retry cadence is the caller's. */
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
    const failed = errorMessage({ cause: error });
    report("snapshot", failed);

    return { failed };
  }
}

export interface LiveResourceRead<Value> {
  readonly source: LiveRefreshSource;
  readonly read: () => Promise<Value>;
  readonly apply: (value: Value) => void;
  readonly report: LiveRefreshReporter;
  readonly isCurrent: () => boolean;
}

export async function refreshLiveResource<Value>(
  { source, read, apply, report, isCurrent }: LiveResourceRead<Value>,
): Promise<void> {
  if (!isCurrent()) return;

  try {
    const value = await read();

    if (!isCurrent()) return;
    apply(value);
    report(source, null);
  } catch (error) {
    if (!isCurrent()) return;
    report(source, errorMessage({ cause: error }));
  }
}

export interface UnavailableDevice { id: string; label: string; lastSeenAt: number | null }

export type ConsentDecision = "once" | "always" | "deny";

export interface PendingConsentResolution {
  readonly consentId: string;
  readonly decision: ConsentDecision;
  readonly resolve: (id: string, choice: ConsentDecision) => Promise<void>;
  readonly remove: (id: string) => void;
  readonly report: ConsentResolutionReporter;
  readonly isCurrent: () => boolean;
}

function resolvePendingConsent(
  { consentId, decision, resolve, remove, report, isCurrent }: PendingConsentResolution,
): Promise<void> {
  return refreshLiveResource({
    source: "consentResolution",
    read: () => resolve(consentId, decision),
    apply: () => remove(consentId),
    report: (_source, message) => report(consentId, message),
    isCurrent,
  });
}

/** Doubling from 1s, capped so a long outage keeps a slow heartbeat instead of hammering the DO. */
const RETRY_BASE_MS = 1_000;

const RETRY_MAX_MS = 30_000;

const MEMORY_SEARCH_DEBOUNCE_MS = 200;

interface CallableAgent {
  call<T>(method: string, args: unknown[]): Promise<T>;
}

function bindRpc(agent: CallableAgent): Rpc {
  return <T = unknown>(method: string, args: unknown[] = []) => agent.call<T>(method, args);
}

export function useWorkspaceRpc(agentId: string) {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");

  const agent = useAgent({
    agent: ORCHESTRATOR_AGENT_SLUG,
    name: agentId,
    protocol: window.location.protocol === "https:" ? "wss" : "ws",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(() => setConnectionStatus("error"), []),
  });

  const rpc = useMemo(() => bindRpc(agent), [agent]);

  return { rpc, connectionStatus };
}

/** The reference stays exposed while the connection holds it so the pane re-reads it every cycle.
 *  `claim` says yes exactly once per connection, not per pane: panes remount on conversation
 *  switches, and a replayed hint would pull the reader off the conversation they just opened. */
export interface WorkspacePlanArrival {
  readonly reference: WorkspacePlanReference;
  claim(reference: WorkspacePlanReference): boolean;
}


function runningJob(job: BackgroundJob): boolean {
  return job.status === "running" || job.status === "serving";
}

interface WorkspaceExtension {
  readonly snapshot: (snap: WorkspaceSnapshot, isSourceCurrent: (source: LiveRefreshSource) => boolean) => Promise<void>;
  readonly frame: (msg: SocketFrame) => Promise<void>;
  readonly refresh: () => void;
  readonly jobs: () => Promise<void>;
}

/** One chat's connection and conversation. */
function useChatOwner(target: string | KinuActorAddress | undefined, extension: RefObject<WorkspaceExtension | null> | null) {
  const targetString = v.safeParse(v.string(), target);
  const targetAddress = v.safeParse(KinuActorAddressSchema, target);

  const addressed = targetAddress.success ? targetAddress.output.workspace : undefined;
  const workspace = targetString.success ? targetString.output : addressed;

  const subordinate = targetAddress.success ? targetAddress.output.subordinate : undefined;

  const actorAddress = useMemo<KinuActorAddress>(() => {
    const address: KinuActorAddress = { workspace: workspace === undefined || workspace === "" ? "default" : workspace };

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
  // Keyed by source so one recovery never erases another's error; none expire on a timer.
  const [errors, setErrors] = useState<Partial<Record<ErrorSource, string>>>({});

  const setSourceError = useCallback((source: ErrorSource, message: string | null) => {
    setErrors((prev) => {
      if ((prev[source] ?? null) === message) return prev;
      const next = { ...prev };

      if (message) next[source] = message; else delete next[source];

      return next;
    });
  }, []);

  const liveRefreshAdmissionRef = useRef<LiveRefreshAdmission | null>(null);

  liveRefreshAdmissionRef.current ??= createLiveRefreshAdmission();

  const liveRefreshAdmission = liveRefreshAdmissionRef.current;

  const refreshCurrentLiveResource = useCallback(<Value,>(
    source: LiveRefreshSource,
    read: () => Promise<Value>,
    apply: (value: Value) => void,
  ) => refreshLiveResource({
    source,
    read,
    apply,
    report: setSourceError,
    isCurrent: liveRefreshAdmission.admit(actorKey, source),
  }), [actorKey, liveRefreshAdmission, setSourceError]);

  useEffect(() => {
    liveRefreshAdmission.activateActor(actorKey);

    return () => liveRefreshAdmission.invalidateActor(actorKey);
  }, [actorKey, liveRefreshAdmission]);

  // `agentStatus` is set only by a completed snapshot and cleared only by a workspace switch,
  // so it means "this workspace has last known data".
  const loadedStatus: AsyncResource<AgentStatus> = agentStatus === null
    ? { status: "loading" }
    : { status: "ready", value: agentStatus };

  const snapshot: AsyncResource<AgentStatus> = errors.snapshot !== undefined
    ? { status: "error", message: errors.snapshot, last: agentStatus }
    : loadedStatus;

  const error = formatWorkspaceError(errors, agentStatus !== null);
  /** Read by the socket's reader at each frame; null on the workspace pane, and until the load resolves it. */
  const ownActorIdRef = useRef<string | null>(null);
  const [paneActorId, setPaneActorId] = useState<string | null>(null);
  const sendLandings = useRef(new Map<string, SendLandingResolvers>());
  const [planFocus, setPlanFocus] = useState<string | null>(null);
  const knownPlans = useRef(new Set<string>());
  const [modelFallbacks, setModelFallbacks] = useState<string[]>([]);
  /** Seeded by the snapshot each (re)connect loads, then replaced by every `turn_claim` frame. */
  const [turnClaim, setTurnClaim] = useState<TurnClaimState>({ kind: "settled" });

  // Shown from the moment the server takes a steer until its durable user row arrives.
  const [steerRuns, setSteerRuns] = useState<InlineSteer[]>([]);
  // Fed by useChat's live stream error and the on-connect replay frame (the ws transport drops
  // its stale request id). The server retains its last terminal record until a later turn
  // supersedes it (agents SDK `_replayTerminalOnAck`); an id announced in `cf_agent_stream_resuming`
  // marks a replay, anything else a live failure.
  const resumedRequestIds = useRef(new Set<string>());
  const [chatError, setChatError] = useState<ChatTurnError | null>(null);

  /** Cleared on the next stream frame, socket close, or a timer keyed to the declared wait: the
   *  clearing frame may never come if the request stays in the retry loop's sleep. `untilMs` is the
   *  wait's end on this browser's clock, so the pill counts down. */
  const [providerWait, setProviderWait] = useState<{
    provider: string;
    modelId?: string;
    untilMs: number;
    attempt: number;
  } | null>(null);

  const providerWaitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activePlan, setActivePlan] = useState<PlanReview | null>(null);
  // Set by the connect frame; the only thing that entitles the pane to draw an empty conversation.
  // False is "not yet", never "nothing".
  const [transcriptSeeded, setTranscriptSeeded] = useState(false);

  const clearProviderWait = useCallback(() => {
    if (providerWaitTimer.current !== null) {
      clearTimeout(providerWaitTimer.current);
      providerWaitTimer.current = null;
    }

    setProviderWait(null);
  }, []);

  // The notice's `waitMs` plus a grace for the next frame; each wait in a chain updates it.
  const showProviderWait = useCallback((notice: { provider: string; modelId?: string; waitMs: number; attempt: number }) => {
    clearProviderWait();
    setProviderWait({
      provider: notice.provider, attempt: notice.attempt, untilMs: Date.now() + notice.waitMs,
      ...(notice.modelId !== undefined && { modelId: notice.modelId }),
    });
    providerWaitTimer.current = setTimeout(() => setProviderWait(null), notice.waitMs + 5_000);
  }, [clearProviderWait]);

  const agentOptions: Parameters<typeof useAgent>[0] = {
    agent: ORCHESTRATOR_AGENT_SLUG,
    name: actorAddress.workspace,
    protocol: window.location.protocol === "https:" ? "wss" : "ws",
    // onOpen always wins: a successful reopen must recover from a prior onError.
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => {
      // No close-code list: the SDK classifies terminal closes (`isTerminalCloseEvent`) and
      // publishes `connectionError`.
      setConnectionStatus("disconnected");
      // Nothing can re-announce this socket's wait once it is gone.
      clearProviderWait();
    }, [clearProviderWait]),
    // Transient no-op; partysocket auto-reconnects and the next onOpen recovers.
    onError: useCallback(() => {}, []),
  };

  if (subordinate) {
    // The actor's own chat path under this room, not the SDK's `sub` facet hop: there is no child
    // Durable Object, so that path is refused. See `hostedActorSocketPath`.
    agentOptions.path = hostedActorSocketPath(subordinate);
  }

  const agent = useAgent(agentOptions);

  // Whoever a frame names: a rename, stream bookkeeping, a provider wait, a turn's error.
  const everyFrame = useCallback((data: SocketFrame) => {
    if (data.type === "workspace_renamed") {
      const displayName = data.displayName;

      if (displayName?.trim()) {
        setAgentStatus((prev) => prev ? { ...prev, displayName } : prev);
      }

      window.dispatchEvent(new CustomEvent("kinu:workspace-renamed", {
        detail: { name: actorAddress.workspace, displayName },
      }));
    } else if (data.type === "cf_agent_stream_resuming") {
      resumedRequestIds.current.add(data.id);
    } else if (data.type === "provider_wait") {
      showProviderWait(data);
    } else if (data.type === "cf_agent_use_chat_response") {
      // A stream frame ends the wait; the on-connect replay must not paint "waiting" either.
      clearProviderWait();
      const failed = terminalChatError(data, resumedRequestIds.current);

      if (failed !== null) setChatError(failed);
    } else {
      // On connect the server replays the last terminal error with a stale request id the transport
      // drops; this handler is the only place that frame is seen. The rule lives in `chat-turn-error.ts`.
      const failed = terminalChatError(data, resumedRequestIds.current);

      if (failed !== null) setChatError(failed);
    }
  }, [actorAddress.workspace, clearProviderWait, showProviderWait]);

  const {
    messages,
    sendMessage,
    regenerate,
    stop,
    isStreaming: streamingTokens,
    status: chatStatus,
    error: streamError,
    connectionError,
  } = useAgentChat({
    agent,
    // The connect frame seeds the transcript; `transcriptSeeded` holds the skeleton until it.
    getInitialMessages: null,
    // Matches the SDK default (cloudflare/agents#2058), pinned so an upstream change cannot move it.
    throttle: 50,
  });

  /** The SDK's flag is false during `submitted` (message sent, no token yet); including it keeps
   *  the composer from admitting a second press in that window. */
  const isStreaming = streamingTokens || chatStatus === "submitted";

  /** The one answer to "is a turn live", folded over the durable claim and the socket. The claim covers a turn
   *  that began before this tab loaded; the socket, one that begins while it is open. */
  const liveness = useMemo(
    () => turnLiveness({ claim: turnClaim, streaming: isStreaming }),
    [turnClaim, isStreaming],
  );

  /** The latch is mutated in the statement that reads it, so a second press in one tick sees it
   *  held. `isStreaming` only mirrors it for rendering. */
  const sendLatch = useRef(newSendLatch());

  const startTurn = useCallback(
    (begin: () => Promise<void>): boolean => admitTurn(sendLatch.current, () => {
      setModelFallbacks([]);

      return begin();
    }),
    [],
  );

  const chatStreamReports = useRef(new Set<Promise<void>>());

  // Always live: the transport only surfaces this for a request id still in flight.
  useEffect(() => {
    if (!streamError) return;
    setChatError({ body: streamError.message || String(streamError), replayed: false });
    const reports = chatStreamReports.current;

    let report: Promise<void> | null = null;

    report = (async () => {
      try {
        await reportChatStreamFailure(streamError, subordinate === undefined ? "root" : "actor", {
          release: await pageDeployedBuildSha(),
          route: routeTemplateOf(location.pathname),
        });
      } catch (cause) {
        diagnostics.event("client_error.reporter_failed", { reason: renderThrownChain({ cause }) });
      } finally {
        if (report !== null) reports.delete(report);
      }
    })();
    reports.add(report);
  }, [streamError, subordinate]);

  // Version skew: /api/health's build sha compared on each reconnect. The baseline is per page
  // (`pageDeployedBuildSha`) because this hook remounts on every workspace navigation.
  const [newerDeployedBuild, setNewerDeployedBuild] = useState(false);

  const refreshDeployedBuild = useCallback(async () => {
    const [baseline, live] = await Promise.all([pageDeployedBuildSha(), fetchDeployedBuildSha()]);

    if (isNewerDeployedBuild(baseline, live)) setNewerDeployedBuild(true);
  }, []);

  // A generation counter, because a ref cannot retrigger an effect. Bumped by backoff retry, every
  // reconnect after the first, and `retryLoad`. Calls queue client-side while the socket is down.
  const [loadGeneration, setLoadGeneration] = useState(0);
  const failureStreak = useRef(0);
  const snapshotLoadTaskId = useRef(0);
  const snapshotLoadTasks = useRef(new Map<number, Promise<void>>());

  // `agentRef` indirection keeps the recovery callbacks stable across renders.
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const sessionRecoveryRef = useRef<SessionRecovery | null>(null);

  sessionRecoveryRef.current ??= createSessionRecovery({
    refetch: () => setLoadGeneration((g) => g + 1),
    forceRedial: () => agentRef.current?.reconnect(),
  });

  const sessionRecovery = sessionRecoveryRef.current;
  // Policy lives in core utils/session-recovery.ts; a corpse socket (open but every RPC times out)
  // is forced to redial.
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
        } catch (cause) {
          diagnostics.failure('session.build_check_failed', toKinuError({
            doing: 'check the deployed build after reconnect', cause, otherwise: 'io',
          }));
        }
      }
    };

    const opened = () => detach(Effect.promise(onOpen));

    agent.addEventListener("open", opened);

    return () => agent.removeEventListener("open", opened);
  }, [agent, refreshDeployedBuild, sessionRecovery]);

  // A reconnect or manual retry changes the transport identity so mounted readers reload too.
  const rpc = useMemo(() => {
    const call = bindRpc(agent);

    return async <T,>(method: string, args: unknown[] = []): Promise<T> => {
      try {
        const value = await call<T>(method, args);
        sessionRecovery.rpcSucceeded();

        return value;
      } catch (cause) {
        sessionRecovery.rpcFailed({ cause }, agent.readyState === WebSocket.OPEN);
        throw cause;
      }
    };
  }, [agent, sessionRecovery, loadGeneration]);

  // Subordinate sockets have no live-data polls, so an open corpse produces no RPC evidence
  // without this acknowledged ping.
  useEffect(() => {
    if (connectionStatus !== "connected") return;

    const id = setInterval(() => detach(Effect.promise(async () => {
      if (agent.readyState !== WebSocket.OPEN) return;

      if (!isSubordinate) {
        agent.send(PAGE_KEEPALIVE.ping);

        return;
      }

      try {
        // The tab's own read, so a corpse fails the ping and the load alike.
        await rpc("getActorSnapshot", [subordinate]);
        setSourceError("snapshot", null);
      } catch (cause) {
        setSourceError("snapshot", errorMessage({ cause }));
      }
    })), 25_000);

    return () => clearInterval(id);
  }, [agent, connectionStatus, isSubordinate, rpc, setSourceError]);

  // Speaks only for itself. Re-running admits a newer load, which retires this one.
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

  /** Aborts the SDK request and the server turn in parallel. Unread messages come back on their
   *  `returned` broadcasts. Releases the send latch on settle, success or failure. */
  const abortChat = useCallback(async (): Promise<void> => {
    // Snapshot before the awaits: a Send admitted meanwhile owns the latch and must keep it.
    const aborting = sendLatch.current.owner;

    try {
      await Promise.all([
        stop(),
        rpc("cancelCurrentWork", []),
      ]);
    } finally {
      abandonTurnIfOwner(sendLatch.current, aborting);

      try {
        await extension?.current?.jobs();
      } catch (cause) {
        diagnostics.failure('workspace.abort_refresh_failed', toKinuError({
          doing: 'refreshing live workspace data',
          cause,
          otherwise: 'io',
        }));
      }
    }
  }, [stop, rpc, extension]);

  const adoptPlan = (plan: PlanReview | null): void => {
    if (!plan) return;
    const key = `${plan.id}:${plan.revision}`;

    if (!knownPlans.current.has(key) && plan.status === "pending") setPlanFocus(key);
    knownPlans.current.add(key);
    setActivePlan(plan);
  };

  const paneFrame = async (msg: SocketFrame): Promise<void> => {
    if (msg.type === "cf_agent_chat_messages") {
      setTranscriptSeeded(true);
    } else if (msg.type === "model_fallback") {
      setModelFallbacks((prev) => [...prev, msg.message]);
    } else if (msg.type === "steer_status") {
      settleSendLanding(sendLandings.current, msg);
      // `returned` (handed back to the composer) and `turn` (now its own user turn) both remove the bubble.
      setSteerRuns((prev) => msg.status === "returned" || msg.status === "turn"
        ? prev.filter((s) => s.id !== msg.steerId)
        : [
          ...prev.filter((s) => s.id !== msg.steerId),
          {
            id: msg.steerId, text: msg.text, state: msg.status,
            atStep: msg.atStep ?? null,
          },
        ]);
    } else if (msg.type === "plan_updated") {
      adoptPlan(parsePlanReview({ value: msg.plan }));
    } else if (msg.type === TURN_CLAIM_FRAME) {
      setTurnClaim(msg.claim);
    } else {
      await extension?.current?.frame(msg);
    }
  };


  useSocketFrames(agent, () => ({ isSubordinate, ownActorId: ownActorIdRef.current }), { everyFrame, paneFrame });

  const retryLoad = useCallback(() => {
    failureStreak.current = 0;
    setSourceError("model", null);
    // The SDK stops auto-redialling exactly when it sets `connectionError`, so Retry must force one.
    sessionRecovery.manualRetry(agentRef.current?.connectionError != null);

    extension?.current?.refresh();
  }, [extension, sessionRecovery, setSourceError]);

  /** Never edits the claim locally: the server's `turn_claim` frame retires the button, so a refused
   *  recovery still shows as stuck. Resolves the failure reason (also the workspace notice) or null. */
  const recoverTurn = useCallback(async (): Promise<string | null> => {
    setSourceError("recover", null);
    let thrown: { cause: unknown } | null = null;

    try {
      await rpc("recoverStrandedTurn", []);
    } catch (cause) {
      thrown = { cause };
    }

    if (thrown !== null) {
      const reason = `Recovery failed: ${errorMessage(thrown)}`;
      setSourceError("recover", reason);

      return reason;
    }

    extension?.current?.refresh();

    return null;
  }, [extension, rpc, setSourceError]);

  // One round trip: a second awaited RPC for the active plan makes a plan-gated composer paint in
  // build mode and jump. The exploration canvas is not seeded here; its surface fetches its own.
  async function loadAllData(
    isCurrent: () => boolean,
    isSourceCurrent: (source: LiveRefreshSource) => boolean,
  ): Promise<void> {
    const snap = await rpc<WorkspaceSnapshot>("getWorkspaceSnapshot", []);

    if (!isCurrent()) return;
    setAgentStatus(snap.status);

    if (isSourceCurrent("plan")) {
      const loadedPlan = parsePlanReview({ value: snap.activePlan });

      if (loadedPlan) knownPlans.current.add(`${loadedPlan.id}:${loadedPlan.revision}`);
      setActivePlan(loadedPlan);
    }

    // Replace, never merge: durable rows are the authority, so a reconnecting tab learns missed
    // transitions and drops settled chips. A racing broadcast upserts by id afterwards.
    setSteerRuns(snap.pendingSteers);
    setTurnClaim(snap.turnClaim);
    await extension?.current?.snapshot(snap, isSourceCurrent);
  }

  async function loadSubordinateData(isCurrent: () => boolean): Promise<void> {
    // The root resolves the name through its directory, so a tab cannot ask about a non-child actor.
    const actorSnapshot = await rpc<SubordinateSnapshot>("getActorSnapshot", [subordinate]);

    if (!isCurrent()) return;
    // Set before anything is admitted: stamped frames are this chat's only while the id matches,
    // and a page request without it reads the workspace's rows.
    ownActorIdRef.current = actorSnapshot.actorId;
    setPaneActorId(actorSnapshot.actorId);
    setAgentStatus({
      name: actorSnapshot.name,
      displayName: actorSnapshot.displayName,
      purpose: actorSnapshot.role,
      soul: actorSnapshot.mission,
      createdAt: 0,
      scaffoldVersion: 0,
      model: actorSnapshot.model.model,
      modelSource: actorSnapshot.model.source,
      reasoningEffort: actorSnapshot.reasoningEffort,
      searchNodeCount: 0,
      messageCount: actorSnapshot.messageCount,
      forkLineage: null,
    });
    const loadedPlan = parseActivePlanReview({ value: actorSnapshot.activePlan });

    if (loadedPlan) knownPlans.current.add(`${loadedPlan.id}:${loadedPlan.revision}`);
    setActivePlan(loadedPlan);
    setSteerRuns(actorSnapshot.pendingSteers);
  }

  useEffect(() => {
    setLoadGeneration(0);
    failureStreak.current = 0;
    // The abandoned turn's stale owner token can no longer release the latch, so a late
    // completion cannot open it for the next holder.
    abandonTurn(sendLatch.current);
    setErrors({});
    setAgentStatus(null);
    knownPlans.current.clear();
    setPlanFocus(null);
    setActivePlan(null);
    setChatError(null);
    setModelFallbacks([]);
    // The last actor's id would admit its frames here and page its history.
    ownActorIdRef.current = null;
    setPaneActorId(null);
  }, [workspace, subordinate]);

  /**
   * Idle: starts a turn under the send latch via the SDK chat path, answering `'turn'`. Otherwise
   * the actor's `send` RPC splices it into the running turn or runs it as the next turn, and
   * `settled` says which; nothing here re-sends. `null`: nothing was sent. The decision reads the
   * latch, not `isStreaming`: two presses in one tick both see stale reactive state.
   */
  const sendChat = useCallback((
    content: string,
    files: FileUIPart[] = [],
    mode: "plan" | "build" = "build",
  ): SendAdmission => {
    const parts: UIMessage["parts"] = [
      ...files,
      ...(content ? [{ type: "text" as const, text: content }] : []),
    ];

    if (parts.length === 0) return null;

    if (sendLatch.current.owner === null && !isStreaming) {
      const admitted = startTurn(() => {
        setChatError(null);

        return sendMessage({ role: "user", parts, metadata: { kinuMode: mode } });
      });

      if (admitted) return { landed: "turn" };
    }

    // A Plan-locked message that misses its turn must still run as a Plan turn.
    const attachments = files.map((file) => ({ filename: file.filename ?? "attachment", mediaType: file.mediaType, url: file.url }));

    // Id minted here so the landing listener exists before any broadcast. The call has a
    // deadline; the landing has none.
    const id = crypto.randomUUID();
    const landing = Promise.withResolvers<SendLanding>();
    sendLandings.current.set(id, landing);

    return { landed: "mid-turn", settled: landingAfter(rpc<void>("send", [content, id, attachments, mode]), sendLandings.current, id, landing.promise) };
  }, [startTurn, sendMessage, isStreaming, rpc]);

  /** `regenerate`, not `sendMessage`, which appended a duplicate user message per press. Under the
   *  same latch as `sendChat`: a retry starts a turn. */
  const retryLastMessage = useCallback((): boolean => {
    if (messages.length === 0) return false;

    return startTurn(() => {
      setChatError(null);

      return regenerate();
    });
  }, [startTurn, messages.length, regenerate]);

  /** Resolves null on success or the failure reason, which is also recorded on `error` after the
   *  picker is rolled back. Callers reporting "Saved" must check the result; it never rejects. */
  const setModel = useCallback(async (modelId: string): Promise<string | null> => {
    setAgentStatus(prev => prev ? { ...prev, model: modelId } : prev);

    try {
      const r = subordinate === undefined
        ? await rpc<{ ok?: boolean; spec?: string }>("setModel", [modelId])
        : await rpc<{ ok?: boolean; spec?: string }>("setActorModel", [subordinate, modelId]);

      // The server may have normalized the spec.
      const spec = r?.spec;

      if (spec) setAgentStatus((prev) => prev ? { ...prev, model: spec } : prev);
      setSourceError("model", null);

      return null;
    } catch (err) {
      // Roll back to the stored spec so the picker never shows an unsaved model.
      let reason = `Could not switch model: ${errorMessage({ cause: err })}`;

      try {
        const stored = subordinate === undefined
          ? await rpc<{ spec?: string | null }>("getStoredModelSpec", [])
          : { spec: (await rpc<SubordinateSnapshot>("getActorSnapshot", [subordinate])).model.model };

        setAgentStatus(prev => prev ? { ...prev, model: stored.spec ?? '' } : prev);
      } catch (rollbackErr) {
        reason += `. Could not re-read the saved model either (${errorMessage({ cause: rollbackErr })}), so the picker may not show the saved model`;
      }

      setSourceError("model", reason);

      return reason;
    }
  }, [rpc, setSourceError, subordinate]);

  /** Null clears to the tier's. Optimistic, rolled back on refusal. */
  const setReasoningEffort = useCallback(async (effort: ReasoningEffort | null): Promise<void> => {
    const before = agentStatus?.reasoningEffort ?? null;
    setAgentStatus((prev) => prev ? { ...prev, reasoningEffort: effort } : prev);

    try {
      await rpc("setReasoningEffort", subordinate === undefined ? [effort] : [effort, subordinate]);
      setSourceError("model", null);
    } catch (err) {
      setAgentStatus((prev) => prev ? { ...prev, reasoningEffort: before } : prev);
      setSourceError("model", `Could not set the thinking level: ${errorMessage({ cause: err })}`);
    }
  }, [rpc, setSourceError, subordinate, agentStatus?.reasoningEffort]);

  const setDisplayName = useCallback(async (displayName: string): Promise<string> => {
    const result = await rpc<{ displayName: string }>("setDisplayName", [displayName]);
    const saved = result.displayName;
    setAgentStatus((prev) => prev ? { ...prev, displayName: saved } : prev);

    return saved;
  }, [rpc]);

  const rereadPlan = useCallback(() => refreshCurrentLiveResource(
    "plan",
    () => rpc<unknown>("getActivePlanReview", []),
    (plan) => setActivePlan(parseActivePlanReview({ value: plan })),
  ), [refreshCurrentLiveResource, rpc]);

  return {
    chat: {
      messages,
      /** Null when nothing is being waited on: "working" vs "waiting on {provider}". */
      providerWait,
      liveness,
      recoverTurn,
      /** Until true, empty `messages` means "not delivered", not "there is nothing". */
      transcriptSeeded,
      connectionStatus,
      /** Set when reconnecting cannot help (not this caller's workspace, or gone). The SDK owns the
       *  classification and clears it on open. */
      terminalClose: connectionError,
      /** Latched once per page load. */
      newerDeployedBuild,
      /** Never auto-expires. */
      error,
      /** Also cancels the pending backoff retry and clears a stale action error. */
      retryLoad,
      chatError,
      clearChatError: () => setChatError(null),
      retryLastMessage,
      agentStatus,
      /** A pane may only report "none" for a read that came back; `agentStatus` alone cannot tell
       *  loading from failed. */
      snapshot,
      activePlan,
      planFocus,
      sendChat,
      abortChat,
      /** Answered, and refused while a turn runs; the clear frame the server sends ahead of the answer empties every window. */
      clearConversation: () => rpc<void>("clearConversation", []),
      setModel,
      setReasoningEffort,
      setDisplayName,
      modelFallbacks,
      /** Returned steers are removed by the server's broadcast, not by the surface. */
      steerRuns,
      rpc,
      rawAgent: agent,
      actorAddress,
      isSubordinate,
      /** Addresses cursored reads of this chat's older history. */
      paneActorId,
    },
    link: {
      agent, rpc, actorKey, liveRefreshAdmission, refreshCurrentLiveResource, setSourceError, errors,
      loaded: agentStatus !== null, streaming: isStreaming, rereadPlan,
    },
  };
}

type ChatLink = ReturnType<typeof useChatOwner>["link"];

/** The reads only the workspace's pane draws. */
function useWorkspaceReads(link: ChatLink) {
  const {
    agent, rpc, actorKey, liveRefreshAdmission, refreshCurrentLiveResource, setSourceError, errors, loaded, streaming, rereadPlan,
  } = link;

  const [memory, setMemory] = useState<MemoryEntry[]>([]);
  const [mctsTrees, setMctsTrees] = useState<ReadonlyMap<string, ForkNode>>(new Map());
  const [memoryContent, setMemoryContent] = useState<string>("");
  const [consentResolutionErrors, setConsentResolutionErrors] = useState<ReadonlyMap<string, string>>(new Map());

  const setConsentResolutionError = useCallback((consentId: string, message: string | null) => {
    setConsentResolutionErrors((previous) => {
      if ((previous.get(consentId) ?? null) === message) return previous;
      const next = new Map(previous);

      if (message) next.set(consentId, message); else next.delete(consentId);

      return next;
    });
  }, []);

  const consentResolutionReasons = [...new Set(consentResolutionErrors.values())];

  const liveErrors = consentResolutionReasons.length === 0
    ? errors
    : { ...errors, consentResolution: formatNaturalList(consentResolutionReasons) };

  const error = formatWorkspaceError(liveErrors, loaded);
  const [executors, setExecutors] = useState<ExecutorInfo[]>([]);
  const [workspaceAgents, setWorkspaceAgents] = useState<PanelAgent[] | null>(null);
  const [executorOutputs, setExecutorOutputs] = useState<Map<string, ExecutorOutput[]>>(new Map());
  const [lastActiveExecutor, setLastActiveExecutor] = useState<string | null>(null);
  // Listing ports never provisions a sandbox: [] unless the executor is already active.
  const [pinnedPorts, setPinnedPorts] = useState<PinnedPreviewPort[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewStarting, setPreviewStarting] = useState<readonly string[]>([]);
  const exposedPortsRefreshGeneration = useRef(0);
  const [backgroundJobs, setBackgroundJobs] = useState<BackgroundJob[]>([]);
  const [jobOutputs, setJobOutputs] = useState<Readonly<Record<string, JobOutputTail>>>({});
  const listedJobs = useRef<BackgroundJob[]>([]);
  listedJobs.current = backgroundJobs;

  const liveJobs = useMemo(() => backgroundJobs.map((job) => {
    const told = jobOutputs[job.id];

    if (told === undefined || !runningJob(job) || (job.output?.seq ?? 0) >= told.seq) return job;

    return { ...job, output: told };
  }), [backgroundJobs, jobOutputs]);

  const [slates, setSlates] = useState<SlateSummary[]>([]);
  const knownSlates = useRef<Set<string> | null>(null);
  const knownPorts = useRef<Set<string> | null>(null);
  const [previewFocus, setPreviewFocus] = useState<string | null>(null);
  const [arrivedReference, setArrivedReference] = useState<WorkspacePlanReference | null>(null);
  // `knownWorkspacePlans`: references this connection was told about (dedupes repeated frames).
  // `claimedWorkspacePlans`: references a pane already acted on, so a hint never fires twice.
  const knownWorkspacePlans = useRef(new Set<string>());
  const claimedWorkspacePlans = useRef(new Set<string>());
  const [slateReloads, setSlateReloads] = useState<ReadonlyMap<string, number>>(new Map());
  const [changesMoved, setChangesMoved] = useState(0);
  const [readMoves, setReadMoves] = useState<ReadMoves>({});
  const [pendingConsents, setPendingConsents] = useState<PendingConsent[]>([]);
  /** A connect clears it. */
  const [unavailableDevices, setUnavailableDevices] = useState<UnavailableDevice[] | null>(null);
  // One read behind both the Work queue and the strip's accent badge, so they cannot disagree.
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  // Unknown until the first read: an optimistic absence would flip the strip to Files first.
  const [tabPresence, setTabPresence] = useState<TabPresence | undefined>(undefined);
  const [branchRuns, setBranchRuns] = useState<BranchRun[]>([]);
  // Counts, not timestamps: a transcript only needs to notice its branch moved, without a shared clock.
  const [headActivity, setHeadActivity] = useState<ReadonlyMap<string, number>>(new Map());

  const bumpHeadActivity = useCallback((headId: string) => {
    setHeadActivity((previous) => {
      const next = new Map(previous);
      next.set(headId, (previous.get(headId) ?? 0) + 1);

      return next;
    });
  }, []);

  /** Ephemeral: the durable step is the truth. Retired when the step lands (`head_activity`,
   *  `HeadDeltas.retire`), on a terminal branch status, a cancelled turn, or socket drop. */
  const [headDeltaMap, setHeadDeltaMap] = useState<ReadonlyMap<string, HeadDelta>>(new Map());

  const retireDelta = useCallback((headId: string) => {
    setHeadDeltaMap((previous) => retireHeadDelta(previous, headId));
  }, []);

  const forgetDeltas = useCallback(() => { setHeadDeltaMap(new Map()); }, []);

  const headDeltas = useMemo<HeadDeltas>(() => ({
    get: (headId) => headDeltaMap.get(headId),
    retire: retireDelta,
  }), [headDeltaMap, retireDelta]);

  const [subordinates, setSubordinates] = useState<SubordinateRosterEntry[]>([]);
  const [subordinateEvents, setSubordinateEvents] = useState<SubordinateActivityEvent[]>([]);
  const [signalCards, setSignalCards] = useState<readonly SignalCard[]>([]);

  // A socket can replay a frame after reconnect; `pushSeq` is per root, so frames for different
  // roots cannot reject or replace each other.
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

  // A new socket cannot know what a running head had half-written.
  useEffect(() => {
    const opened = () => { knownPorts.current = null; };

    agent.addEventListener("open", opened);
    agent.addEventListener("close", forgetDeltas);

    return () => {
      agent.removeEventListener("open", opened);
      agent.removeEventListener("close", forgetDeltas);
      forgetDeltas();
    };
  }, [agent, forgetDeltas]);

  const refreshBackgroundJobs = useCallback(() => refreshCurrentLiveResource(
    "jobs",
    () => rpc<BackgroundJob[]>("listBackgroundJobs", [50]),
    setBackgroundJobs,
  ), [refreshCurrentLiveResource, rpc]);

  const refreshPendingConsents = useCallback(() => refreshCurrentLiveResource(
    "consents", () => rpc<PendingConsent[]>("listPendingConsents", []), setPendingConsents,
  ), [refreshCurrentLiveResource, rpc]);

  const refreshPendingActions = useCallback(() => refreshCurrentLiveResource(
    "pendingActions",
    () => rpc<PendingAction[]>("listPendingActions", []),
    setPendingActions,
  ), [refreshCurrentLiveResource, rpc]);

  const refreshTabPresence = useCallback(() => refreshCurrentLiveResource(
    "presence",
    () => rpc<TabPresence>("getWorkspaceTabPresence", []),
    setTabPresence,
  ), [refreshCurrentLiveResource, rpc]);

  const applySlates = useCallback((listing: SlateSummary[], announce = false) => {
    const previous = knownSlates.current;

    if (announce && previous !== null) {
      const added = listing.find(slate => !previous.has(slate.id));

      if (added) setPreviewFocus(`slate:${added.id}`);
    }

    knownSlates.current = new Set([...(previous ?? []), ...listing.map(slate => slate.id)]);
    setSlates(listing);
    setSlateReloads((reloads) => pruneSlateReloads(reloads, listing));
  }, []);

  const refreshSlates = useCallback(() => refreshCurrentLiveResource(
    "slates",
    () => rpc<{ slates: SlateSummary[]; problems: SlateProblem[] }>("listSlates", []).then((listing) => listing.slates),
    (listing) => applySlates(listing, true),
  ), [applySlates, refreshCurrentLiveResource, rpc]);

  /** Through the "roster" admission, so a read still in flight cannot overwrite it. */
  const writeRoster = useCallback((next: SetStateAction<SubordinateRosterEntry[]>) => refreshCurrentLiveResource(
    "roster", async () => next, setSubordinates,
  ), [refreshCurrentLiveResource]);

  const refreshRoster = useCallback(() => refreshCurrentLiveResource("roster", async () => {
    const roster = parseSubordinateRoster({ value: await rpc<unknown>("listSubordinates", []) });

    if (!roster) throw new Error("Subordinate roster returned an invalid response");

    return roster;
  }, setSubordinates), [refreshCurrentLiveResource, rpc]);

  // Stable, or the changelog hook's effect fires markChangelogSeen every render.
  const clearChangelogUnseen = useCallback(() => {
    setPendingActions((prev) => prev.filter((a) => a.kind !== "unseen_changes"));
  }, []);

  // The server pushes the fact, not the rows; one re-read updates every open tab.
  const reread = async (resource: string, refresh: () => Promise<void>): Promise<void> => {
    try {
      await refresh();
    } catch (cause) {
      diagnostics.failure('workspace.live_refresh_failed', toKinuError({ doing: 'refreshing live workspace data', cause, otherwise: 'io' }), { resource });
    }
  };

  const paneFrame = async (msg: SocketFrame): Promise<void> => {
    if (msg.type === "mcts-progress") {
      setMctsTreeFromProgress(msg);
    } else if (msg.type === "device_consent") {
      setPendingConsents((prev) => {
        if (prev.some((c) => c.consentId === msg.consentId)) return prev;

        const card: PendingConsent = {
          consentId: msg.consentId,
          deviceLabel: msg.deviceLabel,
          method: msg.method ?? "exec",
          command: msg.command,
          createdAt: Date.now(),
        };

        if (msg.workspaceName) card.workspaceName = msg.workspaceName;

        return [...prev, card];
      });
    } else if (msg.type === "device_consent_resolved") {
      setPendingConsents((prev) => prev.filter((c) => c.consentId !== msg.consentId));
      setConsentResolutionError(msg.consentId, null);
    } else if (msg.type === "device_unavailable") {
      setUnavailableDevices(msg.devices);
    } else if (msg.type === "device_available") {
      setUnavailableDevices(null);
    } else if (msg.type === "work_cancelled") {
      forgetDeltas();
      await reread('background_jobs', refreshBackgroundJobs);
    } else if (msg.type === JOB_OUTPUT_EVENT) {
      const listed = listedJobs.current.find((job) => job.id === msg.jobId)?.output;
      const running = new Set(listedJobs.current.filter(runningJob).map((job) => job.id));

      setJobOutputs((told) => ({
        ...Object.fromEntries(Object.entries(told).filter(([id]) => running.has(id))),
        [msg.jobId]: followJobOutput(told[msg.jobId] ?? listed, msg),
      }));
    } else if (msg.type === READS_CHANGED_EVENT) {
      setReadMoves((moves) => Object.fromEntries([
        ...Object.entries(moves), ...msg.reads.map((read) => [read, (moves[read] ?? 0) + 1]),
      ]));
    } else if (msg.type === SLATES_CHANGED_EVENT) {
      setSlateReloads((previous) => {
        const next = new Map(previous);

        for (const id of msg.ids) next.set(id, (next.get(id) ?? 0) + 1);

        return next;
      });

      await reread('slates', refreshSlates);
    } else if (msg.type === CHANGES_MOVED_EVENT) {
      setChangesMoved((moved) => moved + 1);
    } else if (msg.type === "branch_status") {
      const status = branchRunStatus(msg.status);

      // The head id derives from the run id, so retire without waiting for a journal write a
      // failed branch never makes.
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
      // The step landed: re-read the journal and retire its in-progress paint so both never show.
      retireDelta(msg.headId);
      bumpHeadActivity(msg.headId);
    } else if (msg.type === "head_stream") {
      setHeadDeltaMap((previous) => appendHeadDelta(previous, msg.headId, msg.kind, msg.delta));
    } else if (msg.type === "steer_status") {
    } else if (msg.type === "signal_card") {
      const card = parseSignalCardEvent({ value: msg });

      if (card) setSignalCards((current) => applySignalCard(current, card));
    } else if (msg.type === 'workspace_plan_updated') {
      const key = JSON.stringify(msg.reference);

      if (!knownWorkspacePlans.current.has(key)) {
        knownWorkspacePlans.current.add(key);
        setArrivedReference(msg.reference);
      }
    } else if (msg.type === "subordinate_event") {
      const subordinateEvent = parseSubordinateActivityEvent({ value: msg });

      if (subordinateEvent) {
        setSubordinateEvents((current) => current.some((listed) => listed.id === subordinateEvent.id)
          ? current
          : [...current.slice(-49), subordinateEvent]);
      }
    } else if (msg.type === "executor-output") {
      setExecutorOutputs(prev => {
        const next = new Map(prev);
        const existing = next.get(msg.executor) ?? [];
        // A live echo is the whole output, so the stored length is what is shown.
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

  const resolveConsent = useCallback((consentId: string, decision: ConsentDecision) => resolvePendingConsent({
    consentId,
    decision,
    resolve: (id, choice) => rpc("resolveDeviceConsent", [id, choice]),
    remove: (id) => setPendingConsents((previous) => previous.filter((consent) => consent.consentId !== id)),
    report: setConsentResolutionError,
    isCurrent: liveRefreshAdmission.admit(actorKey, `consentResolution:${consentId}`),
  }), [actorKey, liveRefreshAdmission, rpc, setConsentResolutionError]);

  const refreshExposedPorts = useCallback(async () => {
    const generation = ++exposedPortsRefreshGeneration.current;

    const results = await Promise.all(["workspace", "sandbox"].map(async (executor) => {
      try {
        const result = await rpc<ExposedPortList>("getExposedPorts", [executor]);

        return { executor, result } satisfies ExecutorPortRefresh;
      } catch (cause) {
        return {
          executor,
          result: { ports: [], error: errorMessage({ cause }) },
        } satisfies ExecutorPortRefresh;
      }
    }));

    if (generation !== exposedPortsRefreshGeneration.current) return;
    setPinnedPorts((previous) => {
      const next = reconcilePreviewPorts(previous, results);
      setPreviewError(next.error);
      setPreviewStarting((before) => (before.join() === next.starting.join() ? before : next.starting));

      if (next.error === null) {
        const ids = next.ports.map(port => `${port.executor}:${port.port}`);
        const previousIds = knownPorts.current;
        const added = previousIds === null ? undefined : ids.find(id => !previousIds.has(id));

        if (added) setPreviewFocus(`preview:${added}`);
        knownPorts.current = new Set([...(previousIds ?? []), ...ids]);
      }

      return next.ports;
    });
  }, [rpc]);

  const liveReads = useMemo((): Partial<Record<LiveRead, () => Promise<void>>> => ({
    getExposedPorts: refreshExposedPorts,
    getMemoryContent: () => refreshCurrentLiveResource("memoryContent", () => rpc<string>("getMemoryContent", []), setMemoryContent),
    getExecutors: () => refreshCurrentLiveResource("executors", () => rpc<ExecutorInfo[]>("getExecutors", []), setExecutors),
    listWorkspaceAgents: () => refreshCurrentLiveResource("agents", () => rpc<PanelAgent[]>("listWorkspaceAgents", []), setWorkspaceAgents),
    listSubordinates: refreshRoster,
    listBackgroundJobs: refreshBackgroundJobs,
    listPendingActions: refreshPendingActions,
    getWorkspaceTabPresence: refreshTabPresence,
    listSlates: refreshSlates,
    getActivePlanReview: rereadPlan,
  }), [
    refreshBackgroundJobs, refreshCurrentLiveResource, refreshExposedPorts, refreshPendingActions, refreshRoster, refreshSlates,
    refreshTabPresence, rereadPlan, rpc,
  ]);

  const liveRefreshTaskId = useRef(0);
  const liveRefreshTasks = useRef(new Map<number, Promise<void>>());

  const rereadLive = useCallback((reads: readonly LiveRead[], also: readonly (() => Promise<void>)[] = []): void => {
    const taskId = ++liveRefreshTaskId.current;

    const task = (async () => {
      try {
        await Promise.all([...reads.map((read) => liveReads[read]?.()), ...also.map((read) => read())]);
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
  }, [liveReads]);

  const refreshLiveData = useCallback((): void => {
    rereadLive(LIVE_READS, [refreshPendingConsents]);
  }, [refreshPendingConsents, rereadLive]);

  const lastMoves = useRef<ReadMoves>({});

  useEffect(() => {
    const moved = LIVE_READS.filter((read) => (readMoves[read] ?? 0) !== (lastMoves.current[read] ?? 0));

    lastMoves.current = readMoves;

    if (moved.length > 0) rereadLive(moved);
  }, [readMoves, rereadLive]);

  const wasStreaming = useRef(false);
  useEffect(() => {
    if (streaming) {
      wasStreaming.current = true;
    } else if (wasStreaming.current) {
      wasStreaming.current = false;
      refreshLiveData();
    }
  }, [streaming, refreshLiveData]);

  async function applySnapshot(snap: WorkspaceSnapshot, isSourceCurrent: (source: LiveRefreshSource) => boolean): Promise<void> {
    if (isSourceCurrent("memoryContent")) {
      setMemoryContent(snap.memoryContent);

      if (snap.memoryContent) setMemory(memoryRows(snap.memoryContent));
    }

    if (isSourceCurrent("executors")) {
      setExecutors(snap.executors);
      setLastActiveExecutor(snap.lastActiveExecutor);
      const outputs = new Map<string, ExecutorOutput[]>();

      for (const eo of snap.executorOutputs) outputs.set(eo.name, eo.outputs.slice().reverse());
      setExecutorOutputs(outputs);
    }

    if (isSourceCurrent("presence")) setTabPresence(snap.tabPresence);

    if (isSourceCurrent("slates")) applySlates(snap.slates);
    setBranchRuns(snap.branchRuns.map((run) => ({
      branchId: run.branchId, task: run.task, status: run.status,
    })));

    try {
      await Promise.all([
        refreshExposedPorts(), refreshPendingActions(), refreshRoster(), refreshBackgroundJobs(), refreshPendingConsents(),
        liveReads.listWorkspaceAgents?.(),
      ]);
    } catch (cause) {
      diagnostics.failure('workspace.snapshot_followup_refresh_failed', toKinuError({
        doing: 'refreshing live workspace data',
        cause,
        otherwise: 'io',
      }));
    }
  }

  useEffect(() => {
    ++exposedPortsRefreshGeneration.current;
    wasStreaming.current = false;
    searchSeq.current += 1;
    clearTimeout(searchTimer.current);
    setConsentResolutionErrors(new Map());
    setMemory([]);
    setMemoryContent("");
    mctsProgressState.current =
      activateMctsProgressActor<ForkNode>(mctsProgressState.current, actorKey);
    setMctsTrees(mctsProgressState.current.trees);
    setExecutorOutputs(new Map());
    setLastActiveExecutor(null);
    setPinnedPorts([]);
    setPreviewError(null);
    setPreviewStarting([]);
    setBackgroundJobs([]);
    setSlates([]);
    setTabPresence(undefined);
    knownSlates.current = null;
    knownPorts.current = null;
    knownWorkspacePlans.current.clear();
    claimedWorkspacePlans.current.clear();
    setArrivedReference(null);
    setPreviewFocus(null);
    setSlateReloads(new Map());
    setPendingConsents([]);
    setPendingActions([]);
    setBranchRuns([]);
    setSubordinates([]);
    setSubordinateEvents([]);
    setSignalCards([]);
  }, [actorKey]);


  /** True exactly once per reference per connection. Records only the key handed in, so a newer
   *  arrival is never suppressed; the held reference is never cleared. */
  const claimWorkspacePlan = useCallback((reference: WorkspacePlanReference): boolean => {
    const key = JSON.stringify(reference);

    if (claimedWorkspacePlans.current.has(key)) return false;
    claimedWorkspacePlans.current.add(key);

    return true;
  }, []);

  const workspacePlanArrival = useMemo<WorkspacePlanArrival | null>(
    () => arrivedReference === null
      ? null
      : { reference: arrivedReference, claim: claimWorkspacePlan },
    [arrivedReference, claimWorkspacePlan],
  );

  // Orders replies so a slow earlier query cannot land last over a newer prefix.
  const searchSeq = useRef(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(searchTimer.current), []);

  const searchMemory = useCallback((q: string) => {
    clearTimeout(searchTimer.current);
    const seq = ++searchSeq.current;

    if (!q.trim()) {
      setSourceError("memory", null);

      if (memoryContent) setMemory(memoryRows(memoryContent));

      return;
    }

    searchTimer.current = setTimeout(() => detach(Effect.promise(async () => {
      // Published only while this query is still the newest.
      let thrown: { cause: unknown } | null = null;

      try {
        const results = await rpc<Array<{ path: string; startLine?: number; endLine?: number; snippet: string; rrfScore: number }>>("searchMemoryHybrid", [q]);

        if (seq !== searchSeq.current) return;
        setSourceError("memory", null);
        setMemory((results ?? []).map(r => ({
          path: r.path,
          content: r.snippet,
          matchScore: r.rrfScore,
          updatedAt: r.startLine ? `lines ${r.startLine}-${r.endLine}` : "",
          savedBy: null,
        })));
      } catch (err) {
        thrown = { cause: err };
      }

      if (thrown !== null && seq === searchSeq.current) {
        setSourceError("memory", `Memory search failed: ${errorMessage(thrown)}`);
      }
    })), MEMORY_SEARCH_DEBOUNCE_MS);
  }, [rpc, memoryContent, setSourceError]);

  // Fires the RPC only; the broadcast renders the row. An optimistic append double-rendered output.
  const executeInExecutor = useCallback((executorId: string, command: string) => {
    return rpc<ExecutorCommandResult>("executeInExecutor", [executorId, command]);
  }, [rpc]);

  const extension: WorkspaceExtension = { snapshot: applySnapshot, frame: paneFrame, refresh: refreshLiveData, jobs: refreshBackgroundJobs };

  return {
    extension,
    error,
    reads: {
      memory,
      memoryContent,
      mctsTrees,
      searchMemory,
      executors,
      workspaceAgents,
      executorOutputs,
      lastActiveExecutor,
      executeInExecutor,
      pinnedPorts,
      previewFocus,
      workspacePlanArrival,
      previewError,
      previewStarting,
      refreshExposedPorts,
      backgroundJobs: liveJobs,
      refreshBackgroundJobs,
      pendingActions,
      /** Called by Work's decide so a decided row leaves the list at once, not on the next poll. */
      refreshPendingActions,
      tabPresence,
      slates,
      slateReloads,
      changesMoved,
      readMoves,
      pendingConsents,
      resolveConsent,
      unavailableDevices,
      /** Work marks self-changes seen server-side, then calls the clear. */
      clearChangelogUnseen,
      branchRuns,
      dismissBranchRun: (branchId: string) =>
        setBranchRuns((prev) => prev.filter((b) => b.branchId !== branchId)),
      /** A reader whose branch id ticked re-reads the journal. */
      headActivity,
      /** Retired the moment the step lands, so a reader never shows the same text twice. */
      headDeltas,
      /** Throws on error ('agent busy', 'fork point not found', 'agent name already exists'). */
      forkAgent: (untilMessageId: string, opts?: { name?: string }) =>
        rpc<{ id: string; name: string; url: string; forkPointMs: number }>("forkAgent", [untilMessageId, opts ?? {}]),
      subordinates,
      subordinateEvents,
      signalCards,
      /** The server answers a blank displayName; the UI shows "New agent" until the titler lands. */
      createSubordinate: async () => {
        const result = await rpc<{
          name: string;
          displayName: string;
          subordinate: SubordinateRosterEntry;
        }>("createSubordinateAgent", []);

        await writeRoster((current) => [
          ...current.filter((entry) => entry.name !== result.subordinate.name),
          result.subordinate,
        ]);

        return result;
      },
      /** A user-chosen name permanently blocks auto-retitling (server-side). */
      renameSubordinate: async (name: string, displayName: string) => {
        const result = v.parse(
          SubordinateMutationEnvelopeSchema,
          await rpc<unknown>("renameSubordinateAgent", [name, displayName]),
        );

        const entry = result.subordinate;
        await writeRoster((current) => current.map(
          (existing) => existing.name === entry.name ? entry : existing,
        ));

        return entry;
      },
      dismissSubordinate: async (name: string, keepHistory?: boolean) => {
        const args = keepHistory === undefined ? [name] : [name, keepHistory];
        const result = await rpc<{ ok: true; name: string; historyKept: boolean }>("dismissSubordinate", args);

        await writeRoster((current) => current.filter((entry) => entry.name !== result.name));

        return result;
      },
    },
  };
}

/** The workspace's chat and its reads, over one socket. */
export function useKinu(workspace?: string) {
  const extension = useRef<WorkspaceExtension | null>(null);
  const { chat, link } = useChatOwner(workspace, extension);
  const { reads, extension: own, error } = useWorkspaceReads(link);
  extension.current = own;

  return { ...chat, ...reads, error };
}

/** One hosted agent's chat, without the workspace's reads. */
export function useActorChat(address: KinuActorAddress) {
  return useChatOwner(address, null).chat;
}

/** Beyond `renderThrownChain`: a bare string from a JSON error body, and an object with no
 *  message, which would otherwise render as `[object Object]`. */
function errorMessage({ cause }: { cause: unknown }): string {
  if (cause instanceof Error && cause.message) return renderThrownChain({ cause });
  const text = v.safeParse(v.string(), cause);

  if (text.success && text.output.trim()) return text.output;

  try { return JSON.stringify(cause) || "unknown error"; }
  catch (error) { return `unrenderable error: ${renderThrownChain({ cause: error })}`; }
}

function formatNaturalList(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "unknown data";

  if (values.length === 2) return `${values[0]} and ${values[1]}`;

  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function parseActivePlanReview({ value }: { value: unknown }): PlanReview | null {
  const parsed = v.safeParse(v.nullable(PlanReviewSchema), value);

  if (!parsed.success) {
    throw new Error("Active plan returned an invalid response", { cause: parsed.issues });
  }

  return parsed.output;
}

function parseSubordinateRoster({ value }: { value: unknown }): SubordinateRosterEntry[] | null {
  const parsed = v.safeParse(v.array(SubordinateRosterEntrySchema), value);

  return parsed.success ? parsed.output : null;
}

function parseSubordinateActivityEvent({ value }: { value: unknown }): SubordinateActivityEvent | null {
  const parsed = v.safeParse(SubordinateActivityEventSchema, value);

  return parsed.success ? parsed.output : null;
}

/** The heading format belongs to `memory/note.ts`; a note is not a search hit, so every note scores 1. */
function memoryRows(content: string): MemoryEntry[] {
  return parseMemoryNotes(content).map((note) => ({ ...note, matchScore: 1 }));
}
