/** Workspace navigation: titled live previews first, then work/read surfaces. */
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  GaugeIcon, SparkleIcon,
} from "@phosphor-icons/react";
import type { SlateSummary, PendingAction, PlanReview } from "@kinu.run/core";
import type { WorkspacePlanArrival } from "@/hooks/use-kinu";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { HeadDeltas } from "@kinu.run/core";
import { tabCls, tabStripH } from "@/components/ui/form";
import type { AgentStatus, ExecutorOutput } from "@/hooks/use-kinu";
import type { AsyncResource } from "@/hooks/use-async-resource";
import { executorLabel, type ExecutorInfo } from "@kinu.run/core";
import type { ToolInfo, MemoryEntry, ForkNode, ExecutorCommandResult, Rpc, TabPresence } from "@kinu.run/core";
import type { BackgroundJob } from "@kinu.run/core/protocol";
import { ChangesSurface, type ChangesFocus } from "./ChangesSurface";
import type { PinnedPreviewPort as PinnedPort } from "@kinu.run/core";
import { PreviewFrame } from "@/components/PreviewFrame";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { Loader } from "@cloudflare/kumo";
import { AgentSurface } from "./AgentSurface";
import { ExplorationSurface } from "./ExplorationSurface";
import { WorkTab } from "./WorkTab";
import { EnvironmentSurface } from "./EnvironmentSurface";
import { FilesSurface } from "./FilesSurface";
import { ActivitySurface } from "./ActivitySurface";
import { SlateFrame } from "@/components/slates/SlateFrame";
import { ShareSlateControl } from "@/components/slates/ShareSlateControl";
import { UnmappedBindingsPanel } from "@/components/slates/UnmappedBindingsPanel";
import {
  ACTIVITY_SURFACE, SLATE_PREFIX, SURFACES, landedSurface, openPortOf, parentDir, surfaceHasContent,
  type SlateSurfaceKind, type SurfaceKind,
} from "@kinu.run/core";
import { useSurfaceFocus } from "./use-surface-focus";
import { useWheelScrollsSideways } from "@/hooks/use-wheel-scrolls-sideways";
import { ConnectDeviceDialog } from "@/components/ConnectDevicePanel";

const slateSurface = (id: string): SlateSurfaceKind => `${SLATE_PREFIX}${id}`;

const slateId = (surface: SurfaceKind | null): string | null =>
  surface?.startsWith(SLATE_PREFIX) === true ? surface.slice(SLATE_PREFIX.length) : null;

const SURFACE_LABEL = {
  Changes: "Changes",
  Work: "Work",
  Files: "Files",
  Swarms: "Swarms",
  Agent: "Agent",
  Environment: "Env",
} satisfies Record<(typeof SURFACES)[number], string>;

export interface WorkSurfaceProps {
  surface: SurfaceKind;
  previewFocus?: string | null;
  planFocus?: string | null;
  changesFocus?: ChangesFocus | null;
  planOwner?: string;
  workspacePlanArrival?: WorkspacePlanArrival | null;
  onReviewActor?: (name: string) => void | Promise<void>;
  onSurface: (s: SurfaceKind) => void;
  pinnedPorts: PinnedPort[];
  previewError: string | null;
  previewStarting?: readonly string[];
  onRefreshPorts: () => void;
  plan: PlanReview | null;
  planRpc?: Rpc;
  snapshot: AsyncResource<AgentStatus>;
  tools: ToolInfo[];
  memory: MemoryEntry[];
  memoryContent: string;
  onRetryLoad: () => void;
  onSearchMemory: (q: string) => void;
  mctsTrees: ReadonlyMap<string, ForkNode>;
  /** Per-branch journal-write counter, pushed by `head_activity`. */
  headActivity: ReadonlyMap<string, number>;
  /** Live deltas, drawn under the durable steps until each one lands. */
  headDeltas?: HeadDeltas;
  isStreaming: boolean;
  executors: ExecutorInfo[];
  executorOutputs: Map<string, ExecutorOutput[]>;
  lastActiveExecutor?: string | null;
  onExecute: (id: string, cmd: string) => Promise<ExecutorCommandResult>;
  backgroundJobs: BackgroundJob[];
  onRefreshJobs: () => void;
  /** One read feeds both the Work queue and the strip's accent badge. */
  pendingActions: PendingAction[];
  /** Called after a decision so the decided row leaves on click, not on the next poll. */
  onRefreshQueue?: () => void;
  onChangelogSeen?: () => void;
  slates?: readonly SlateSummary[];
  /** Per-Slate remount counter from `slates_changed`; makes an open frame re-read its URL. */
  slateReloads?: ReadonlyMap<string, number>;
  /** Absent in fixture frames, which keeps every tab visible: unknown is not empty. */
  tabPresence?: TabPresence;
  /** The workspace's presence read has not answered: no tab is marked until it has or the reader picks one. */
  presencePending?: boolean;
  rpc: Rpc;
  slateBody?: (slate: SlateSummary) => ReactNode;
  workspace?: string;
  /** A blueprint fork with unmapped bindings opens on the panel, not the preview. */
  unmappedSlate?: string | null;
  onUnmappedOpened?: () => void;
}

/** A surface can be selected without a click (deep link, restored tab); keep its tab in view. */
function useSelectedTabInView(strip: RefObject<HTMLDivElement | null>, surface: SurfaceKind | null): void {
  useEffect(() => {
    const container = strip.current;
    const selected = container?.querySelector('[aria-current="true"]');

    if (!container || !selected) return;
    const viewport = container.getBoundingClientRect();
    const tab = selected.getBoundingClientRect();
    const left = viewport.left + container.clientLeft;
    const right = left + container.clientWidth;

    if (tab.left < left) container.scrollLeft += tab.left - left;
    else if (tab.right > right) container.scrollLeft += tab.right - right;
  }, [strip, surface]);
}

/** The open Slate's pane: its bindings panel while a blueprint fork has unmapped ones, else its frame. */
function OpenSlatePanel(props: WorkSurfaceProps & { readonly slate: string; readonly summary: SlateSummary | undefined }) {
  const reloadKey = props.slateReloads?.get(props.slate) ?? 0;

  if (props.slate === props.unmappedSlate) {
    return <UnmappedBindingsPanel slate={props.slate} title={props.summary?.title ?? props.slate} rpc={props.rpc} onOpen={() => props.onUnmappedOpened?.()} />;
  }

  if (props.summary === undefined) return <SlateFrame id={props.slate} rpc={props.rpc} reloadKey={reloadKey} />;

  return props.slateBody?.(props.summary) ?? <SlateFrame id={props.summary.id} rpc={props.rpc} reloadKey={reloadKey} onReady={props.onRefreshPorts} />;
}

const LISTING_STRIP = "shrink-0 border-t p-border px-3 py-2";

/** A failed listing wins over a starting one. */
function ListingStatus({ error, starting, onRetry }: { error: string | null; starting: readonly string[]; onRetry: () => void }) {
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
  const strip = useRef<HTMLDivElement>(null);
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
  const workAvailable = surfaceHasContent("Work", content);

  useEffect(() => {
    if (props.planFocus && workAvailable) focus.navigate("Work");
  }, [props.planFocus, workAvailable, focus.navigate]);

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

  const openSlate = slateId(surface);

  const openSlateSummary = openSlate === null
    ? undefined
    : props.slates?.find((slate) => slate.id === openSlate);

  // One connect dialog for the three surfaces in this column that ask for it: only one is mounted at a time.
  const [connecting, setConnecting] = useState(false);
  const openConnect = useCallback(() => setConnecting(true), []);
  const closeConnect = useCallback(() => setConnecting(false), []);

  useSelectedTabInView(strip, surface);
  useWheelScrollsSideways(strip);
  const bodyFit = previewSelected ? "overflow-hidden" : "overflow-y-auto py-[18px] pl-[18px] pr-6";

  return (
    <div className="@container flex flex-col h-full p-sidebar">
      {/* Activity sits outside the strip so it does not scroll away. */}
      <div className={`border-b p-border shrink-0 flex items-stretch ${tabStripH}`}>
        <div ref={strip} className={`p-tabstrip [--scroll-ground:var(--c-sidebar)] flex items-center min-w-0 flex-1 px-3 gap-0.5 -mb-px ${tabStripH}`}>
          {props.slates?.map(slate => {
            const kind = slateSurface(slate.id);

            return <button key={kind} onClick={() => choose(kind)} title={slate.title} aria-label={slate.title}
              aria-current={surface === kind ? "true" : undefined}
              className={`${tabCls} text-left shrink-0 ${surface === kind ? "p-tab-active" : ""}`}>
              <SparkleIcon size={14} /><span>{slate.title}</span>
            </button>;
          })}
          {ports.map(port => {
            const kind: SurfaceKind = `preview:${port.executor}:${port.port}`;
            const title = port.name === undefined || port.name === "" ? `${port.executor} :${port.port}` : port.name;

            return <button key={kind} onClick={() => choose(kind)} title={title} aria-label={title}
              aria-current={surface === kind ? "true" : undefined}
              className={`${tabCls} text-left shrink-0 ${surface === kind ? "p-tab-active" : ""}`}>{title}</button>;
          })}
          {SURFACES.filter(s => s === surface || surfaceHasContent(s, content)).map(s => (
            <button key={s} onClick={() => choose(s)} title={s} aria-label={s}
              aria-current={surface === s ? "true" : undefined}
              className={`${tabCls} ${surface === s ? "p-tab-active p-accent" : ""}`}>
              <span>{SURFACE_LABEL[s]}</span>
              {s === "Work" && props.pendingActions.length > 0 && <span className="p-accent p-t-status">{props.pendingActions.length}</span>}
              {s === "Changes" && changeCount !== null && changeCount > 0 && <span className="p-t-status p-text-3">{changeCount}</span>}
            </button>
          ))}
        </div>
        {/* Icons sit inside the strip's own bottom rule; `-mb-px` would leave a step. */}
        <div className={`flex shrink-0 items-center border-b p-border ${tabStripH}`}>
        <ShareSlateControl workspace={props.workspace} slate={openSlateSummary} rpc={props.rpc} />
        {chip !== null && (
          <button
            type="button"
            onClick={() => choose(chip.surface)}
            data-preview-ready
            title={chip.title}
            aria-label={`Preview ready: ${chip.title}`}
            className="my-auto mr-1 inline-flex shrink-0 items-center gap-1.5 rounded-full border p-border p-accent-subtle px-2.5 py-1 text-[11px] font-medium p-accent transition-colors hover:p-elevated"
          >
            <span className="size-1.5 rounded-full p-dot-accent p-dot-pulse" aria-hidden="true" />
            Preview ready
          </button>
        )}
        <button
          onClick={() => choose(ACTIVITY_SURFACE)}
          aria-label="Activity"
          title="Context, cost, and cache"
          className={`${tabCls} mr-2 px-2.5 ${surface === ACTIVITY_SURFACE ? "p-tab-active" : ""}`}>
          <GaugeIcon size={14} />
        </button>
        </div>
      </div>

      <div className={`flex-1 min-h-0 ${surface === "Changes" ? "hidden" : bodyFit}`}>
        <div className={surface === "Work" ? "" : "hidden"}>
          <ErrorBoundary label="Work">
            {/* Keyed by workspace, never by agent: a chat-tab switch must not remount Work. */}
            <WorkTab key="workspace"
              plan={props.plan}
              planOwner={props.planOwner}
              workspacePlanArrival={props.workspacePlanArrival}
              planRpc={props.planRpc ?? props.rpc}
              onReviewActor={props.onReviewActor}
              pendingActions={props.pendingActions}
              onRefreshQueue={props.onRefreshQueue}
              backgroundJobs={props.backgroundJobs}
              onRefreshJobs={props.onRefreshJobs}
              onOpenSurface={focus.navigate}
              onChangelogSeen={props.onChangelogSeen}
              memory={props.memory}
              isStreaming={props.isStreaming}
              rpc={props.rpc}
            />
          </ErrorBoundary>
        </div>
        <ErrorBoundary key={surface} label={surface ?? undefined}>
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
              snapshot={props.snapshot} tools={props.tools}
              memory={props.memory} memoryContent={props.memoryContent}
              onSearchMemory={props.onSearchMemory} onRetryLoad={props.onRetryLoad}
              rpc={props.rpc}
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
          {surface === ACTIVITY_SURFACE && <ActivitySurface rpc={props.rpc} isStreaming={props.isStreaming} />}
          {openSlate !== null && <OpenSlatePanel {...props} slate={openSlate} summary={openSlateSummary} />}
        </ErrorBoundary>
      </div>
      <div className={surface === "Changes" ? "flex-1 min-h-0" : "hidden"}>
        <ChangesSurface executors={props.executors} lastActiveExecutor={props.lastActiveExecutor} rpc={props.rpc} focus={props.changesFocus ?? null}
          turnLive={props.isStreaming} onOpenFile={openChangedFile} onCount={setChangeCount} />
      </div>
      <ListingStatus error={props.previewError} starting={props.previewStarting ?? []} onRetry={props.onRefreshPorts} />
      {connecting && <ConnectDeviceDialog onClose={closeConnect} />}
    </div>
  );
}
