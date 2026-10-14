/** One chat's connection and conversation: its socket, its transcript and sends, and the opening it reads. */
import { useState, useCallback, useEffect, useRef, useMemo, type RefObject } from "react";
import { useAgent } from "agents/react";
import { Effect } from "effect";
import {
  ORCHESTRATOR_AGENT_SLUG, PAGE_KEEPALIVE, hostedActorSocketPath, type ActorSnapshot, type InlineSteer, type PlanReview,
  type ReasoningEffort,
} from "@kinu.run/core";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { FileUIPart, UIMessage } from "ai";
import * as v from "valibot";
import type { SendLanding, SendState } from "@kinu.run/core";
import { workspaceRpc } from "@/lib/workspace-rpc";
import type { OrchestratorAgent } from "@/orchestrator";
import { sendLanding } from "@kinu.run/core";
import { detach, diagnostics, renderThrownChain, toKinuError } from "@kinu.run/core/obs";
import {
  createSessionRecovery, fetchDeployedBuildSha, isNewerDeployedBuild, pageDeployedBuildSha, reportChatStreamFailure,
  routeTemplateOf, type SessionRecovery,
} from "@kinu.run/core";
import { abandonTurn, abandonTurnIfOwner, admitTurn, newSendLatch } from "@kinu.run/core";
import { terminalChatError, turnFailure, type ChatTurnError } from "@kinu.run/core";
import { turnLiveness, TURN_CLAIM_FRAME, type TurnClaimState } from "@kinu.run/core";
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

/** The snapshot and the lists the first screen draws, in the one read a workspace tab opens with: as the server answers it. */
export type WorkspaceOpening = Awaited<ReturnType<OrchestratorAgent["getWorkspaceOpening"]>>;

/** Doubling from 1s, capped so a long outage keeps a slow heartbeat instead of hammering the DO. */
const RETRY_BASE_MS = 1_000;

const RETRY_MAX_MS = 30_000;

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

  return { rpc: useMemo(() => workspaceRpc(agent.call), [agent]), connectionStatus };
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

/** A turn's wait on its provider as the composer counts it down: `untilMs` is this browser's clock, and `retry` which
 *  of the call's `retries` comes after it. */
export interface ProviderWaitShown {
  readonly provider: string;
  readonly untilMs: number;
  readonly retry?: number;
  readonly retries?: number;
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
  /**
   * Whether the server has answered the resume probe the SDK sends as this socket opens. Until it has, the chat is not
   * settled: `useChat` keeps one status for a resume and a send, so a send before the answer has its turn's state ended
   * by it (the Stop of a new chat's opening turn lasted 10 ms, 2026-10-14), and a stream the drop interrupted is still
   * the SDK's to rejoin. `answered` settles with it, for the send that waits on it.
   */
  const [probeAnswered, setProbeAnswered] = useState(false);
  const answered = useRef(Promise.withResolvers<void>());
  /** Its agent as the pane draws it: set by each completed load, cleared only by a switch to another chat, so it means
   *  "this chat has last known data". */
  const [actorSnapshot, setActorSnapshot] = useState<ActorSnapshot | null>(null);
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

  const error = formatWorkspaceError(errors, actorSnapshot !== null);
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

  /** This chat's turn waiting on its provider, told only to the turn's own windows. Cleared by the next stream frame or
   *  socket close; the notice itself ends at `untilMs`, the wait's end on this browser's clock. */
  const [providerWait, setProviderWait] = useState<ProviderWaitShown | null>(null);
  const [activePlan, setActivePlan] = useState<PlanReview | null>(null);
  // What this chat showed when it was last open in this page, drawn until its connect frame lands.
  const [lastShown] = useState(() => revisited.get(actorKey));
  // Set by the connect frame, or by a revisited chat's last transcript, which is never empty; the only things that
  // entitle the pane to draw a conversation. False is "not yet", never "nothing".
  const [transcriptSeeded, setTranscriptSeeded] = useState(lastShown !== undefined);

  const clearProviderWait = useCallback(() => setProviderWait(null), []);

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
      setProbeAnswered(false);

      // The next socket asks anew: a send still waiting on this one's answer waits on that one's.
      const next = Promise.withResolvers<void>();

      answered.current.resolve(next.promise);
      answered.current = next;
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
    if (data.type === "cf_agent_stream_resuming" || data.type === "cf_agent_stream_resume_none") {
      setProbeAnswered(true);
      answered.current.resolve();
    } else if (data.type === "provider_wait") {
      // Each wait in a chain replaces the one before.
      setProviderWait({
        provider: data.provider, untilMs: Date.now() + data.waitMs,
        ...(data.retry !== undefined && data.retries !== undefined && { retry: data.retry, retries: data.retries }),
      });
    } else if (data.type === "cf_agent_use_chat_response") {
      // A stream frame ends the wait; the on-connect replay must not paint "waiting" either.
      clearProviderWait();
      const failed = terminalChatError(data);

      if (failed !== null) setFrameError(failed);
    }
  }, [clearProviderWait]);

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

  /** Every send that starts a turn, the opening's, the composers' and Retry's, begins once the socket's probe is
   *  answered: no caller can send into the probe's answer, and none checks for itself. A Stop pressed meanwhile
   *  frees the latch, and the send never goes. */
  const startTurn = useCallback(
    (begin: () => Promise<void>): boolean => admitTurn(sendLatch.current, async () => {
      const owner = sendLatch.current.owner;

      setModelFallbacks([]);
      await answered.current.promise;

      if (sendLatch.current.owner !== owner) return;

      await begin();
    }),
    [],
  );

  // Read live, never latched. A stream whose socket closes mid-answer ends in an error (agents 0.26,
  // `interruptChatStream`) that the reconnect's resume replaces, clearing useChat's error as it starts: until the
  // reopened socket's probe is answered the turn is the SDK's to rejoin, not a failed one. On the reconnect row the
  // error stood between the open and the resume as a Retry notice (2026-10-14).
  const standingStreamError = connectionStatus === "connected" && probeAnswered ? streamError : undefined;

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
          release: pageDeployedBuildSha(),
          route: routeTemplateOf(location.pathname),
        });
      } catch (cause) {
        diagnostics.event("client_error.reporter_failed", { reason: renderThrownChain({ cause }) });
      }
    }));
  }, [standingStreamError, subordinate]);

  // Version skew: /api/health's build sha against the page's own (`pageDeployedBuildSha`), on each reconnect.
  const [newerDeployedBuild, setNewerDeployedBuild] = useState(false);

  const refreshDeployedBuild = useCallback(async () => {
    if (isNewerDeployedBuild(pageDeployedBuildSha(), await fetchDeployedBuildSha())) setNewerDeployedBuild(true);
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
  const rpc = useMemo(() => workspaceRpc(async <T,>(method: string, args?: unknown[]): Promise<T> => {
    try {
      const value = await agent.call<T>(method, args);

      sessionRecovery.rpcSucceeded();

      return value;
    } catch (cause) {
      sessionRecovery.rpcFailed({ cause }, agent.readyState === WebSocket.OPEN);
      throw cause;
    }
  }), [agent, sessionRecovery, loadGeneration]);

  // Answered by the socket's auto-response, never the object: an idle page wakes nothing (2026-09-26, 180 RPCs a
  // minute to none). A silently dead socket shows in the next calls' timeouts, the workspace's and an agent's alike.
  useEffect(() => {
    if (connectionStatus !== "connected") return;

    const id = setInterval(() => {
      if (agent.readyState === WebSocket.OPEN) agent.send(PAGE_KEEPALIVE.ping);
    }, 25_000);

    return () => clearInterval(id);
  }, [agent, connectionStatus]);

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
          loadChat,
          setSourceError,
          (requestKey) => liveRefreshAdmission.admit(actorKey, requestKey),
          // A hosted chat's load seeds only its plan; the workspace's seeds every read its opening carries.
          isSubordinate ? ["plan"] : SNAPSHOT_SEEDED_SOURCES,
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

  /**
   * This chat's agent, the workspace's or a hosted one's, read the same way. The workspace's comes in its opening, one
   * round trip: a second awaited RPC for the active plan made a plan-gated composer paint in build mode and jump, and
   * the lists the first screen draws came back a wave later. The exploration canvas is not seeded here; its surface
   * fetches its own.
   */
  async function loadChat(
    isCurrent: () => boolean,
    isSourceCurrent: (source: LiveRefreshSource) => boolean,
  ): Promise<void> {
    const opening = isSubordinate ? null : await rpc("getWorkspaceOpening", []);
    // The root resolves the name through its directory, so a tab cannot ask about a non-child actor.
    const chat = opening?.chat ?? await rpc("getActorSnapshot", [subordinate]);

    if (!isCurrent()) return;
    // Decoded before anything is published: a chat whose plan does not decode fails whole, never half-loaded nor read
    // as "no plan".
    const loadedPlan = parseActivePlanReview({ value: chat.activePlan });

    // Set before anything is admitted: stamped frames are a hosted chat's only while the id matches, and a page request
    // without it reads the workspace's rows.
    if (isSubordinate) {
      ownActorIdRef.current = chat.actorId;
      setPaneActorId(chat.actorId);
    }

    setActorSnapshot(chat);

    if (isSourceCurrent("plan")) {
      if (loadedPlan) knownPlans.current.add(`${loadedPlan.id}:${loadedPlan.revision}`);
      setActivePlan(loadedPlan);
    }

    // Replace, never merge: durable rows are the authority, so a reconnecting tab learns missed
    // transitions and drops settled chips. A racing broadcast upserts by id afterwards.
    setSteerRuns([...chat.pendingSteers]);

    if (opening === null) return;
    setTurnClaim(opening.turnClaim);
    await extension?.current?.snapshot(opening, isSourceCurrent);
  }

  useEffect(() => {
    setLoadGeneration(0);
    failureStreak.current = 0;
    // The abandoned turn's stale owner token can no longer release the latch, so a late
    // completion cannot open it for the next holder.
    abandonTurn(sendLatch.current);
    setErrors({});
    setActorSnapshot(null);
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

    return { landed: "mid-turn", settled: sendLanding(record, rpc("send", [content, id, attachments, mode]), id) };
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

  /** Every per-chat call names a hosted chat's agent last; the workspace's names none. */
  const actorArgs = useMemo((): [] | [string] => (subordinate === undefined ? [] : [subordinate]), [subordinate]);

  /** Resolves null on success or the failure reason, which is also recorded on `error` after the
   *  picker is rolled back. Callers reporting "Saved" must check the result; it never rejects. */
  const setModel = useCallback(async (modelId: string): Promise<string | null> => {
    const showing = (model: string) => setActorSnapshot((prev) => prev ? { ...prev, model: { ...prev.model, model } } : prev);

    showing(modelId);

    try {
      // The server may have normalized the spec.
      const { spec } = await rpc("setModel", [modelId, ...actorArgs]);

      if (spec) showing(spec);
      setSourceError("model", null);

      return null;
    } catch (err) {
      // Roll back to the model the chat runs, so the picker never shows an unsaved one.
      let reason = `Could not switch model: ${readFailureText({ cause: err })}`;

      try {
        showing((await rpc("getActorSnapshot", actorArgs)).model.model);
      } catch (rollbackErr) {
        reason += `. Could not re-read the saved model either (${readFailureText({ cause: rollbackErr })}), so the picker may not show the saved model`;
      }

      setSourceError("model", reason);

      return reason;
    }
  }, [rpc, setSourceError, actorArgs]);

  /** Null clears to the tier's. Optimistic, rolled back on refusal. */
  const setReasoningEffort = useCallback(async (effort: ReasoningEffort | null): Promise<void> => {
    const before = actorSnapshot?.reasoningEffort ?? null;

    setActorSnapshot((prev) => prev ? { ...prev, reasoningEffort: effort } : prev);

    try {
      await rpc("setReasoningEffort", [effort, ...actorArgs]);
      setSourceError("model", null);
    } catch (err) {
      setActorSnapshot((prev) => prev ? { ...prev, reasoningEffort: before } : prev);
      setSourceError("model", `Could not set the thinking level: ${readFailureText({ cause: err })}`);
    }
  }, [rpc, setSourceError, actorArgs, actorSnapshot?.reasoningEffort]);

  const rereadPlan = useCallback(() => refreshCurrentLiveResource(
    "plan",
    () => rpc("getActivePlanReview", []),
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
      actorSnapshot,
      activePlan,
      planFocus,
      sendChat,
      abortChat,
      /** Answered, and refused while a turn runs; the clear frame the server sends ahead of the answer empties every window. */
      clearConversation: () => rpc("clearConversation", []),
      setModel,
      setReasoningEffort,
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
      loaded: actorSnapshot !== null, streaming: isStreaming, rereadPlan,
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
