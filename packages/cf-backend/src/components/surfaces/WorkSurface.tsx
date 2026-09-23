/** Workspace navigation: titled live previews first, then work/read surfaces. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
import type { ExecutorInfo } from "@kinu.run/core";
import type { ToolInfo, MemoryEntry, ForkNode, ExecutorCommandResult, Rpc, TabPresence } from "@kinu.run/core";
import type { BackgroundJob } from "@kinu.run/core/protocol";
import { DiffsSurface } from "./DiffsSurface";
import type { PinnedPreviewPort as PinnedPort } from "@kinu.run/core";
import { PreviewFrame } from "@/components/PreviewFrame";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { AgentSurface } from "./AgentSurface";
import { ExplorationSurface } from "./ExplorationSurface";
import { WorkTab } from "./WorkTab";
import { EnvironmentSurface } from "./EnvironmentSurface";
import { FilesSurface } from "./FilesSurface";
import { ReleasesSurface } from "./ReleasesSurface";
import { ActivitySurface } from "./ActivitySurface";
import { SlateFrame } from "@/components/slates/SlateFrame";
import { ShareSlateControl } from "@/components/slates/ShareSlateControl";
import { UnmappedBindingsPanel } from "@/components/slates/UnmappedBindingsPanel";
import { SLATE_PREFIX, SURFACES, landedSurface, openPortOf, surfaceHasContent } from "./presence";
import { useSurfaceFocus } from "./use-surface-focus";
import { ConnectDeviceDialog } from "@/components/ConnectDevicePanel";

/** Activity sits apart at the right of the strip, unlabelled. */
export const ACTIVITY_SURFACE = "Activity";

/** Namespaced so a Slate can never collide with a host surface id. */
export type SlateSurfaceKind = `${typeof SLATE_PREFIX}${string}`;

export type SurfaceKind = (typeof SURFACES)[number] | typeof ACTIVITY_SURFACE | SlateSurfaceKind | `preview:${string}`;

const slateSurface = (id: string): SlateSurfaceKind => `${SLATE_PREFIX}${id}`;

const slateId = (surface: SurfaceKind): string | null =>
  surface.startsWith(SLATE_PREFIX) ? surface.slice(SLATE_PREFIX.length) : null;

const SURFACE_LABEL = {
  Diffs: "Diffs",
  Work: "Work",
  Files: "Files",
  Releases: "Releases",
  Swarms: "Swarms",
  Agent: "Agent",
  Environment: "Env",
} satisfies Record<(typeof SURFACES)[number], string>;

export interface WorkSurfaceProps {
  surface: SurfaceKind;
  previewFocus?: string | null;
  planFocus?: string | null;
  planOwner?: string;
  workspacePlanArrival?: WorkspacePlanArrival | null;
  onReviewActor?: (name: string) => void | Promise<void>;
  onSurface: (s: SurfaceKind) => void;
  pinnedPorts: PinnedPort[];
  previewError: string | null;
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
  rpc: Rpc;
  slateBody?: (slate: SlateSummary) => ReactNode;
  workspace?: string;
  /** A blueprint fork with unmapped bindings opens on the panel, not the preview. */
  unmappedSlate?: string | null;
  onUnmappedOpened?: () => void;
}

export function WorkSurface(props: WorkSurfaceProps) {
  const requested = props.surface;
  const strip = useRef<HTMLDivElement>(null);
  const [hasDiffs, setHasDiffs] = useState(false);
  const content = { tabPresence: props.tabPresence, mctsTrees: props.mctsTrees, slates: props.slates, hasDiffs };
  const ports = props.pinnedPorts.filter(port => !props.slates?.some(slate => port.executor === "workspace" && slate.port === port.port));
  const surface = landedSurface(requested, content, ports);

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

  useEffect(() => {
    if (surface !== requested) focus.navigate(surface);
  }, [surface, requested, focus.navigate]);

  const openPort = openPortOf(surface, ports);
  const previewSelected = surface.startsWith(SLATE_PREFIX) || surface.startsWith("preview:");
  // One-shot intent: an Environment card's Files action opens that environment's root.
  const [filesJump, setFilesJump] = useState<{ path: string; nonce: number } | null>(null);

  const openFiles = useCallback((path: string) => {
    setFilesJump((prev) => ({ path, nonce: (prev?.nonce ?? 0) + 1 }));
    focus.navigate("Files");
  }, [focus.navigate]);

  const openSlate = slateId(surface);

  const openSlateSummary = openSlate === null
    ? undefined
    : props.slates?.find((slate) => slate.id === openSlate);

  const openSlateReloadKey = openSlate === null ? 0 : (props.slateReloads?.get(openSlate) ?? 0);
  // One connect dialog owned here: three surfaces in this column request it, and only
  // one is mounted at a time.
  const [connecting, setConnecting] = useState(false);
  const openConnect = useCallback(() => setConnecting(true), []);
  const closeConnect = useCallback(() => setConnecting(false), []);

  // A surface can be selected without a click (deep link, restored tab); keep it in view.
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
  }, [surface]);
  const bodyFit = previewSelected ? "overflow-hidden" : "overflow-y-auto py-[18px] pl-[18px] pr-6";

  let slatePanel: ReactNode = null;

  if (openSlate !== null) {
    if (openSlate === props.unmappedSlate) {
      slatePanel = <UnmappedBindingsPanel slate={openSlate} title={openSlateSummary?.title ?? openSlate} rpc={props.rpc} onOpen={() => props.onUnmappedOpened?.()} />;
    } else if (openSlateSummary === undefined) {
      slatePanel = <SlateFrame id={openSlate} rpc={props.rpc} reloadKey={openSlateReloadKey} />;
    } else {
      slatePanel = props.slateBody?.(openSlateSummary) ?? <SlateFrame id={openSlateSummary.id} rpc={props.rpc} reloadKey={openSlateReloadKey} onReady={props.onRefreshPorts} />;
    }
  }

  return (
    <div className="@container flex flex-col h-full p-sidebar">
      {/* Activity sits outside the scrolling strip: appended tabs overflow it, and an
          `ml-auto` button inside would scroll away. */}
      <div className={`border-b p-border shrink-0 flex items-stretch ${tabStripH}`}>
        {/* Scroll covers use this column's `p-sidebar` ground, not the canvas's. */}
        <div ref={strip} className={`p-tabstrip [--scroll-ground:var(--c-sidebar)] flex items-center min-w-0 flex-1 px-3 gap-0.5 -mb-px ${tabStripH}`}>
          {props.slates?.map(slate => {
            const kind = slateSurface(slate.id);

            return <button key={kind} onClick={() => focus.navigate(kind)} title={slate.title} aria-label={slate.title}
              aria-current={surface === kind ? "true" : undefined}
              className={`${tabCls} text-left shrink-0 ${surface === kind ? "p-tab-active" : ""}`}>
              <SparkleIcon size={14} /><span>{slate.title}</span>
            </button>;
          })}
          {ports.map(port => {
            const kind: SurfaceKind = `preview:${port.executor}:${port.port}`;
            const title = port.name === undefined || port.name === "" ? `${port.executor} :${port.port}` : port.name;

            return <button key={kind} onClick={() => focus.navigate(kind)} title={title} aria-label={title}
              aria-current={surface === kind ? "true" : undefined}
              className={`${tabCls} text-left shrink-0 ${surface === kind ? "p-tab-active" : ""}`}>{title}</button>;
          })}
          {SURFACES.filter(s => surfaceHasContent(s, content)).map(s => (
            <button key={s} onClick={() => focus.navigate(s)} title={s} aria-label={s}
              aria-current={surface === s ? "true" : undefined}
              className={`${tabCls} ${surface === s ? "p-tab-active p-accent" : ""}`}>
              <span>{SURFACE_LABEL[s]}</span>
              {s === "Work" && props.pendingActions.length > 0 && <span className="p-accent p-t-status">{props.pendingActions.length}</span>}
            </button>
          ))}
        </div>
        {/* Icons sit inside the strip's own bottom rule; `-mb-px` would leave a step. */}
        <div className={`flex shrink-0 items-center border-b p-border ${tabStripH}`}>
        <ShareSlateControl workspace={props.workspace} slate={openSlateSummary} rpc={props.rpc} />
        {chip !== null && (
          <button
            type="button"
            onClick={() => focus.navigate(chip.surface)}
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
          onClick={() => focus.navigate(ACTIVITY_SURFACE)}
          aria-label="Activity"
          title="Context, cost, and cache"
          className={`${tabCls} mr-2 px-2.5 ${surface === ACTIVITY_SURFACE ? "p-tab-active" : ""}`}>
          <GaugeIcon size={14} />
        </button>
        </div>
      </div>

      <div className={`flex-1 min-h-0 ${surface === "Diffs" ? "hidden" : bodyFit}`}>
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
        <ErrorBoundary key={surface} label={surface}>
          {surface === "Files" && (
            <FilesSurface rpc={props.rpc} executors={props.executors} jump={filesJump} onConnectDevice={openConnect} />
          )}
          {surface === "Releases" && <ReleasesSurface rpc={props.rpc} executors={props.executors} />}
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
          {slatePanel}
        </ErrorBoundary>
      </div>
      <div className={surface === "Diffs" ? "flex-1 min-h-0" : "hidden"}>
        <DiffsSurface executors={props.executors} lastActiveExecutor={props.lastActiveExecutor} rpc={props.rpc} onPresence={setHasDiffs} />
      </div>
      {props.previewError && <LoadFailure what="preview listings" message={props.previewError} onRetry={props.onRefreshPorts} />}
      {connecting && <ConnectDeviceDialog onClose={closeConnect} />}
    </div>
  );
}
