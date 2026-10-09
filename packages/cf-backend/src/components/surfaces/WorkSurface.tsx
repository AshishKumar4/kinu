/** Workspace navigation: titled live previews first, then work/read surfaces. */
import { Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { GlobeIcon, NotePencilIcon, SparkleIcon } from "@phosphor-icons/react";
import type { SlateSummary, PendingAction, PlanReview } from "@kinu.run/core";
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
  ACTIVITY_SURFACE, SLATE_PREFIX, SURFACES, landedSurface, openPortOf, parentDir, planSurface, planTitle, surfaceHasContent,
  type PanelAgent, type SlateSurfaceKind, type SurfaceKind,
} from "@kinu.run/core";
import { useSurfaceFocus } from "./use-surface-focus";
import { InspectorBar, type PageTab, type ToolTab } from "./InspectorBar";
import { PlanPageList } from "./PlanPage";
import { usePlanPages } from "./use-plan-pages";
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

  const planPages = usePlanPages({
    rpc: props.rpc, readMoves: props.readMoves, plan: props.plan, planOwner: props.planOwner, planFocus: props.planFocus,
    arrival: props.workspacePlanArrival, surface, navigate: focus.navigate,
  });

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
    ...planPages.pages.map((item) => ({
      key: planSurface({ owner: item.owner.name, id: item.plan.id, revision: item.plan.revision }), title: planTitle(item.plan.content), Icon: NotePencilIcon,
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
        <div className={surface === "Work" ? undefined : "hidden"}>
          <ErrorBoundary label="Work">
            {/* Keyed by workspace, never by agent: a chat-tab switch must not remount Work. */}
            <WorkTab key="workspace"
              work={planPages.read}
              onOpenPlan={planPages.show}
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
        <PlanPageList pages={planPages} rpc={props.rpc} planRpc={props.planRpc} onReviewActor={props.onReviewActor} />
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
