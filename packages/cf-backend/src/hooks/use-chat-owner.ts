/** One chat's connection and conversation: its socket, its transcript and sends, and the opening it reads. */
import { useState, useCallback, useEffect, useRef, useMemo, type RefObject } from "react";
import { useAgent } from "agents/react";
import { Effect } from "effect";
import {
  ORCHESTRATOR_AGENT_SLUG, PAGE_KEEPALIVE, hostedActorSocketPath, type OpeningList, type PendingAction,
  type PlanReview, type ReasoningEffort, type RoleId, type SlateSummary, type TierSource,
} from "@kinu.run/core";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { FileUIPart, UIMessage } from "ai";
import * as v from "valibot";
import type { PendingConsent, Rpc, TabPresence, SendLanding, SendState } from "@kinu.run/core";
import { sendLanding } from "@kinu.run/core";
import type { BackgroundJob } from "@kinu.run/core/protocol";
import type { ExecutorInfo, PanelAgent } from "@kinu.run/core";
import type { InlineSteer } from "@kinu.run/core";
import { detach, diagnostics, renderThrownChain, toKinuError } from "@kinu.run/core/obs";
import {
  createSessionRecovery, fetchDeployedBuildSha, isNewerDeployedBuild, pageDeployedBuildSha, reportChatStreamFailure,
  routeTemplateOf, type SessionRecovery,
} from "@kinu.run/core";
import { abandonTurn, abandonTurnIfOwner, admitTurn, newSendLatch } from "@kinu.run/core";
import { terminalChatError, turnFailure, type ChatTurnError } from "@kinu.run/core";
import { turnLiveness, TURN_CLAIM_FRAME, type TurnClaimState } from "@kinu.run/core";
import type { InspectedWork } from "@kinu.run/core";
import type { AsyncResource } from "./use-async-resource";
import { useSocketFrames, type SocketFrame } from "./socket-frames";
import {
  createLiveRefreshAdmission, formatWorkspaceError, loadWorkspaceSnapshot, readFailureText, refreshLiveResource,
  SNAPSHOT_SEEDED_SOURCES, type ErrorSource, type LiveRefreshAdmission, type LiveRefreshSource,
} from "@kinu.run/core";
import { PlanReviewSchema } from "@kinu.run/core";

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

/** `settled` is where the message ended, read from the workspace's record once its turn has; it rejects when no turn
 *  took it. Null: nothing was sent. */
export type SendAdmission =
  | { readonly landed: "turn" }
  | { readonly landed: "mid-turn"; readonly settled: Promise<SendLanding> }
  | null;

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

interface WorkspaceSnapshot {
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

/** The snapshot and the lists the first screen draws, in the one read a workspace tab opens with (`getWorkspaceOpening`). */
export interface WorkspaceOpening extends WorkspaceSnapshot {
  pendingActions: PendingAction[];
  backgroundJobs: BackgroundJob[];
  inspectedWork: InspectedWork[];
  subordinates: OpeningList<unknown>;
  pendingConsents: OpeningList<PendingConsent[]>;
  workspaceAgents: OpeningList<PanelAgent[]>;
}

/** Doubling from 1s, capped so a long outage keeps a slow heartbeat instead of hammering the DO. */
const RETRY_BASE_MS = 1_000;

const RETRY_MAX_MS = 30_000;

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

export interface WorkspaceExtension {
  readonly snapshot: (snap: WorkspaceOpening, isSourceCurrent: (source: LiveRefreshSource) => boolean) => Promise<void>;
  readonly frame: (msg: SocketFrame) => Promise<void>;
  readonly refresh: () => void;
  readonly jobs: () => Promise<void>;
}

/**
 * Chats revisited in this page: switching to one paints the transcript it showed last while its socket reconnects
 * (2026-10-09 on production: 113-130 ms desktop, 330-404 ms mobile before a chat's transcript arrived). The socket's
 * own transcript replaces it as it lands. Bounded to the chats a person moves between; each holds only the window its
 * pane already held.
 */
const REVISITED_CHATS = 8;

const revisited = new Map<string, UIMessage[]>();

function keepRevisited(actorKey: string, messages: UIMessage[]): void {
  revisited.delete(actorKey);
  revisited.set(actorKey, messages);

  for (const oldest of revisited.keys()) {
    if (revisited.size <= REVISITED_CHATS) break;
    revisited.delete(oldest);
  }
}

export function useChatOwner(target: string | KinuActorAddress | undefined, extension: RefObject<WorkspaceExtension | null> | null) {
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
  const [planFocus, setPlanFocus] = useState<string | null>(null);
  const knownPlans = useRef(new Set<string>());
  const [modelFallbacks, setModelFallbacks] = useState<string[]>([]);
  /** Seeded by the snapshot each (re)connect loads, then replaced by every `turn_claim` frame. */
  const [turnClaim, setTurnClaim] = useState<TurnClaimState>({ kind: "settled" });

  // Shown from the moment the server takes a steer until its durable user row arrives.
  const [steerRuns, setSteerRuns] = useState<InlineSteer[]>([]);
  // Every frame ending a chat response in failure (`terminalChatError`), the runtime's refusal of this tab among them,
  // whose request id the ws transport may not hold. A stream's own error is read live from useChat (`standingStreamError`).
  const [frameError, setFrameError] = useState<ChatTurnError | null>(null);

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
  // What this chat showed when it was last open in this page, drawn until its connect frame lands.
  const [lastShown] = useState(() => revisited.get(actorKey));
  // Set by the connect frame, or by a revisited chat's last transcript, which is never empty; the only things that
  // entitle the pane to draw a conversation. False is "not yet", never "nothing".
  const [transcriptSeeded, setTranscriptSeeded] = useState(lastShown !== undefined);

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
    } else if (data.type === "provider_wait") {
      showProviderWait(data);
    } else if (data.type === "cf_agent_use_chat_response") {
      // A stream frame ends the wait; the on-connect replay must not paint "waiting" either.
      clearProviderWait();
      const failed = terminalChatError(data);

      if (failed !== null) setFrameError(failed);
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
    clearError: clearStreamError,
    connectionError,
  } = useAgentChat({
    agent,
    // The connect frame seeds the transcript; `transcriptSeeded` holds the skeleton until it, or a revisit's last one.
    getInitialMessages: null,
    ...(lastShown !== undefined && { messages: lastShown }),
    // Matches the SDK default (cloudflare/agents#2058), pinned so an upstream change cannot move it.
    throttle: 50,
  });

  useEffect(() => {
    if (transcriptSeeded && messages.length > 0) keepRevisited(actorKey, messages);
  }, [actorKey, messages, transcriptSeeded]);

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

  // Read live, never latched. A stream whose socket closes mid-answer ends in an error (agents 0.26,
  // `interruptChatStream`) that the reconnect's resume replaces, clearing useChat's error as it starts: while the socket
  // is down the turn is the SDK's to rejoin, not a failed one.
  const standingStreamError = connectionStatus === "connected" ? streamError : undefined;

  const turnError = frameError ?? (standingStreamError === undefined
    ? null
    : { body: standingStreamError.message || String(standingStreamError), refused: false });

  // A failure the newest answer records is drawn on it, where a reload finds it too.
  const chatError = turnError?.refused === false && turnFailure({ metadata: messages.at(-1)?.metadata }) !== null ? null : turnError;

  const clearChatError = useCallback(() => {
    setFrameError(null);
    clearStreamError();
  }, [clearStreamError]);

  useEffect(() => {
    if (!standingStreamError) return;
    const failed = standingStreamError;

    // Reported once per failure; a report that cannot be sent is a diagnostic, never the page's failure.
    detach(Effect.promise(async () => {
      try {
        await reportChatStreamFailure(failed, subordinate === undefined ? "root" : "actor", {
          release: await pageDeployedBuildSha(),
          route: routeTemplateOf(location.pathname),
        });
      } catch (cause) {
        diagnostics.event("client_error.reporter_failed", { reason: renderThrownChain({ cause }) });
      }
    }));
  }, [standingStreamError, subordinate]);

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
        setSourceError("snapshot", readFailureText({ cause }));
      }
    })), 25_000);

    return () => clearInterval(id);
  }, [agent, connectionStatus, isSubordinate, rpc, setSourceError]);

  // Speaks only for itself. Re-running admits a newer load, which retires this one. It starts a microtask after the
  // commit, so a load retired in the commit that made it (a remount, StrictMode's included) issues no read: the opening
  // is a dozen reads, and a retired one paid them all for nothing (2026-10-09, two openings per arrival in the gallery).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    detach(Effect.promise(() => Promise.resolve().then(async () => {
      try {
        if (disposed) return;

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
      }
    })));

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

  const adoptPlan = (plan: PlanReview): void => {
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
      adoptPlan(msg.plan);
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
      const reason = `Recovery failed: ${readFailureText(thrown)}`;
      setSourceError("recover", reason);

      return reason;
    }

    extension?.current?.refresh();

    return null;
  }, [extension, rpc, setSourceError]);

  // One round trip: a second awaited RPC for the active plan makes a plan-gated composer paint in
  // build mode and jump, and the lists the first screen draws came back a wave later. The exploration
  // canvas is not seeded here; its surface fetches its own.
  async function loadAllData(
    isCurrent: () => boolean,
    isSourceCurrent: (source: LiveRefreshSource) => boolean,
  ): Promise<void> {
    const snap = await rpc<WorkspaceOpening>("getWorkspaceOpening", []);

    if (!isCurrent()) return;
    // Decoded before anything is published: an opening whose plan does not decode fails whole, never half-loaded
    // nor read as "no plan".
    const loadedPlan = parseActivePlanReview({ value: snap.activePlan });
    setAgentStatus(snap.status);

    if (isSourceCurrent("plan")) {
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
    setFrameError(null);
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
        setFrameError(null);

        return sendMessage({ role: "user", parts, metadata: { kinuMode: mode } });
      });

      if (admitted) return { landed: "turn" };
    }

    // A Plan-locked message that misses its turn must still run as a Plan turn.
    const attachments = files.map((file) => ({ filename: file.filename ?? "attachment", mediaType: file.mediaType, url: file.url }));

    // Id minted here, so a send whose socket closes before its answer is still asked about by name.
    const id = crypto.randomUUID();

    const record = {
      open: () => agent.readyState === WebSocket.OPEN,
      awaitSend: (sent: string) => agent.call<SendState>("awaitSend", [sent], { timeout: 0 }),
    };

    return { landed: "mid-turn", settled: sendLanding(record, rpc<void>("send", [content, id, attachments, mode]), id) };
  }, [startTurn, sendMessage, isStreaming, rpc, agent]);

  /** `regenerate`, not `sendMessage`, which appended a duplicate user message per press. Under the
   *  same latch as `sendChat`: a retry starts a turn. */
  const retryLastMessage = useCallback((): boolean => {
    if (messages.length === 0) return false;

    return startTurn(() => {
      setFrameError(null);

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
      let reason = `Could not switch model: ${readFailureText({ cause: err })}`;

      try {
        const stored = subordinate === undefined
          ? await rpc<{ spec?: string | null }>("getStoredModelSpec", [])
          : { spec: (await rpc<SubordinateSnapshot>("getActorSnapshot", [subordinate])).model.model };

        setAgentStatus(prev => prev ? { ...prev, model: stored.spec ?? '' } : prev);
      } catch (rollbackErr) {
        reason += `. Could not re-read the saved model either (${readFailureText({ cause: rollbackErr })}), so the picker may not show the saved model`;
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
      setSourceError("model", `Could not set the thinking level: ${readFailureText({ cause: err })}`);
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
      clearChatError,
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

export type ChatLink = ReturnType<typeof useChatOwner>["link"];

/** The opening's plan, or null when it holds none; a plan that does not decode fails the opening. */
function parseActivePlanReview({ value }: { value: unknown }): PlanReview | null {
  const parsed = v.safeParse(v.nullable(PlanReviewSchema), value);

  if (!parsed.success) {
    throw new Error("Active plan returned an invalid response", { cause: parsed.issues });
  }

  return parsed.output;
}
