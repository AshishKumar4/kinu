/** Workspace navigation: titled live previews first, then work/read surfaces.
 * Preview identity comes from the existing slate and executor owners. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  CaretRightIcon, GaugeIcon, SparkleIcon,
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
import { SLATE_PREFIX, resolveGatedSurface, surfaceHasContent } from "./presence";
import { useSurfaceFocus } from "./use-surface-focus";
import { ConnectDeviceDialog } from "@/components/ConnectDevicePanel";

const SURFACES = ["Work", "Diffs", "Files", "Releases", "Swarms", "Agent", "Environment"] as const;

/** Not one of the segmented work surfaces: Activity is about the run rather
 *  than a place to work in it, so it sits apart at the right of the strip and
 *  carries no label. */
export const ACTIVITY_SURFACE = "Activity";

/** Tabs Kinu wrote. Namespaced rather than mixed into the tuple above so a
 *  Slate can never collide with a host surface by picking its id, and so every
 *  render path can tell the two apart without a lookup. */
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
  activePlanActors?: readonly string[];
  onReviewActor?: (name: string) => void | Promise<void>;
  onSurface: (s: SurfaceKind) => void;
  /** Hide the inspector column. Present only where the column can collapse. */
  onCollapse?: () => void;
  // Preview and actor-owned plans
  pinnedPorts: PinnedPort[];
  previewError: string | null;
  onRefreshPorts: () => void;
  plan: PlanReview | null;
  /** The actor that owns `plan`. Other surfaces remain workspace-scoped. */
  planRpc?: Rpc;
  // Agent
  snapshot: AsyncResource<AgentStatus>;
  tools: ToolInfo[];
  memory: MemoryEntry[];
  memoryContent: string;
  onRetryLoad: () => void;
  onSearchMemory: (q: string) => void;
  // Exploration — the tree of the search in flight, pushed by the engine.
  mctsTrees: ReadonlyMap<string, ForkNode>;
  /** Per-branch journal-write counter, pushed by `head_activity` — what makes an
   *  open branch's transcript grow while that branch works. */
  headActivity: ReadonlyMap<string, number>;
  /** The live deltas — what a running branch is writing right now, drawn under
   *  the durable steps until each one lands. */
  headDeltas?: HeadDeltas;
  /** A turn is in flight — the live surfaces revalidate while it is. */
  isStreaming: boolean;
  // Environment (mounts + terminals)
  executors: ExecutorInfo[];
  executorOutputs: Map<string, ExecutorOutput[]>;
  lastActiveExecutor?: string | null;
  onExecute: (id: string, cmd: string) => Promise<ExecutorCommandResult>;
  // Work
  backgroundJobs: BackgroundJob[];
  onRefreshJobs: () => void;
  /** Everything asynchronous waiting on the owner. One read feeds both the
   *  Work tab's queue and the one accent badge on the strip. */
  pendingActions: PendingAction[];
  /** Re-read that read — what Work's queue calls after a decision, so a
   *  decided row leaves on the click instead of on the next ambient poll. */
  onRefreshQueue?: () => void;
  /** The changelog was seen inside Work — zero the unseen count upstream. */
  onChangelogSeen?: () => void;
  /** Authored previews, titled and placed before the fixed surfaces. */
  slates?: readonly SlateSummary[];
  /** Per-Slate remount counter, bumped by the `slates_changed` broadcast —
   *  what makes an open frame re-read its preview URL. */
  slateReloads?: ReadonlyMap<string, number>;
  /** Whether the gated surfaces have content. Absent in fixture frames,
   *  which keeps every tab visible — unknown is not empty. */
  tabPresence?: TabPresence;
  rpc: Rpc;
  /** Signed-out sample content in place of a network preview. */
  slateBody?: (slate: SlateSummary) => ReactNode;
  /** The workspace name the share control publishes from. Absent in fixture frames without an owner. */
  workspace?: string;
  /** A slate forked from a blueprint whose bindings are still unmapped: its tab opens on the panel, not the preview. */
  unmappedSlate?: string | null;
  onUnmappedOpened?: () => void;
}

export function WorkSurface(props: WorkSurfaceProps) {
  const { surface } = props;
  const strip = useRef<HTMLDivElement>(null);

  const focus = useSurfaceFocus({
    surface,
    previewFocus: props.previewFocus,
    slates: props.slates,
    pinnedPorts: props.pinnedPorts,
    onSurface: props.onSurface,
  });

  const chip = focus.readyChip;

  useEffect(() => { if (props.planFocus) focus.navigate("Work"); }, [props.planFocus, focus.navigate]);
  const [hasDiffs, setHasDiffs] = useState(false);

  const ports = props.pinnedPorts.filter(port => !props.slates?.some(slate => port.executor === "workspace" && slate.port === port.port));
  const openPort = surface.startsWith("preview:") ? ports.find(port => surface === `preview:${port.executor}:${port.port}`) : undefined;
  const previewSelected = surface.startsWith(SLATE_PREFIX) || surface.startsWith("preview:");
  // An unpublished Slate or an empty gated surface loses its selected tab.
  useEffect(() => {
    const duplicate = surface.startsWith("preview:workspace:") ? props.slates?.find(slate => `preview:workspace:${slate.port}` === surface) : undefined;

    const resolved = duplicate ? slateSurface(duplicate.id)
      : surface === "Diffs" && !hasDiffs ? "Work"
      : surface.startsWith("preview:") && !openPort ? "Work"
      : resolveGatedSurface(surface, props.tabPresence, props.mctsTrees, props.slates);

    if (resolved !== surface) focus.navigate(resolved);
  }, [surface, focus.navigate, props.tabPresence, props.mctsTrees, props.slates, hasDiffs, openPort]);
  // A one-shot cross-surface intent: an Environment card's Files action lands
  // the Files tab at that environment's own root on the composite plane.
  const [filesJump, setFilesJump] = useState<{ path: string; nonce: number } | null>(null);

  const openFiles = useCallback((path: string) => {
    setFilesJump((prev) => ({ path, nonce: (prev?.nonce ?? 0) + 1 }));
    focus.navigate("Files");
  }, [focus.navigate]);

  // The frame uses the summary for its header and the counter for preview reloads.
  const openSlate = slateId(surface);

  const openSlateSummary = openSlate === null
    ? undefined
    : props.slates?.find((slate) => slate.id === openSlate);

  const openSlateReloadKey = openSlate === null ? 0 : (props.slateReloads?.get(openSlate) ?? 0);
  // Linking a machine is asked for from three places in this column — an
  // offline Environment card, that card's call-to-action, and the drive's
  // offline row — and none of them is a link to Account settings, which
  // is a page change in the middle of a job. One dialog, owned here, because
  // only one of those surfaces is mounted at a time.
  const [connecting, setConnecting] = useState(false);
  const openConnect = useCallback(() => setConnecting(true), []);
  const closeConnect = useCallback(() => setConnecting(false), []);

  // A surface can be selected without being clicked (a deep link, a restored
  // tab) — keep the current one in view when the strip has to scroll.
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

  return (
    <div className="@container flex flex-col h-full p-sidebar">
      {/* Activity sits OUTSIDE the scrolling strip. Pinning it right with
          `ml-auto` holds only while the tabs fit; Kinu can append its own, so
          the strip overflows and an `ml-auto` button scrolls away with
          everything else. */}
      <div className={`border-b p-border shrink-0 flex items-stretch ${tabStripH}`}>
        <div ref={strip} className={`p-tabstrip flex items-center min-w-0 flex-1 px-3 gap-0.5 -mb-px ${tabStripH}`}>
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
            const title = port.name || `${port.executor} :${port.port}`;

            return <button key={kind} onClick={() => focus.navigate(kind)} title={title} aria-label={title}
              aria-current={surface === kind ? "true" : undefined}
              className={`${tabCls} text-left shrink-0 ${surface === kind ? "p-tab-active" : ""}`}>{title}</button>;
          })}
          {SURFACES.filter(s => (s !== "Diffs" || hasDiffs) && surfaceHasContent(s, props.tabPresence, props.mctsTrees, props.slates)).map(s => (
            <button key={s} onClick={() => focus.navigate(s)} title={s} aria-label={s}
              aria-current={surface === s ? "true" : undefined}
              className={`${tabCls} ${surface === s ? "p-tab-active p-accent" : ""}`}>
              <span>{SURFACE_LABEL[s]}</span>
              {s === "Work" && props.pendingActions.length > 0 && <span className="p-accent p-t-status">{props.pendingActions.length}</span>}
            </button>
          ))}
        </div>
        {/* Icons inside the strip's own rule: the row is one flex line with
            one bottom rule, so the gauge and the collapse chevron sit on the
            same edge the tabs underline — never a ruled strip beside an
            unruled icon column with a visible break between them. */}
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
        {props.onCollapse && (
          <button
            type="button"
            onClick={props.onCollapse}
            data-inspector-collapse
            aria-label="Hide inspector"
            title="Hide inspector"
            className={`${tabCls} px-2 p-text-3`}
          >
            <CaretRightIcon size={14} />
          </button>
        )}
        </div>
      </div>

      <div className={`flex-1 min-h-0 ${surface === "Diffs" ? "hidden" : previewSelected ? "overflow-hidden" : "overflow-y-auto py-[18px] pl-[18px] pr-6"}`}>
        <div className={surface === "Work" ? "" : "hidden"}>
          <ErrorBoundary label="Work">
            {/* Keyed by workspace, never by agent: Work is the workspace's own
                plan, journal and jobs, and a chat-tab switch must not remount
                or refetch it — only Agent and Activity are per agent. */}
            <WorkTab key="workspace"
              plan={props.plan}
              planOwner={props.planOwner}
              workspacePlanArrival={props.workspacePlanArrival}
              activePlanActors={props.activePlanActors}
              onReviewActor={props.onReviewActor}
              planRpc={props.planRpc ?? props.rpc}
              pendingActions={props.pendingActions}
              onRefreshQueue={props.onRefreshQueue}
              backgroundJobs={props.backgroundJobs}
              onRefreshJobs={props.onRefreshJobs}
              onOpenSurface={focus.navigate}
              onChangelogSeen={props.onChangelogSeen}
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
          {openSlate !== null && (openSlate === props.unmappedSlate
            ? <UnmappedBindingsPanel slate={openSlate} title={openSlateSummary?.title ?? openSlate} rpc={props.rpc} onOpen={() => props.onUnmappedOpened?.()} />
            : openSlateSummary
              ? (props.slateBody?.(openSlateSummary) ?? <SlateFrame id={openSlateSummary.id} rpc={props.rpc} reloadKey={openSlateReloadKey} onReady={props.onRefreshPorts} />)
              : <SlateFrame id={openSlate} rpc={props.rpc} reloadKey={openSlateReloadKey} />)}
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
