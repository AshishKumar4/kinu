/** Workspace navigation: titled live previews first, then work/read surfaces. */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GlobeIcon, NotePencilIcon, SparkleIcon } from "@phosphor-icons/react";
import type { SlateSummary, PendingAction, PlanReview, OwnedPlan } from "@kinu.run/core";
import type { WorkspacePlanArrival } from "@/hooks/use-kinu";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { FilesFocus, HeadDeltas } from "@kinu.run/core";
import type { AgentStatus, ExecutorOutput, ReadMoves } from "@/hooks/use-kinu";
import type { AsyncResource } from "@/hooks/use-async-resource";
import { executorLabel, type ExecutorInfo, type InspectedWork } from "@kinu.run/core";
import { Loader } from "@cloudflare/kumo";
import type { MemoryEntry, ForkNode, ExecutorCommandResult, Rpc, TabPresence } from "@kinu.run/core";
import type { BackgroundJob } from "@kinu.run/core/protocol";
import { ChangesSurface, type ChangesFocus } from "./ChangesSurface";
import type { PinnedPreviewPort as PinnedPort } from "@kinu.run/core";
import { PreviewFrame } from "@/components/PreviewFrame";
import { LoadFailure } from "@/components/ui/LoadFailure";
import type { AgentSurfaceProps } from "./AgentSurface";
import type { ExplorationSurfaceProps } from "./ExplorationSurface";
import { WorkTab } from "./WorkTab";
import type { EnvironmentSurfaceProps } from "./EnvironmentSurface";
import type { FilesSurfaceProps } from "./FilesSurface";
import type { ActivitySurfaceProps } from "./ActivitySurface";
import { lazyRoute } from "@/lazy-route";
import { SlateFrame } from "@/components/slates/SlateFrame";
import { ShareSlateControl } from "@/components/slates/ShareSlateControl";
import { ForkReachPanel } from "@/components/slates/ForkReachPanel";
import {
  ACTIVITY_SURFACE, SLATE_PREFIX, SURFACES, landedSurface, openPortOf, parentDir, planOfSurface, planSurface, planTitle, surfaceHasContent,
  type PanelAgent, type PlanPageRef, type SlateSurfaceKind, type SurfaceKind,
} from "@kinu.run/core";
import { useSurfaceFocus } from "./use-surface-focus";
import { InspectorBar, type PageTab, type ToolTab } from "./InspectorBar";
import { PlanPage } from "./PlanPage";
import { useWorkspaceWork } from "./use-workspace-work";
import { ConnectDeviceDialog } from "@/components/ConnectDevicePanel";

// A surface drawn only once it is chosen loads with its first view, outside the workspace's first chunk.
const FilesSurface = lazyRoute<FilesSurfaceProps>(async () => {
  const { FilesSurface: surface } = await import("./FilesSurface");

  return { default: surface };
});

const ExplorationSurface = lazyRoute<ExplorationSurfaceProps>(async () => {
  const { ExplorationSurface: surface } = await import("./ExplorationSurface");

  return { default: surface };
});

const AgentSurface = lazyRoute<AgentSurfaceProps>(async () => {
  const { AgentSurface: surface } = await import("./AgentSurface");

  return { default: surface };
});

const EnvironmentSurface = lazyRoute<EnvironmentSurfaceProps>(async () => {
  const { EnvironmentSurface: surface } = await import("./EnvironmentSurface");

  return { default: surface };
});

const ActivitySurface = lazyRoute<ActivitySurfaceProps>(async () => {
  const { ActivitySurface: surface } = await import("./ActivitySurface");

  return { default: surface };
});

const slateSurface = (id: string): SlateSurfaceKind => `${SLATE_PREFIX}${id}`;

const slateId = (surface: SurfaceKind | null): string | null =>
  surface?.startsWith(SLATE_PREFIX) === true ? surface.slice(SLATE_PREFIX.length) : null;

export interface WorkSurfaceProps {
  surface: SurfaceKind;
  previewFocus?: string | null;
  planFocus?: string | null;
  changesFocus?: ChangesFocus | null;
  /** A file a chat link opened; each new value opens Files on it. */
  filesFocus?: FilesFocus | null;
  planOwner?: string;
  workspacePlanArrival?: WorkspacePlanArrival | null;
  onReviewActor?: (name: string, actorId?: string) => void | Promise<void>;
  onSurface: (s: SurfaceKind) => void;
  agents?: { readonly list: readonly PanelAgent[]; readonly shown: string | null; readonly open: (agent: PanelAgent) => void };
  pinnedPorts: PinnedPort[];
  previewError: string | null;
  previewStarting?: readonly string[];
  onRefreshPorts: () => void;
  plan: PlanReview | null;
  planRpc?: Rpc;
  snapshot: AsyncResource<AgentStatus>;
  memory: MemoryEntry[];
  memoryContent: string;
  onRetryLoad: () => void;
  onSearchMemory: (q: string) => void;
  mctsTrees: ReadonlyMap<string, ForkNode>;
  headActivity: ReadonlyMap<string, number>;
  /** Live deltas, drawn under the durable steps until each one lands. */
  headDeltas?: HeadDeltas;
  isStreaming: boolean;
  executors: ExecutorInfo[];
  executorOutputs: Map<string, ExecutorOutput[]>;
  lastActiveExecutor?: string | null;
  onExecute: (id: string, cmd: string) => Promise<ExecutorCommandResult>;
  backgroundJobs: BackgroundJob[];
  inspectedWork: readonly InspectedWork[];
  onRefreshJobs: () => void;
  pendingActions: PendingAction[];
  /** Called after a decision so the decided row leaves on click, not on the next poll. */
  onRefreshQueue?: () => void;
  onChangelogSeen?: () => void;
  slates?: readonly SlateSummary[];
  slateReloads?: ReadonlyMap<string, number>;
  changesMoved?: number;
  readMoves?: ReadMoves;
  /** Absent in fixture frames, which keeps every tab visible: unknown is not empty. */
  tabPresence?: TabPresence;
  /** Presence unread: no tab is marked until it answers or the reader picks. */
  presencePending?: boolean;
  rpc: Rpc;
  slateBody?: (slate: SlateSummary) => ReactNode;
  workspace?: string;
  /** A fork's landing opens on what it reaches, not the preview. */
  forkLanding?: { readonly slate: string; readonly reaches: readonly string[] } | null;
  onForkLandingOpened?: () => void;
}

/** The open Slate's pane: a fork's reach on landing, else its frame. */
function OpenSlatePanel(props: WorkSurfaceProps & { readonly slate: string; readonly summary: SlateSummary | undefined }) {
  const reloadKey = props.slateReloads?.get(props.slate) ?? 0;

  if (props.slate === props.forkLanding?.slate) {
    return <ForkReachPanel title={props.summary?.title ?? props.slate} reaches={props.forkLanding.reaches} onOpen={() => props.onForkLandingOpened?.()} />;
  }

  if (props.summary === undefined) return <SlateFrame id={props.slate} rpc={props.rpc} reloadKey={reloadKey} />;

  return props.slateBody?.(props.summary) ?? <SlateFrame id={props.summary.id} rpc={props.rpc} reloadKey={reloadKey} onReady={props.onRefreshPorts} />;
}

const LISTING_STRIP = "shrink-0 border-t p-border px-3 py-2";

function ListingStatus({ error, starting = [], onRetry }: { error: string | null; starting?: readonly string[]; onRetry: () => void }) {
  if (error) return <LoadFailure what="preview listings" message={error} onRetry={onRetry} className={LISTING_STRIP} />;

  if (starting.length === 0) return null;

  return (
    <div role="status" className={`flex items-center gap-2 text-xs p-text-3 ${LISTING_STRIP}`} data-preview-starting>
      <Loader size="sm" />
      <span className="min-w-0 truncate">{starting.map(executorLabel).join(" and ")} starting…</span>
    </div>
  );
}

const refOf = (item: OwnedPlan): PlanPageRef => ({ owner: item.owner.name, id: item.plan.id, revision: item.plan.revision });

const sameRevision = (item: OwnedPlan, ref: PlanPageRef): boolean =>
  item.owner.name === ref.owner && item.plan.id === ref.id && item.plan.revision === ref.revision;

/**
 * The plans with a page: each plan's newest revision while it waits on review, and each revision the reader or the
 * workspace opened until a newer one of the same plan is in the read. The page shown keeps its tab either way.
 */
function planPages(plans: readonly OwnedPlan[], opened: readonly string[], surface: SurfaceKind | null): OwnedPlan[] {
  const newest = new Map<string, number>();

  for (const item of plans) {
    const key = `${item.owner.name}\u0000${item.plan.id}`;

    newest.set(key, Math.max(newest.get(key) ?? 0, item.plan.revision));
  }

  return plans.filter((item) => {
    const page = planSurface(refOf(item));
    const latest = newest.get(`${item.owner.name}\u0000${item.plan.id}`) === item.plan.revision;

    return page === surface || (latest && (item.plan.status === "pending" || opened.includes(page)));
  });
}

export function WorkSurface(props: WorkSurfaceProps) {
  const requested = props.surface;
  const [changeCount, setChangeCount] = useState<number | null>(null);
  const content = { tabPresence: props.tabPresence, mctsTrees: props.mctsTrees, slates: props.slates, hasChanges: changeCount !== null };
  const ports = props.pinnedPorts.filter(port => !props.slates?.some(slate => port.executor === "workspace" && slate.port === port.port));
  // Settled once this workspace's presence has picked the first tab, or the
  // reader has; from then on the tab asked for is the tab shown.
  const [settledFor, setSettledFor] = useState<string | null>(null);
  const workspaceKey = props.workspace ?? "";
  const settled = settledFor === workspaceKey;
  const surface = settled || props.presencePending !== true ? landedSurface(requested, content, ports, settled) : null;

  const focus = useSurfaceFocus({
    surface,
    previewFocus: props.previewFocus,
    slates: props.slates,
    pinnedPorts: props.pinnedPorts,
    onSurface: props.onSurface,
  });

  const chip = focus.readyChip;
  const planOwner = props.planOwner ?? "main";
  const workRead = useWorkspaceWork({ rpc: props.rpc, readMoves: props.readMoves ?? {}, plan: props.plan, arrival: props.workspacePlanArrival });
  const plans = useMemo(() => workRead.work?.plans ?? [], [workRead.work]);
  // The plans the reader or the workspace opened this visit; a pending plan has its page without being opened.
  const [openedPlans, setOpenedPlans] = useState<readonly string[]>([]);

  const openPlan = useCallback((plan: PlanPageRef, show: boolean) => {
    const key = planSurface(plan);

    setOpenedPlans((held) => (held.includes(key) ? held : [...held, key]));

    if (show) focus.navigate(key);
  }, [focus.navigate]);

  const showPlan = useCallback((plan: PlanPageRef) => openPlan(plan, true), [openPlan]);
  const reported = props.plan === null ? null : `${props.plan.id}:${String(props.plan.revision)}`;
  const openedReported = useRef<string | null>(null);

  // The plan the pane reports gets its page once per revision, once the read holds it; it takes no surface.
  useEffect(() => {
    if (reported === null || props.plan === null || openedReported.current === reported) return;
    const ref = { owner: planOwner, id: props.plan.id, revision: props.plan.revision };

    if (!plans.some((item) => sameRevision(item, ref))) return;
    openedReported.current = reported;
    openPlan(ref, false);
  }, [reported, props.plan, plans, planOwner, openPlan]);

  // A new pending plan of the workspace's own opens its page, once the read holds it.
  const focusedPlan = useRef<string | null>(null);

  useEffect(() => {
    const key = props.planFocus ?? null;
    const cut = key?.lastIndexOf(":") ?? -1;

    if (key === null || cut < 0 || focusedPlan.current === key) return;
    const ref = { owner: "main", id: key.slice(0, cut), revision: Number(key.slice(cut + 1)) };

    if (!plans.some((item) => sameRevision(item, ref))) return;
    focusedPlan.current = key;
    openPlan(ref, true);
  }, [props.planFocus, plans, openPlan]);

  // A tab the reader picks lands, presence known or not.
  const choose = useCallback((next: SurfaceKind) => {
    setSettledFor(workspaceKey);
    focus.navigate(next);
  }, [workspaceKey, focus.navigate]);

  useEffect(() => {
    if (surface !== null && surface !== requested) focus.navigate(surface);
  }, [surface, requested, focus.navigate]);

  useEffect(() => {
    if (!settled && props.tabPresence !== undefined) setSettledFor(workspaceKey);
  }, [settled, props.tabPresence, workspaceKey]);

  const openPort = surface === null ? undefined : openPortOf(surface, ports);
  const previewSelected = surface?.startsWith(SLATE_PREFIX) === true || surface?.startsWith("preview:") === true;
  // One-shot intent: an Environment card's Files action opens that environment's root.
  const [filesJump, setFilesJump] = useState<{ path: string; file?: string; nonce: number } | null>(null);

  const openFiles = useCallback((path: string, file?: string) => {
    setFilesJump((prev) => ({ path, file, nonce: (prev?.nonce ?? 0) + 1 }));
    focus.navigate("Files");
  }, [focus.navigate]);

  const openChangedFile = useCallback((file: string) => openFiles(parentDir(file), file), [openFiles]);

  const chatFile = props.filesFocus;

  useEffect(() => {
    if (chatFile) openFiles(chatFile.path, chatFile.file);
  }, [chatFile, openFiles]);

  const openSlate = slateId(surface);
  const shownPlan = planOfSurface(surface);
  const shownPlanItem = shownPlan === null ? undefined : plans.find((item) => sameRevision(item, shownPlan));

  // A plan gone from the read closes its page rather than deciding against a plan the workspace no longer holds.
  useEffect(() => {
    if (shownPlan !== null && workRead.work !== null && shownPlanItem === undefined) focus.navigate("Work");
  }, [shownPlan, shownPlanItem, workRead.work, focus.navigate]);

  const openSlateSummary = openSlate === null
    ? undefined
    : props.slates?.find((slate) => slate.id === openSlate);

  // One connect dialog for the column's three surfaces; one is mounted at a time.
  const [connecting, setConnecting] = useState(false);
  const openConnect = useCallback(() => setConnecting(true), []);
  const closeConnect = useCallback(() => setConnecting(false), []);

  const pages: PageTab[] = [
    ...(props.slates ?? []).map((slate) => ({
      key: slateSurface(slate.id), title: slate.title, Icon: SparkleIcon,
      // Share is the open Slate's, as it was beside the strip: what is on screen is what is shared.
      action: props.workspace === undefined || slate.id !== openSlate ? undefined : <ShareSlateControl workspace={props.workspace} slate={slate} rpc={props.rpc} />,
    })),
    ...ports.map((port) => ({
      key: `preview:${port.executor}:${port.port}` as const,
      title: port.name === undefined || port.name === "" ? `${port.executor} :${port.port}` : port.name,
      Icon: GlobeIcon,
    })),
    ...planPages(plans, openedPlans, surface).map((item) => ({
      key: planSurface(refOf(item)),
      title: planTitle(item.plan.content),
      Icon: NotePencilIcon,
    })),
  ];

  const waiting = props.pendingActions.length;

  // Work counts what waits on the reader, in the accent; Changes counts the files moved.
  const tools: ToolTab[] = [
    ...SURFACES.filter((s) => s === surface || surfaceHasContent(s, content)).map((key): ToolTab => {
      if (key === "Work" && waiting > 0) return { key, count: { value: waiting, accent: true } };

      if (key === "Changes" && changeCount !== null && changeCount > 0) return { key, count: { value: changeCount, accent: false } };

      return { key };
    }),
    { key: ACTIVITY_SURFACE },
  ];

  const bodyFit = previewSelected ? "overflow-hidden" : "overflow-y-auto py-[18px] pl-[18px] pr-6";

  return (
    <div className="@container flex flex-col h-full p-sidebar">
      <InspectorBar surface={surface} pages={pages} tools={tools} choose={choose} trailing={<>
        {chip !== null && (
          <button
            type="button"
            onClick={() => choose(chip.surface)}
            data-preview-ready
            title={chip.title}
            aria-label={`Preview ready: ${chip.title}`}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border p-border p-accent-subtle px-2 py-1 text-[11px] font-medium p-accent transition-colors hover:p-elevated @[28rem]:px-2.5"
          >
            <span className="size-1.5 rounded-full p-dot-accent p-dot-pulse" aria-hidden="true" />
            {/* A narrow column keeps the pulse and gives its words to the pages; the name is the control's either way. */}
            <span className="hidden @[28rem]:inline">Preview ready</span>
          </button>
        )}
      </>} />

      <div className={`flex-1 min-h-0 ${surface === "Changes" ? "hidden" : bodyFit}`}>
        {/* Full height, so a plan under review fills the tab and keeps its decision bar in view; a longer list still scrolls here. */}
        <div className={surface === "Work" ? "h-full" : "hidden"}>
          <ErrorBoundary label="Work">
            {/* Keyed by workspace, never by agent: a chat-tab switch must not remount Work. */}
            <WorkTab key="workspace"
              plan={props.plan}
              planOwner={props.planOwner}
              workspacePlanArrival={props.workspacePlanArrival}
              work={workRead}
              onOpenPlan={showPlan}
              onReviewActor={props.onReviewActor}
              pendingActions={props.pendingActions}
              onRefreshQueue={props.onRefreshQueue}
              backgroundJobs={props.backgroundJobs}
              inspectedWork={props.inspectedWork}
              onRefreshJobs={props.onRefreshJobs}
              onOpenSurface={focus.navigate}
              onChangelogSeen={props.onChangelogSeen}
              memory={props.memory}
              rpc={props.rpc}
              readMoves={props.readMoves}
              agents={props.agents}
            />
          </ErrorBoundary>
        </div>
        {shownPlanItem !== undefined && (
          <ErrorBoundary key={`page-${surface ?? ""}`} label="Plan">
            <PlanPage item={shownPlanItem} owner={planOwner} rpc={props.rpc} planRpc={props.planRpc ?? props.rpc}
              onReviewActor={props.onReviewActor} resource={workRead.resource} onRetry={workRead.reload} />
          </ErrorBoundary>
        )}
        <ErrorBoundary key={surface} label={surface ?? undefined}>
          <Suspense fallback={<div className="h-full flex items-center justify-center"><Loader size="sm" /></div>}>
            {surface === "Files" && (
              <FilesSurface rpc={props.rpc} executors={props.executors} jump={filesJump} onConnectDevice={openConnect} />
            )}
            {surface === "Swarms" && (
              <ExplorationSurface
                liveTrees={props.mctsTrees}
                headActivity={props.headActivity}
                headDeltas={props.headDeltas}
                isStreaming={props.isStreaming}
                backgroundJobs={props.backgroundJobs}
                rpc={props.rpc}
              />
            )}
            {surface === "Agent" && (
              <AgentSurface
                snapshot={props.snapshot}
                memory={props.memory} memoryContent={props.memoryContent}
                onSearchMemory={props.onSearchMemory} onRetryLoad={props.onRetryLoad}
                rpc={props.rpc} readMoves={props.readMoves}
              />
            )}
            {surface === "Environment" && (
              <EnvironmentSurface
                rpc={props.rpc}
                executors={props.executors}
                executorOutputs={props.executorOutputs}
                lastActiveExecutor={props.lastActiveExecutor}
                onExecute={props.onExecute}
                onOpenFiles={openFiles}
                onConnectDevice={openConnect}
              />
            )}
            {openPort && <PreviewFrame url={openPort.url} label={openPort.name ?? `${openPort.executor} :${openPort.port}`} />}
            <SideSurface shown={surface} rpc={props.rpc} isStreaming={props.isStreaming} />
            {openSlate !== null && <OpenSlatePanel {...props} slate={openSlate} summary={openSlateSummary} />}
          </Suspense>
        </ErrorBoundary>
      </div>
      <div className={surface === "Changes" ? "flex-1 min-h-0" : "hidden"}>
        <ChangesSurface executors={props.executors} lastActiveExecutor={props.lastActiveExecutor} rpc={props.rpc} focus={props.changesFocus ?? null}
          active={surface === "Changes"} moved={props.changesMoved} turnLive={props.isStreaming} onOpenFile={openChangedFile}
          onCount={setChangeCount} />
      </div>
      <ListingStatus error={props.previewError} starting={props.previewStarting} onRetry={props.onRefreshPorts} />
      {connecting && <ConnectDeviceDialog onClose={closeConnect} />}
    </div>
  );
}

function SideSurface({ shown, rpc, isStreaming }: Pick<WorkSurfaceProps, "rpc" | "isStreaming"> & { shown: SurfaceKind | null }) {
  return shown === ACTIVITY_SURFACE ? <ActivitySurface rpc={rpc} isStreaming={isStreaming} /> : null;
}
