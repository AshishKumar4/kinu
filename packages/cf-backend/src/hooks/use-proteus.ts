/**
 * Proteus agent hooks — useAgent() + useAgentChat() from Agents SDK.
 */

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useAgent } from "agents/react";
import { ORCHESTRATOR_AGENT_SLUG, SUBORDINATE_AGENT_SLUG } from "@proteus/core";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { FileUIPart, UIMessage } from "ai";
import type {
  ToolInfo,
  MemoryEntry,
  MCTSNode,
  TimelineSpan,
  BackgroundJob,
  PendingConsent,
  Rpc,
  SubordinateActivityEvent,
  SubordinateRosterEntry,
} from "../lib/protocol";
import type { ExecutorInfo } from "../lib/executors";
import { applySignalCard, parseSignalCardEvent, type SignalCard } from "../components/background-event";
import { touchWorkspace } from "../lib/user-api";

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
  id: string;
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
  mcts: MctsRow[];
  timeline: TimelineSpan[];
  executors: ExecutorInfo[];
  executorOutputs: Array<{ name: string; outputs: ExecutorOutput[] }>;
  lastActiveExecutor: string | null;
}

/** Where a surfaced failure came from — each source owns (and clears) its own
 *  message so a recovery in one never hides a still-broken other. */
type ErrorSource = "snapshot" | "roster" | "model" | "memory";

/** Initial-load retry backoff. Doubling from 1s, capped so a long outage keeps
 *  a slow heartbeat instead of hammering the DO. */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** Memory search fires from an onChange handler, so it settles on the typed
 *  query rather than issuing an RPC per keystroke. */
const MEMORY_SEARCH_DEBOUNCE_MS = 200;

interface CallableAgent {
  call(method: string, args: unknown[]): Promise<unknown>;
}

function bindRpc(agent: CallableAgent): Rpc {
  return <T = unknown>(method: string, args: unknown[] = []) => agent.call(method, args) as Promise<T>;
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
 * Fetches all surface data via @callable RPCs on connect. The unified Run
 * Timeline (getRunTimeline) is the single activity feed — it subsumes the
 * former evolution-events + activity-log streams, so the hook no longer
 * maintains those separately.
 */
export function useProteus(target?: string | ProteusActorAddress) {
  const workspace = typeof target === "string" ? target : target?.workspace;
  const subordinate = typeof target === "string" ? undefined : target?.subordinate;
  const actorAddress = useMemo<ProteusActorAddress>(() => ({
    workspace: workspace || "default",
    ...(subordinate ? { subordinate } : {}),
  }), [workspace, subordinate]);
  const isSubordinate = subordinate !== undefined;
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [memory, setMemory] = useState<MemoryEntry[]>([]);
  const [mctsTree, setMctsTree] = useState<MCTSNode | null>(null);
  // The unified Run Timeline spine — one server-merged, ordered span stream
  // (getRunTimeline). Single source; no client-side merge of three RPCs.
  const [runTimeline, setRunTimeline] = useState<TimelineSpan[]>([]);
  const [memoryContent, setMemoryContent] = useState<string>("");
  // Failures keyed by source, so one source recovering never erases another's
  // error, and none of them expire on a timer: an unread failure that quietly
  // vanishes leaves the surfaces it broke looking authoritative.
  const [errors, setErrors] = useState<Partial<Record<ErrorSource, string>>>({});
  const setSourceError = useCallback((source: ErrorSource, message: string | null) => {
    setErrors((prev) => {
      if ((prev[source] ?? null) === message) return prev;
      const next = { ...prev };
      if (message) next[source] = message; else delete next[source];
      return next;
    });
  }, []);
  const error = errors.snapshot ?? errors.roster ?? errors.model ?? errors.memory ?? null;
  const [executors, setExecutors] = useState<ExecutorInfo[]>([]);
  const [executorOutputs, setExecutorOutputs] = useState<Map<string, ExecutorOutput[]>>(new Map());
  const [lastActiveExecutor, setLastActiveExecutor] = useState<string | null>(null);
  // Pinned (exposed) ports for sandbox previews. Refreshed with the live-data
  // poll on every surface so auto-switch-to-preview, the Output badge and the
  // Environment preview auto-focus stay live wherever the user is. Listing
  // ports never provisions a sandbox: getExposedPorts returns [] server-side
  // unless the executor is already active.
  const [pinnedPorts, setPinnedPorts] = useState<Array<{ port: number; url: string; name?: string }>>([]);
  // Background tasks (auto-detached >30s tool calls) — single source for the
  // Tasks surface + the Tasks-tab running badge (visible on any surface).
  const [backgroundJobs, setBackgroundJobs] = useState<BackgroundJob[]>([]);
  // Pending device-consent requests — an agent wants to use a connected device;
  // the chat renders a card and the user decides (ask-once-then-remember).
  const [pendingConsents, setPendingConsents] = useState<PendingConsent[]>([]);
  // Evolution Changelog unseen count — badges the Brain tab from any surface;
  // viewing the digest (BrainSurface) marks seen server-side and zeroes it.
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

  const agent = useAgent({
    agent: ORCHESTRATOR_AGENT_SLUG,
    name: actorAddress.workspace,
    ...(subordinate ? {
      sub: [{ agent: SUBORDINATE_AGENT_SLUG, name: subordinate }],
    } : {}),
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
      try {
        const data = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        if (data?.type === "workspace_renamed") {
          if (typeof data.displayName === "string" && data.displayName.trim()) {
            setAgentStatus((prev) => prev ? { ...prev, displayName: data.displayName } : prev);
          }
          window.dispatchEvent(new CustomEvent("proteus:workspace-renamed"));
        } else if (data?.type === "cf_agent_use_chat_response" && data.error === true && data.done === true) {
          // Terminal-error frame. During a live stream the transport also
          // surfaces it as useChat's `error`; on connect the server REPLAYS
          // the last terminal error with a stale request id the transport
          // drops — this handler is the only place that frame is seen.
          setChatError(typeof data.body === "string" && data.body.trim() ? data.body : "The turn failed with an unknown error.");
        }
      } catch { /* not our JSON */ }
    }, []),
  });

  const {
    messages,
    sendMessage,
    clearHistory,
    stop,
    isStreaming,
    error: streamError,
  } = useAgentChat({
    agent,
    // Throttle UI updates during high-frequency token deltas (50ms ≈ 20fps).
    // The chat library forwards this option to @ai-sdk's useChat.
    experimental_throttle: 50,
  } as Parameters<typeof useAgentChat>[0] & { experimental_throttle: number });

  // The live-stream error channel: the ws transport turns an in-band
  // `error:true` frame into useChat's `error` state — fold it into the same
  // exposed chat-error surface as the on-connect replay.
  useEffect(() => {
    if (streamError) setChatError(streamError.message || String(streamError));
  }, [streamError]);

  // ── A2: resume the durable stream on EVERY reconnect, not just first mount.
  // The framework's resume effect fires once; partysocket reconnects don't
  // retrigger it. We listen for the agent's "open" event and call
  // resumeStream() — server replays buffered chunks from
  // cf_ai_chat_stream_chunks. (STABILITY-AUDIT §A2.)
  const isFirstOpen = useRef(true);
  useEffect(() => {
    if (!agent) return;
    const onOpen = () => {
      // Skip the very first open — useChat's mount-time resume handles it.
      if (isFirstOpen.current) { isFirstOpen.current = false; return; }
      const chat = (agent as unknown as { _chat?: { resumeStream?: () => unknown } });
      // Resume API surface lives on the useChat-bound chat object exposed
      // by the framework. If it's not present (older Think), this is a no-op.
      const tryResume = (obj: unknown) => {
        if (!obj || typeof obj !== "object") return false;
        const r = (obj as { resumeStream?: () => unknown }).resumeStream;
        if (typeof r === "function") { try { r.call(obj); return true; } catch { /* ignore */ } }
        return false;
      };
      if (tryResume(chat._chat)) return;
      // Fallback: try sending a manual resume request directly. Server
      // recognizes type:"cf_agent_stream_resume_request".
      try {
        (agent as unknown as { send: (m: string) => void }).send(
          JSON.stringify({ type: "cf_agent_stream_resume_request" }),
        );
      } catch { /* ignore */ }
    };
    agent.addEventListener("open", onOpen as EventListener);
    return () => agent.removeEventListener("open", onOpen as EventListener);
  }, [agent]);

  // ── A4: 25s heartbeat keeps the WS warm so Cloudflare's edge doesn't
  // reap idle connections at ~100s. Server no-ops unknown message types.
  // (STABILITY-AUDIT §A4.)
  useEffect(() => {
    if (connectionStatus !== "connected") return;
    const id = setInterval(() => {
      try {
        (agent as unknown as { send: (m: string) => void }).send(
          JSON.stringify({ type: "ping" }),
        );
      } catch { /* not yet open */ }
    }, 25_000);
    return () => clearInterval(id);
  }, [agent, connectionStatus]);

  const isConnected = connectionStatus === "connected";

  // Rebuild the MCTS tree only when the rows actually changed — the polls
  // return identical data most ticks, and a fresh tree object identity makes
  // the d3 visualization re-render (and drop tooltips) for nothing.
  const mctsFingerprint = useRef("");
  const setMctsTreeFromRows = useCallback((rows: MctsRow[]) => {
    if (rows.length === 0) return;
    const fp = rows.map((r) => `${r.id}:${r.visits}:${r.value}:${r.status}`).join("|");
    if (fp === mctsFingerprint.current) return;
    mctsFingerprint.current = fp;
    setMctsTree(buildTree(rows));
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
    (isSubordinate ? loadSubordinateData() : loadAllData())
      .then(() => {
        if (cancelled) return;
        failureStreak.current = 0;
        setSourceError("snapshot", null);
      })
      .catch((err) => {
        if (cancelled) return;
        setSourceError("snapshot", `${label} snapshot failed: ${errorMessage(err)}`);
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** failureStreak.current);
        failureStreak.current += 1;
        timer = setTimeout(() => setLoadAttempt((a) => a + 1), delay);
      });
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [isConnected, isSubordinate, loadAttempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const retryLoad = useCallback(() => {
    failureStreak.current = 0;
    setSourceError("model", null);
    setLoadAttempt((a) => a + 1);
  }, [setSourceError]);

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
  }, [isStreaming, agent, isSubordinate]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshTimeline = useCallback(() => {
    rpc<TimelineSpan[]>("getRunTimeline", [{ limit: 250 }]).then(setRunTimeline).catch(() => {});
  }, [rpc]);

  // Full surface refresh on a steady 5s cadence. The chat stream already
  // carries the conversation, so streaming only adds a faster (1s) poll of
  // the run timeline for near-real-time spans — not all seven RPCs.
  useEffect(() => {
    if (!isConnected || isSubordinate) return;
    const interval = setInterval(refreshLiveData, 5000);
    return () => clearInterval(interval);
  }, [isConnected, isSubordinate]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isConnected || !isStreaming || isSubordinate) return;
    const interval = setInterval(refreshTimeline, 1000);
    return () => clearInterval(interval);
  }, [isConnected, isStreaming, isSubordinate, refreshTimeline]);

  const refreshBackgroundJobs = useCallback(() => {
    rpc<BackgroundJob[]>("listBackgroundJobs", [50]).then(setBackgroundJobs).catch(() => {});
  }, [rpc]);

  const abortChat = useCallback(() => {
    stop();
    rpc("cancelCurrentWork", [])
      .then(() => { if (!isSubordinate) refreshBackgroundJobs(); })
      .catch(() => { if (!isSubordinate) refreshBackgroundJobs(); });
  }, [stop, rpc, refreshBackgroundJobs, isSubordinate]);

  // Listen for MCTS progress broadcasts from the server. We attach to the
  // outer `agent` EventTarget — NOT the inner `_ws` private field — so the
  // listener survives partysocket auto-reconnects without a close→open gap
  // dropping events. (STABILITY-AUDIT §A3.)
  useEffect(() => {
    if (!agent) return;
    const handler = (event: Event) => {
      const data = (event as MessageEvent).data;
      try {
        const msg = JSON.parse(typeof data === "string" ? data : "");
        if (msg.type === "mcts-progress") {
          if (msg.nodes && msg.nodes.length > 0) {
            setMctsTreeFromRows(msg.nodes);
          }
          // Pull the freshest timeline so the new MCTS spans land promptly.
          refreshTimeline();
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
        } else if (msg.type === "work_cancelled") {
          refreshBackgroundJobs();
        } else if (msg.type === "branch_status" && typeof msg.branchId === "string") {
          setBranchRuns((prev) => [
            ...prev.filter((b) => b.branchId !== msg.branchId),
            {
              branchId: msg.branchId,
              task: typeof msg.task === "string" ? msg.task : "",
              status: msg.status === "settled" ? "settled" : msg.status === "error" ? "error" : "running",
              takeSetId: typeof msg.takeSetId === "string" ? msg.takeSetId : undefined,
              turnId: typeof msg.turnId === "string" ? msg.turnId : undefined,
              message: typeof msg.message === "string" ? msg.message : undefined,
            },
          ]);
        } else if (msg.type === "signal_card") {
          const card = parseSignalCardEvent(msg);
          if (card) setSignalCards((current) => applySignalCard(current, card));
        } else if (!isSubordinate && msg.type === "subordinates_changed") {
          const roster = parseSubordinateRoster(msg.subordinates);
          if (roster) setSubordinates(roster);
        } else if (!isSubordinate) {
          const subordinateEvent = parseSubordinateActivityEvent(msg);
          if (subordinateEvent) {
            setSubordinateEvents((current) => current.some((event) => event.id === subordinateEvent.id)
              ? current
              : [...current.slice(-49), subordinateEvent]);
          }
        }
      } catch { /* not JSON or not our message */ }
    };
    agent.addEventListener("message", handler as EventListener);
    return () => agent.removeEventListener("message", handler as EventListener);
  }, [agent, refreshTimeline, refreshBackgroundJobs, setMctsTreeFromRows, isSubordinate]);

  const resolveConsent = useCallback((consentId: string, decision: "once" | "always" | "deny") => {
    setPendingConsents((prev) => prev.filter((c) => c.consentId !== consentId)); // optimistic
    rpc("resolveDeviceConsent", [consentId, decision]).catch(() => {});
  }, [rpc]);

  function refreshExposedPorts() {
    rpc<{ ports?: Array<{ port: number; url?: string; name?: string }> }>("getExposedPorts", ["sandbox"])
      .then((r) => setPinnedPorts((r.ports ?? [])
        .filter(p => typeof p.port === "number" && p.url)
        .map(p => ({ port: p.port, url: p.url!, name: p.name }))))
      .catch(() => { /* ignore transient */ });
  }

  function refreshLiveData() {
    refreshTimeline();
    rpc<MctsRow[]>("getMctsTree", []).then(setMctsTreeFromRows).catch(() => {});
    rpc<string>("getMemoryContent", []).then((c) => setMemoryContent(c ?? "")).catch(() => {});
    // Refresh tools so newly-crafted tools appear without reconnecting.
    rpc<ToolDescResult>("getToolDescriptions", []).then((r) => setTools(mapToolDescriptions(r))).catch(() => {});
    rpc<ExecutorInfo[]>("getExecutors", []).then(setExecutors).catch(() => {});
    refreshBackgroundJobs();
    refreshExposedPorts();
    // Unseen self-changes for the Brain-tab badge.
    rpc<{ unseenCount: number }>("getEvolutionChangelog", [{ limit: 1 }])
      .then((r) => setChangelogUnseen(r.unseenCount)).catch(() => {});
    // Re-hydrate any consent cards still pending after a reload.
    rpc<PendingConsent[]>("listPendingConsents", []).then(setPendingConsents).catch(() => {});
  }

  // Initial load — ONE round-trip (getWorkspaceSnapshot) instead of 6 + N. The
  // server guards each field independently, so a single failing read degrades
  // that surface only. Live updates continue via refreshLiveData + events.
  function loadAllData(): Promise<void> {
    return rpc<WorkspaceSnapshot>("getWorkspaceSnapshot", [])
      .then((snap) => {
        setAgentStatus(snap.status);
        if (workspace) touchWorkspace(workspace).catch(() => {});
        setTools(mapToolDescriptions(snap.tools));
        setMemoryContent(snap.memoryContent);
        if (snap.memoryContent) setMemory(parseMemoryContent(snap.memoryContent));
        setMctsTreeFromRows(snap.mcts);
        setRunTimeline(snap.timeline);
        setExecutors(snap.executors);
        setLastActiveExecutor(snap.lastActiveExecutor);
        const outputs = new Map<string, ExecutorOutput[]>();
        for (const eo of snap.executorOutputs) outputs.set(eo.name, eo.outputs.slice().reverse());
        setExecutorOutputs(outputs);
        refreshExposedPorts();
        rpc<{ unseenCount: number }>("getEvolutionChangelog", [{ limit: 1 }])
          .then((r) => setChangelogUnseen(r.unseenCount)).catch(() => {});
      });
  }

  function loadSubordinateData(): Promise<void> {
    return rpc<{
      name: string;
      displayName: string;
      role: string;
      mission: string;
      model: string | null;
    }>("getSubordinateSnapshot", [])
      .then((snapshot) => {
        setAgentStatus({
          id: snapshot.name,
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
      });
  }

  const refreshSubordinates = useCallback(() => {
    if (isSubordinate) return Promise.resolve();
    return rpc<SubordinateRosterEntry[]>("listSubordinates", [])
      .then((roster) => {
        setSubordinates(roster);
        setSourceError("roster", null);
      })
      .catch((err) => {
        setSourceError("roster", `Subordinate roster failed: ${errorMessage(err)}`);
      });
  }, [isSubordinate, rpc, setSourceError]);

  useEffect(() => {
    if (!isConnected || isSubordinate) return;
    void refreshSubordinates();
  }, [isConnected, isSubordinate, refreshSubordinates, loadAttempt]);

  useEffect(() => {
    setLoadAttempt(0);
    failureStreak.current = 0;
    setErrors({});
    setAgentStatus(null);
    setTools([]);
    setMemory([]);
    setMemoryContent("");
    setMctsTree(null);
    mctsFingerprint.current = "";
    setRunTimeline([]);
    setPinnedPorts([]);
    setChatError(null);
    if (!isSubordinate) {
      setSubordinates([]);
      setSubordinateEvents([]);
    }
  }, [workspace, subordinate]);

  // File attachments ride as data-URL FileUIParts ahead of the text part —
  // the whole downstream pipeline (WS transport, DO persistence, Think's
  // convertToModelMessages) natively carries them to multimodal models.
  const sendChat = useCallback((content: string, files: FileUIPart[] = []) => {
    const parts: UIMessage["parts"] = [
      ...files,
      ...(content ? [{ type: "text" as const, text: content }] : []),
    ];
    if (parts.length === 0) return;
    setChatError(null);
    sendMessage({ role: "user", parts });
  }, [sendMessage]);

  // Retry affordance for the error card: re-send the last user message's
  // parts as a fresh turn (the failed turn persisted nothing to answer it).
  const retryLastMessage = useCallback(() => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    setChatError(null);
    sendMessage({ role: "user", parts: lastUser.parts });
  }, [messages, sendMessage]);

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

  /** Switch this agent's model. Resolves only once the write landed, and
   *  rejects when it didn't — a caller that reports "Saved" on this promise
   *  (Workspace settings) must not do so for a write that failed. */
  const setModel = useCallback(async (modelId: string): Promise<void> => {
    // Optimistically reflect in the UI so the dropdown doesn't snap back
    // while the RPC is in flight.
    setAgentStatus(prev => prev ? { ...prev, model: modelId } : prev);
    try {
      const r = await rpc<{ ok?: boolean; spec?: string }>("setModel", [modelId]);
      // Server may have normalized the spec — sync the UI to authoritative value.
      if (r?.spec) setAgentStatus(prev => prev ? { ...prev, model: r.spec! } : prev);
      setSourceError("model", null);
    } catch (err) {
      // Surface to the user, never swallow — and roll the picker back to the
      // actually-stored spec so it can't keep showing an unsaved model.
      setSourceError("model", `Couldn't switch model: ${errorMessage(err)}`);
      await rpc<{ spec?: string | null }>("getStoredModelSpec", []).then((r) => {
        setAgentStatus(prev => prev ? { ...prev, model: r.spec ?? '' } : prev);
      }).catch(() => {});
      throw err;
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
    return rpc<{ stdout?: string; stderr?: string; exitCode?: number; error?: string }>("executeInExecutor", [executorId, command]);
  }, [rpc]);

  // Listen for executor-output broadcasts — emitted by the orchestrator on
  // every exec completion (user- or agent-triggered). Attach to the outer
  // `agent` EventTarget so the listener survives reconnects (STABILITY-AUDIT
  // §A3, D5).
  useEffect(() => {
    if (!agent) return;
    const handler = (event: Event) => {
      const data = (event as MessageEvent).data;
      try {
        const msg = JSON.parse(typeof data === "string" ? data : "");
        if (msg.type === "executor-output") {
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
      } catch { /* ignore non-JSON */ }
    };
    agent.addEventListener("message", handler as EventListener);
    return () => agent.removeEventListener("message", handler as EventListener);
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
    mctsTree,
    runTimeline,
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
    /** Exposed ports across all sandbox-capable executors (currently just sandbox). */
    pinnedPorts,
    /** Background tasks + a live running count for the Tasks-tab badge. */
    backgroundJobs,
    runningTaskCount: backgroundJobs.filter((j) => j.status === "running").length,
    refreshBackgroundJobs,
    /** Pending device-consent requests + the resolver (chat consent cards). */
    pendingConsents,
    resolveConsent,
    /** Unseen Evolution Changelog entries (Brain-tab badge) + the local clear
     *  (BrainSurface marks seen server-side, then calls this). */
    changelogUnseen,
    clearChangelogUnseen: () => setChangelogUnseen(0),
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
      const result = await rpc<{ name: string; displayName: string }>("spawnSubordinate", [role, mission]);
      await refreshSubordinates();
      return result;
    },
    dismissSubordinate: async (name: string) => {
      const result = await rpc<{ ok: true; name: string; historyKept: boolean }>("dismissSubordinate", [name]);
      await refreshSubordinates();
      return result;
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  try { return JSON.stringify(err); } catch { return "unknown error"; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseSubordinateRoster(value: unknown): SubordinateRosterEntry[] | null {
  if (!Array.isArray(value)) return null;
  const roster: SubordinateRosterEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry)
      || typeof entry.name !== "string"
      || typeof entry.displayName !== "string"
      || typeof entry.role !== "string"
      || (entry.createdBy !== "orchestrator" && entry.createdBy !== "user")
      || (entry.status !== "idle" && entry.status !== "working"
        && entry.status !== "awaiting_input" && entry.status !== "dismissed")
      || (entry.currentTask !== null && typeof entry.currentTask !== "string")
      || typeof entry.createdAt !== "number"
      || (entry.dismissedAt !== null && typeof entry.dismissedAt !== "number")) return null;
    roster.push({
      name: entry.name,
      displayName: entry.displayName,
      role: entry.role,
      createdBy: entry.createdBy,
      status: entry.status,
      currentTask: entry.currentTask,
      createdAt: entry.createdAt,
      dismissedAt: entry.dismissedAt,
    });
  }
  return roster;
}

function parseSubordinateActivityEvent(value: unknown): SubordinateActivityEvent | null {
  if (!isRecord(value)
    || value.type !== "subordinate_event"
    || typeof value.id !== "string"
    || (value.kind !== "task" && value.kind !== "report")
    || typeof value.subordinate !== "string"
    || typeof value.content !== "string"
    || typeof value.timestamp !== "number") return null;
  return {
    type: "subordinate_event",
    id: value.id,
    kind: value.kind,
    subordinate: value.subordinate,
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    content: value.content,
    ...(typeof value.task === "string" ? { task: value.task } : {}),
    timestamp: value.timestamp,
  };
}

export interface MctsRow {
  id: string; parent_id: string | null; depth: number;
  visits: number; value: number; status: string; action: string;
  task?: string; observation?: string; code_used?: string | null;
  branch_agent_key?: string | null; msg_id?: string | null; created_at?: number;
}

interface ToolDescResult {
  builtIn: Array<{ name: string; description: string }>;
  crafted: Array<{ name: string; description: string; qualityScore?: number; usageCount?: number }>;
}

/** Map a getToolDescriptions result into the UI's ToolInfo[] — single source
 *  for the mapping used by both the initial load and live refresh. */
function mapToolDescriptions(r: ToolDescResult): ToolInfo[] {
  return [
    ...r.builtIn.map((t) => ({ name: t.name, description: t.description, scope: "local" as const, qualityScore: 1, usageCount: 0, lastUsed: "" })),
    ...r.crafted.map((t) => ({ name: t.name, description: t.description, scope: "global" as const, qualityScore: t.qualityScore ?? 0.5, usageCount: t.usageCount ?? 0, lastUsed: "" })),
  ];
}

function buildTree(nodes: MctsRow[]): MCTSNode {
  const map = new Map<string, MCTSNode>();
  for (const n of nodes) {
    map.set(n.id, {
      id: n.id, parentId: n.parent_id, depth: n.depth, visits: n.visits,
      value: n.value, status: n.status as MCTSNode["status"], action: n.action,
      task: n.task, observation: n.observation, codeUsed: n.code_used,
      branchAgentKey: n.branch_agent_key, msgId: n.msg_id, createdAt: n.created_at,
      children: [],
    });
  }
  let root: MCTSNode | null = null;
  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId)!.children.push(node);
    } else if (!root || node.depth < root.depth) {
      root = node;
    }
  }
  return root ?? { id: "root", parentId: null, depth: 0, visits: 0, value: 0, status: "open", action: "root", children: [] };
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
