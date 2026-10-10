/** The reads only the workspace's pane draws, over the chat's socket, and the frames that move them. */
import { useState, useCallback, useEffect, useRef, useMemo, type SetStateAction } from "react";
import { Effect } from "effect";
import {
  activateMctsProgressActor, applyMctsProgress, createMctsProgressState, SubordinateActivityEventSchema,
  type MctsProgress, branchHeadId, CHANGES_MOVED_EVENT, followJobOutput, JOB_OUTPUT_EVENT, LIVE_READS,
  READS_CHANGED_EVENT, SLATES_CHANGED_EVENT, WORK_TAB_JOBS, type JobOutputTail, listedOn, type LiveRead,
  type PendingAction, type SlateProblem, type SlateSummary,
} from "@kinu.run/core";
import * as v from "valibot";
import { explorationForkTree } from "@kinu.run/core";
import type {
  MemoryEntry, ForkNode, ExecutorCommandResult, PendingConsent, AskingAgent, SubordinateActivityEvent, TabPresence,
} from "@kinu.run/core";
import type { BackgroundJob, SubordinateRosterEntry } from "@kinu.run/core/protocol";
import type { ExecutorInfo, PanelAgent } from "@kinu.run/core";
import { applySignalCard, parseSignalCardEvent, type SignalCard } from "@kinu.run/core";
import { appendHeadDelta, retireHeadDelta, type HeadDelta, type HeadDeltas } from "@kinu.run/core";
import { parseMemoryNotes } from "@kinu.run/core";
import { detach, diagnostics, toKinuError } from "@kinu.run/core/obs";
import {
  reconcilePreviewPorts, type ExecutorPortRefresh, type ExposedPortList, type PinnedPreviewPort,
} from "@kinu.run/core";
import { jobPhase, type InspectedWork } from "@kinu.run/core";
import type { SocketFrame } from "./socket-frames";
import {
  formatWorkspaceError, naturalList, readFailureText, refreshLiveResource, type ConsentResolutionReporter,
  type LiveRefreshSource,
} from "@kinu.run/core";
import { pruneSlateReloads } from "@kinu.run/core";
import type { WorkspacePlanReference } from "@kinu.run/core";
import type { ChatLink, ExecutorOutput, WorkspaceExtension, WorkspaceOpening } from "./use-chat-owner";

export interface BranchRun {
  branchId: string;
  task: string;
  status: "running" | "settled" | "error";
  takeSetId?: string;
  turnId?: string;
  message?: string;
}

export type ReadMoves = Readonly<Partial<Record<LiveRead, number>>>;

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

export interface UnavailableDevice { id: string; label: string; lastSeenAt: number | null }

type ConsentDecision = "once" | "always" | "deny";

interface PendingConsentResolution {
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

const MEMORY_SEARCH_DEBOUNCE_MS = 200;

/** The reference stays exposed while the connection holds it so the pane re-reads it every cycle.
 *  `claim` says yes exactly once per connection, not per pane: panes remount on conversation
 *  switches, and a replayed hint would pull the reader off the conversation they just opened. */
export interface WorkspacePlanArrival {
  readonly reference: WorkspacePlanReference;
  claim(reference: WorkspacePlanReference): boolean;
}

/** The reads only the workspace's pane draws. */
export function useWorkspaceReads(link: ChatLink) {
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
    : { ...errors, consentResolution: naturalList(consentResolutionReasons) };

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

    if (told === undefined || jobPhase(job, Date.now()) === "settled" || (job.output?.seq ?? 0) >= told.seq) return job;

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
  const [ownerQuestions, setOwnerQuestions] = useState<AskingAgent[]>([]);
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
    () => rpc<BackgroundJob[]>("listBackgroundJobs", [WORK_TAB_JOBS]),
    setBackgroundJobs,
  ), [refreshCurrentLiveResource, rpc]);

  const [inspectedWork, setInspectedWork] = useState<InspectedWork[]>([]);

  const refreshInspectedWork = useCallback(() => refreshCurrentLiveResource(
    "work",
    () => rpc<InspectedWork[]>("inspectWork", []),
    setInspectedWork,
  ), [refreshCurrentLiveResource, rpc]);

  const refreshPendingConsents = useCallback(() => refreshCurrentLiveResource(
    "consents", () => rpc<PendingConsent[]>("listPendingConsents", []), setPendingConsents,
  ), [refreshCurrentLiveResource, rpc]);

  const refreshPendingActions = useCallback(() => refreshCurrentLiveResource(
    "pendingActions",
    () => rpc<PendingAction[]>("listPendingActions", []),
    setPendingActions,
  ), [refreshCurrentLiveResource, rpc]);

  const refreshOwnerQuestions = useCallback(() => refreshCurrentLiveResource(
    "questions", () => rpc<AskingAgent[]>("listOwnerQuestions", []), setOwnerQuestions,
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
      const running = new Set(listedJobs.current.filter((job) => jobPhase(job, Date.now()) !== "settled").map((job) => job.id));

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
      const { status } = msg;

      // The head id derives from the run id, so retire without waiting for a journal write a
      // failed branch never makes.
      if (status !== "running") retireDelta(branchHeadId(msg.branchId));
      setBranchRuns((prev) => [
        ...prev.filter((b) => b.branchId !== msg.branchId),
        {
          branchId: msg.branchId,
          task: msg.task,
          status,
          takeSetId: msg.status === "settled" ? msg.takeSetId : undefined,
          turnId: msg.status === "settled" ? msg.turnId : undefined,
          message: msg.status === "error" ? msg.message : undefined,
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

      if (card) setSignalCards((current) => applySignalCard(current, card, Date.now()));
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
          result: { ports: [], error: readFailureText({ cause }) },
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
    inspectWork: refreshInspectedWork,
    listPendingActions: refreshPendingActions,
    listOwnerQuestions: refreshOwnerQuestions,
    getWorkspaceTabPresence: refreshTabPresence,
    listSlates: refreshSlates,
    getActivePlanReview: rereadPlan,
  }), [
    refreshBackgroundJobs, refreshCurrentLiveResource, refreshExposedPorts, refreshInspectedWork, refreshOwnerQuestions, refreshPendingActions, refreshRoster,
    refreshSlates, refreshTabPresence, rereadPlan, rpc,
  ]);

  const rereadLive = useCallback((reads: readonly LiveRead[], also: readonly (() => Promise<void>)[] = []): void => {
    detach(Effect.promise(async () => {
      try {
        await Promise.all([...reads.map((read) => liveReads[read]?.()), ...also.map((read) => read())]);
      } catch (cause) {
        diagnostics.failure('workspace.live_refresh_failed', toKinuError({
          doing: 'refreshing live workspace data',
          cause,
          otherwise: 'io',
        }));
      }
    }));
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

  async function applySnapshot(snap: WorkspaceOpening, isSourceCurrent: (source: LiveRefreshSource) => boolean): Promise<void> {
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

    if (isSourceCurrent("pendingActions")) setPendingActions(snap.pendingActions);

    if (isSourceCurrent("jobs")) setBackgroundJobs(snap.backgroundJobs);

    if (isSourceCurrent("work")) setInspectedWork(snap.inspectedWork);

    // Each fails on its own surface, as its own read did; each port list is its executor's answer, not the workspace's.
    try {
      await Promise.all([
        refreshExposedPorts(), refreshOwnerQuestions(),
        refreshCurrentLiveResource("roster", async () => v.parse(v.array(SubordinateRosterEntrySchema), await listedOn(snap.subordinates)), setSubordinates),
        refreshCurrentLiveResource("consents", () => listedOn(snap.pendingConsents), setPendingConsents),
        refreshCurrentLiveResource("agents", () => listedOn(snap.workspaceAgents), setWorkspaceAgents),
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
    setInspectedWork([]);
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
        setSourceError("memory", `Memory search failed: ${readFailureText(thrown)}`);
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
      inspectedWork,
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
      ownerQuestions,
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
      /** The server answers a blank displayName; the UI shows "New agent" until the titler lands. `opening` names it. */
      createSubordinate: async (opening?: string) => {
        const result = await rpc<{
          name: string;
          displayName: string;
          subordinate: SubordinateRosterEntry;
        }>("createSubordinateAgent", opening === undefined ? [] : [opening]);

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
