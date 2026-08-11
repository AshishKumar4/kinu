/**
 * Work Surface — Column C of the RUN altitude. A thin segmented switcher over
 * the workspace's pinned work surfaces (Output · Brain · Reasoning · Releases ·
 * Tasks · Environment), NOT a row of co-equal debug tabs. The Run Timeline
 * (Column B) drives which surface is active; this owns the switcher chrome +
 * dispatch.
 */
import { useEffect, useRef } from "react";
import {
  MonitorIcon, BrainIcon, TreeStructureIcon, ClockIcon, GitDiffIcon, StackIcon, GaugeIcon,
  SparkleIcon,
} from "@phosphor-icons/react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { AgentStatus, ExecutorOutput } from "@/hooks/use-proteus";
import type { ExecutorInfo } from "@/lib/executors";
import type { ToolInfo, MemoryEntry, MCTSNode, BackgroundJob, Rpc } from "@/lib/protocol";
import type { AgentViewSummary } from "@proteus/core";
import { OutputSurface, type PinnedPort } from "./OutputSurface";
import { BrainSurface } from "./BrainSurface";
import { ReasoningSurface } from "./ReasoningSurface";
import { TasksSurface } from "./TasksSurface";
import { EnvironmentSurface } from "./EnvironmentSurface";
import { ReleasesSurface } from "./ReleasesSurface";
import { ActivitySurface } from "./ActivitySurface";
import { AgentViewSurface } from "./AgentViewSurface";

export const SURFACES = ["Output", "Brain", "Reasoning", "Releases", "Tasks", "Environment"] as const;
/** Not one of the segmented work surfaces: Activity is about the run rather
 *  than a place to work in it, so it sits apart at the right of the strip and
 *  carries no label. */
export const ACTIVITY_SURFACE = "Activity";
/** Tabs Proteus wrote. Namespaced rather than mixed into the tuple above so a
 *  view can never collide with a host surface by picking its name, and so
 *  every render path can tell the two apart without a lookup. */
export type AgentViewSurfaceKind = `view:${string}`;
export type SurfaceKind = (typeof SURFACES)[number] | typeof ACTIVITY_SURFACE | AgentViewSurfaceKind;

export const agentViewSurface = (slug: string): AgentViewSurfaceKind => `view:${slug}`;
export const agentViewSlug = (surface: SurfaceKind): string | null =>
  surface.startsWith("view:") ? surface.slice("view:".length) : null;

const SURFACE_ICON: Record<(typeof SURFACES)[number], React.ComponentType<{ size?: number }>> = {
  Output: MonitorIcon,
  Brain: BrainIcon,
  Reasoning: TreeStructureIcon,
  Releases: GitDiffIcon,
  Tasks: ClockIcon,
  Environment: StackIcon,
};

export interface WorkSurfaceProps {
  surface: SurfaceKind;
  onSurface: (s: SurfaceKind) => void;
  // Output
  pinnedPorts: PinnedPort[];
  // Brain
  agentStatus: AgentStatus | null;
  tools: ToolInfo[];
  memory: MemoryEntry[];
  memoryContent: string;
  onSearchMemory: (q: string) => void;
  // Reasoning
  mctsTree: MCTSNode | null;
  /** A turn is in flight — the live surfaces revalidate while it is. */
  isStreaming: boolean;
  // Environment (mounts + terminals)
  executors: ExecutorInfo[];
  executorOutputs: Map<string, ExecutorOutput[]>;
  lastActiveExecutor?: string | null;
  onExecute: (id: string, cmd: string) => Promise<{ stdout?: string; stderr?: string; exitCode?: number; error?: string }>;
  // Background tasks (Tasks surface) + live running count for its tab badge.
  backgroundJobs: BackgroundJob[];
  runningTaskCount?: number;
  onRefreshTasks: () => void;
  // Evolution Changelog: unseen self-changes badge the Brain tab; viewing
  // the digest (inside Brain) zeroes it.
  changelogUnseen?: number;
  onChangelogSeen?: () => void;
  /** Dashboards Proteus published for this workspace. Appended after the host
   *  surfaces, in their own marked group. */
  agentViews?: AgentViewSummary[];
  rpc: Rpc;
}

export function WorkSurface(props: WorkSurfaceProps) {
  const { surface, onSurface } = props;
  const strip = useRef<HTMLDivElement>(null);

  // The Run Timeline drives the active surface, so a tab can be selected
  // without being clicked — keep it in view when the strip has to scroll.
  useEffect(() => {
    strip.current?.querySelector('[aria-current="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [surface]);

  return (
    <div className="@container flex flex-col h-full">
      {/* Activity sits OUTSIDE the scrolling strip. It used to be pinned right
          by `ml-auto`, which worked only while the tabs fit; once Proteus can
          append its own, the strip overflows and an `ml-auto` button scrolls
          away with everything else. */}
      <div className="border-b p-border shrink-0 flex items-stretch">
        {/* Six labelled surfaces need ~600px. Below that the switcher condenses
            to icons and only the current surface keeps its word, so the row
            stays one thin line instead of clipping a label; the strip still
            scrolls as the last resort. */}
        <div ref={strip} className="p-tabstrip flex items-center min-w-0 flex-1 px-2 gap-0.5 -mb-px">
          {SURFACES.map((s) => {
            const Icon = SURFACE_ICON[s];
            // Live-port badge lights Output ONLY — one home per signal.
            const badge = s === "Output" ? props.pinnedPorts.length
              : s === "Tasks" ? (props.runningTaskCount ?? 0)
              : s === "Brain" ? (props.changelogUnseen ?? 0) : 0;
            const badgeTone = s === "Tasks" ? "p-badge-warning"
              : s === "Brain" ? "p-accent-subtle p-accent"
              : "p-badge-success";
            return (
              <button key={s} onClick={() => onSurface(s)} title={s} aria-current={surface === s ? "true" : undefined}
                className={`px-2 @[38rem]:px-3 py-2.5 p-row-text font-medium transition-colors border-b-2 shrink-0 whitespace-nowrap flex items-center gap-1.5 cursor-pointer ${
                  surface === s ? "p-tab-active" : "p-text-3 border-transparent hover:p-text-2"
                }`}>
                <Icon size={14} /><span className={surface === s ? "" : "hidden @[38rem]:inline"}>{s}</span>
                {badge > 0 && (
                  <span className={`inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full text-[10px] font-semibold p-num ${badgeTone}`}>{badge}</span>
                )}
              </button>
            );
          })}
        {/* Proteus's own tabs, after ours and behind a divider. The sparkle is
            the marker: a tab in this group is agent-authored, and the divider
            is what stops it reading as one more thing we shipped. Titles are
            validated in core against RESERVED_VIEW_TITLES, so none of them can
            wear a host surface's name. */}
        {(props.agentViews ?? []).length > 0 && (
          <span aria-hidden className="self-center h-4 w-px mx-1.5 shrink-0" style={{ background: "var(--c-border)" }} />
        )}
        {(props.agentViews ?? []).map((view) => {
          const kind = agentViewSurface(view.slug);
          return (
            <button key={view.slug} onClick={() => onSurface(kind)}
              title={`${view.title} — written by Proteus`}
              aria-current={surface === kind ? "true" : undefined}
              className={`px-2 @[38rem]:px-3 py-2.5 p-row-text font-medium transition-colors border-b-2 shrink-0 whitespace-nowrap flex items-center gap-1.5 cursor-pointer ${
                surface === kind ? "p-tab-active" : "p-text-3 border-transparent hover:p-text-2"
              }`}>
              <SparkleIcon size={14} />
              <span className={surface === kind ? "" : "hidden @[38rem]:inline"}>{view.title}</span>
            </button>
          );
        })}
        </div>
        <button
          onClick={() => onSurface(ACTIVITY_SURFACE)}
          aria-label="Activity"
          title="Activity — context, cost and cache"
          className={`px-2.5 py-2.5 -mb-px transition-colors border-b-2 shrink-0 cursor-pointer ${
            surface === ACTIVITY_SURFACE ? "p-tab-active" : "p-text-3 border-transparent hover:p-text-2"
          }`}>
          <GaugeIcon size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 min-h-0">
        <ErrorBoundary key={surface} label={surface}>
          {surface === "Output" && <OutputSurface pinnedPorts={props.pinnedPorts} executors={props.executors} lastActiveExecutor={props.lastActiveExecutor} rpc={props.rpc} />}
          {surface === "Brain" && (
            <BrainSurface
              agentStatus={props.agentStatus} tools={props.tools}
              memory={props.memory} memoryContent={props.memoryContent}
              onSearchMemory={props.onSearchMemory} rpc={props.rpc}
              onChangelogSeen={props.onChangelogSeen}
            />
          )}
          {surface === "Reasoning" && <ReasoningSurface mctsTree={props.mctsTree} isStreaming={props.isStreaming} rpc={props.rpc} />}
          {surface === "Releases" && <ReleasesSurface rpc={props.rpc} />}
          {surface === "Tasks" && <TasksSurface jobs={props.backgroundJobs} onRefresh={props.onRefreshTasks} rpc={props.rpc} />}
          {surface === "Environment" && (
            <EnvironmentSurface
              rpc={props.rpc}
              executors={props.executors}
              executorOutputs={props.executorOutputs}
              lastActiveExecutor={props.lastActiveExecutor}
              onExecute={props.onExecute}
              pinnedPorts={props.pinnedPorts}
            />
          )}
          {surface === ACTIVITY_SURFACE && <ActivitySurface rpc={props.rpc} isStreaming={props.isStreaming} />}
          {agentViewSlug(surface) !== null && <AgentViewSurface slug={agentViewSlug(surface)!} rpc={props.rpc} />}
        </ErrorBoundary>
      </div>
    </div>
  );
}
