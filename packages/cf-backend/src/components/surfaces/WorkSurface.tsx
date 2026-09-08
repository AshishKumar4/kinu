/** Workspace navigation: titled live previews first, then work/read surfaces.
 * Preview identity comes from the existing slate and executor owners. */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  GaugeIcon, SparkleIcon,
} from "@phosphor-icons/react";
import type { SlateSummary, PendingAction, PlanReview } from "@kinu.run/core";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { HeadDeltas } from "@/components/head-chat";
import { tabCls } from "@/components/ui/form";
import type { AgentStatus, ExecutorOutput } from "@/hooks/use-kinu";
import type { AsyncResource } from "@/hooks/use-async-resource";
import type { ExecutorInfo } from "@/lib/executors";
import type { ToolInfo, MemoryEntry, ForkNode, BackgroundJob, ExecutorCommandResult, Rpc, TabPresence } from "@/lib/protocol";
import { DiffsSurface } from "./DiffsSurface";
import type { PinnedPreviewPort as PinnedPort } from "@/lib/preview-ports";
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
import { SLATE_PREFIX, resolveGatedSurface, surfaceHasContent } from "./presence";
import { ConnectDeviceDialog } from "@/components/ConnectDevicePanel";

const SURFACES = ["Work", "Diffs", "Files", "Releases", "Exploration", "Agent", "Environment"] as const;

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
  Exploration: "Explore",
  Agent: "Agent",
  Environment: "Env",
} satisfies Record<(typeof SURFACES)[number], string>;

export interface WorkSurfaceProps {
  surface: SurfaceKind;
  previewFocus?: string | null;
  planFocus?: string | null;
  planOwner?: string;
  onReviewActor?: (name: string) => void | Promise<void>;
  onSurface: (s: SurfaceKind) => void;
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
}
export function WorkSurface(props: WorkSurfaceProps) {
  const { surface, onSurface } = props;
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const focus = props.previewFocus;
    if (focus?.startsWith("slate:")) onSurface(`slate:${focus.slice(6)}`);
    else if (focus?.startsWith("preview:")) onSurface(`preview:${focus.slice(8)}`);
  }, [props.previewFocus, onSurface]);
  useEffect(() => { if (props.planFocus) onSurface("Work"); }, [props.planFocus, onSurface]);
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
    if (resolved !== surface) onSurface(resolved);
  }, [surface, onSurface, props.tabPresence, props.mctsTrees, props.slates, hasDiffs, openPort]);
  // A one-shot cross-surface intent: an Environment card's Files action lands
  // the Files tab at that environment's own root on the composite plane.
  const [filesJump, setFilesJump] = useState<{ path: string; nonce: number } | null>(null);
  const openFiles = useCallback((path: string) => {
    setFilesJump((prev) => ({ path, nonce: (prev?.nonce ?? 0) + 1 }));
    onSurface("Files");
  }, [onSurface]);
  // The frame uses the summary for its header and the counter for preview reloads.
  const openSlate = slateId(surface);
  const openSlateSummary = openSlate === null
    ? undefined
    : props.slates?.find((slate) => slate.id === openSlate);
  const openSlateReloadKey = openSlate === null ? 0 : (props.slateReloads?.get(openSlate) ?? 0);
  // Linking a machine is asked for from three places in this column — an
  // offline Environment card, that card's call-to-action, and the drive's
  // offline row — and all three used to be links to Account settings, which
  // is a page change in the middle of a job. One dialog, owned here, because
  // only one of those surfaces is mounted at a time.
  const [connecting, setConnecting] = useState(false);
  const openConnect = useCallback(() => setConnecting(true), []);
  const closeConnect = useCallback(() => setConnecting(false), []);

  // A surface can be selected without being clicked (a deep link, a restored
  // tab) — keep the current one in view when the strip has to scroll.
  useEffect(() => {
    strip.current?.querySelector('[aria-current="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [surface]);

  return (
    <div className="@container flex flex-col h-full p-sidebar">
      {/* Activity sits OUTSIDE the scrolling strip. It used to be pinned right
          by `ml-auto`, which worked only while the tabs fit; once Kinu can
          append its own, the strip overflows and an `ml-auto` button scrolls
          away with everything else. */}
      <div className="border-b p-border shrink-0 flex items-stretch">
        {/* Text labels match the mock and fit at its 430px inspector width.
            The longer route names stay internal; the visible words are
            Explore and Env, as in the owner's surface switcher. */}
        <div ref={strip} className="p-tabstrip [--scroll-ground:var(--c-sidebar)] flex items-center min-w-0 flex-1 px-3 gap-0.5 -mb-px">
          {props.slates?.map(slate => {
            const kind = slateSurface(slate.id);
            return <button key={kind} onClick={() => onSurface(kind)} title={slate.title} aria-label={slate.title}
              aria-current={surface === kind ? "true" : undefined}
              className={`${tabCls} text-left shrink-0 ${surface === kind ? "p-tab-active" : ""}`}>
              <SparkleIcon size={14} /><span>{slate.title}</span>
            </button>;
          })}
          {ports.map(port => {
            const kind: SurfaceKind = `preview:${port.executor}:${port.port}`;
            const title = port.name || `${port.executor} :${port.port}`;
            return <button key={kind} onClick={() => onSurface(kind)} title={title} aria-label={title}
              aria-current={surface === kind ? "true" : undefined}
              className={`${tabCls} text-left shrink-0 ${surface === kind ? "p-tab-active" : ""}`}>{title}</button>;
          })}
          {SURFACES.filter(s => (s !== "Diffs" || hasDiffs) && surfaceHasContent(s, props.tabPresence, props.mctsTrees, props.slates)).map(s => (
            <button key={s} onClick={() => onSurface(s)} title={s} aria-label={s}
              aria-current={surface === s ? "true" : undefined}
              className={`${tabCls} ${surface === s ? "p-tab-active p-accent font-semibold" : ""}`}>
              <span>{SURFACE_LABEL[s]}</span>
              {s === "Work" && props.pendingActions.length > 0 && <span className="p-accent text-[10px]">{props.pendingActions.length}</span>}
            </button>
          ))}
        </div>
        <button
          onClick={() => onSurface(ACTIVITY_SURFACE)}
          aria-label="Activity"
          title="Context, cost, and cache"
          className={`${tabCls} mr-2 px-2.5 ${surface === ACTIVITY_SURFACE ? "p-tab-active" : ""}`}>
          <GaugeIcon size={14} />
        </button>
      </div>

      <div className={`flex-1 min-h-0 ${surface === "Diffs" ? "hidden" : previewSelected ? "overflow-hidden" : "overflow-y-auto py-[18px] pl-[18px] pr-6"}`}>
        <div className={surface === "Work" ? "" : "hidden"}>
          <ErrorBoundary label="Work">
            <WorkTab key={props.planOwner ?? "main"}
              plan={props.plan}
              planOwner={props.planOwner}
              onReviewActor={props.onReviewActor}
              planRpc={props.planRpc ?? props.rpc}
              pendingActions={props.pendingActions}
              onRefreshQueue={props.onRefreshQueue}
              backgroundJobs={props.backgroundJobs}
              onRefreshJobs={props.onRefreshJobs}
              onOpenSurface={onSurface}
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
          {surface === "Exploration" && (
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
          {openSlate !== null && (openSlateSummary
            ? <SlateFrame id={openSlateSummary.id} rpc={props.rpc} reloadKey={openSlateReloadKey} onReady={props.onRefreshPorts} />
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
