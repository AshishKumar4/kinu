/**
 * Work Surface — the right column of the RUN altitude. A thin segmented
 * switcher over the workspace's pinned surfaces (Output · Work · Releases ·
 * Exploration · Agent · Environment), NOT a row of co-equal debug tabs. This
 * owns the switcher chrome + dispatch.
 *
 * The naming rule for anything added here: a label names what the reader goes
 * there to find out, never the machinery that produces it. "Work" is what the
 * agent is working through — planned, running and done, plus anything of that
 * work waiting on the owner; "Exploration" is where it tried more than one
 * thing; "Agent" is what this agent is and whether it is getting better.
 * "Tasks", "Jobs" and "Changelog" were three tabs for slices of one question
 * and are now three parts of Work; the words live on where they are true — the
 * `tasks` tool, the jobs read model, chat's job cards, Work's filter chips.
 *
 * The gauge at the right is deliberately apart and deliberately unchanged: the
 * run's meters are about the run rather than a place to work in it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  GaugeIcon, SparkleIcon,
} from "@phosphor-icons/react";
import type { GadgetSummary, PendingAction, PlanReview } from "@kinu.run/core";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { HeadDeltas } from "@/components/head-chat";
import { tabCls } from "@/components/ui/form";
import type { AgentStatus, ExecutorOutput } from "@/hooks/use-kinu";
import type { AsyncResource } from "@/hooks/use-async-resource";
import type { ExecutorInfo } from "@/lib/executors";
import type { ToolInfo, MemoryEntry, ForkNode, BackgroundJob, ExecutorCommandResult, Rpc, TabPresence } from "@/lib/protocol";
import { OutputSurface, type PinnedPort } from "./OutputSurface";
import { AgentSurface } from "./AgentSurface";
import { ExplorationSurface } from "./ExplorationSurface";
import { WorkTab } from "./WorkTab";
import { EnvironmentSurface } from "./EnvironmentSurface";
import { FilesSurface } from "./FilesSurface";
import { ReleasesSurface } from "./ReleasesSurface";
import { ActivitySurface } from "./ActivitySurface";
import { GadgetFrame } from "@/components/gadgets/GadgetFrame";
import { GadgetSurface } from "./GadgetSurface";
import { GADGET_PREFIX, resolveGatedSurface, surfaceHasContent } from "./presence";
import { ConnectDeviceDialog } from "@/components/ConnectDevicePanel";

const SURFACES = ["Output", "Work", "Files", "Releases", "Exploration", "Agent", "Environment"] as const;

/** Not one of the segmented work surfaces: Activity is about the run rather
 *  than a place to work in it, so it sits apart at the right of the strip and
 *  carries no label. */
export const ACTIVITY_SURFACE = "Activity";
/** Tabs Kinu wrote. Namespaced rather than mixed into the tuple above so a
 *  gadget can never collide with a host surface by picking its name, and so
 *  every render path can tell the two apart without a lookup. */
export type GadgetSurfaceKind = `${typeof GADGET_PREFIX}${string}`;
export type SurfaceKind = (typeof SURFACES)[number] | typeof ACTIVITY_SURFACE | GadgetSurfaceKind;

const gadgetSurface = (slug: string): GadgetSurfaceKind => `${GADGET_PREFIX}${slug}`;
const gadgetSlug = (surface: SurfaceKind): string | null =>
  surface.startsWith(GADGET_PREFIX) ? surface.slice(GADGET_PREFIX.length) : null;

const SURFACE_LABEL = {
  Output: "Output",
  Work: "Work",
  Files: "Files",
  Releases: "Releases",
  Exploration: "Explore",
  Agent: "Agent",
  Environment: "Env",
} satisfies Record<(typeof SURFACES)[number], string>;

export interface WorkSurfaceProps {
  surface: SurfaceKind;
  onSurface: (s: SurfaceKind) => void;
  // Output
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
  /** Gadgets Kinu published for this workspace. Appended after the host
   *  surfaces, in their own marked group. */
  gadgets?: readonly GadgetSummary[];
  /** Per-gadget remount counter, bumped by the `gadgets_changed` broadcast —
   *  what an open frame re-reads its client on. */
  gadgetReloads?: ReadonlyMap<string, number>;
  /** Whether the gated surfaces have content. Absent in fixture frames,
   *  which keeps every tab visible — unknown is not empty. */
  tabPresence?: TabPresence;
  rpc: Rpc;
}
export function WorkSurface(props: WorkSurfaceProps) {
  const { surface, onSurface } = props;
  const strip = useRef<HTMLDivElement>(null);
  // An unpublished gadget or an empty gated surface loses its selected tab.
  useEffect(() => {
    const resolved = resolveGatedSurface(surface, props.tabPresence, props.mctsTrees, props.gadgets);
    if (resolved !== surface) onSurface(resolved);
  }, [surface, onSurface, props.tabPresence, props.mctsTrees, props.gadgets]);
  // A one-shot cross-surface intent: an Environment card's Files action lands
  // the Files tab at that environment's own root on the composite plane.
  const [filesJump, setFilesJump] = useState<{ path: string; nonce: number } | null>(null);
  const openFiles = useCallback((path: string) => {
    setFilesJump((prev) => ({ path, nonce: (prev?.nonce ?? 0) + 1 }));
    onSurface("Files");
  }, [onSurface]);
  // The frame uses the summary for its header and the counter for remounts.
  const openGadget = gadgetSlug(surface);
  const openGadgetSummary = openGadget === null
    ? undefined
    : props.gadgets?.find((gadget) => gadget.slug === openGadget);
  const openGadgetReloadKey = openGadget === null ? 0 : (props.gadgetReloads?.get(openGadget) ?? 0);
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
          {SURFACES.filter((s) => surfaceHasContent(s, props.tabPresence, props.mctsTrees, props.gadgets)).map((s) => {
            // Two signals, two homes, two encodings: live ports light Output
            // green, and decisions waiting on the owner light Work in accent.
            // Liveness gets no digit — something merely running needs nobody,
            // and the chat header's pulsing pill already says it.
            const badge = s === "Output" ? props.pinnedPorts.length
              : s === "Work" ? props.pendingActions.length : 0;
            const badgeTone = s === "Work" ? "p-accent-subtle p-accent" : "p-badge-success";
            return (
              <button key={s} onClick={() => onSurface(s)} title={s} aria-label={s}
                aria-current={surface === s ? "true" : undefined}
                className={`${tabCls} ${surface === s ? "p-tab-active p-accent font-semibold" : ""}`}>
                <span>{SURFACE_LABEL[s]}</span>
                {badge > 0 && (
                  <span className={`inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full text-[10px] font-semibold p-num ${badgeTone}`}>{badge}</span>
                )}
              </button>
            );
          })}
        {/* Kinu's own tabs, after ours and behind a divider. The sparkle is
            the marker: a tab in this group is agent-authored, and the divider
            is what stops it reading as one more thing we shipped. Titles are
            validated in core against RESERVED_GADGET_TITLES, so none of them can
            wear a host surface's name. */}
        {(props.gadgets?.length ?? 0) > 0 && (
          <span aria-hidden className="self-center h-4 w-px mx-1.5 shrink-0" style={{ background: "var(--c-border)" }} />
        )}
        {props.gadgets?.map((gadget) => {
          const kind = gadgetSurface(gadget.slug);
          return (
            <button key={gadget.slug} onClick={() => onSurface(kind)}
              title={`${gadget.title}, written by Kinu`}
              aria-current={surface === kind ? "true" : undefined}
              className={`${tabCls} ${surface === kind ? "p-tab-active" : ""}`}>
              <SparkleIcon size={14} />
              <span className={surface === kind ? "" : "hidden @[34rem]:inline"}>{gadget.title}</span>
            </button>
          );
        })}
        </div>
        <button
          onClick={() => onSurface(ACTIVITY_SURFACE)}
          aria-label="Activity"
          title="Context, cost, and cache"
          className={`${tabCls} mr-2 px-2.5 ${surface === ACTIVITY_SURFACE ? "p-tab-active" : ""}`}>
          <GaugeIcon size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-[18px] pl-[18px] pr-6 min-h-0">
        <ErrorBoundary key={surface} label={surface}>
          {surface === "Output" && <OutputSurface
            pinnedPorts={props.pinnedPorts}
            previewError={props.previewError}
            onRefreshPorts={props.onRefreshPorts}
            plan={props.plan}
            planRpc={props.planRpc}
            executors={props.executors}
            lastActiveExecutor={props.lastActiveExecutor}
            rpc={props.rpc}
          />}
          {surface === "Work" && (
            <WorkTab
              pendingActions={props.pendingActions}
              onRefreshQueue={props.onRefreshQueue}
              backgroundJobs={props.backgroundJobs}
              onRefreshJobs={props.onRefreshJobs}
              onOpenSurface={onSurface}
              onChangelogSeen={props.onChangelogSeen}
              isStreaming={props.isStreaming}
              rpc={props.rpc}
            />
          )}
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
          {surface === ACTIVITY_SURFACE && <ActivitySurface rpc={props.rpc} isStreaming={props.isStreaming} />}
          {openGadget !== null && (openGadgetSummary
            ? <GadgetSurface gadget={openGadgetSummary} rpc={props.rpc} reloadKey={openGadgetReloadKey} />
            : <GadgetFrame slug={openGadget} rpc={props.rpc} reloadKey={openGadgetReloadKey} />)}
        </ErrorBoundary>
      </div>
      {connecting && <ConnectDeviceDialog onClose={closeConnect} />}
    </div>
  );
}
