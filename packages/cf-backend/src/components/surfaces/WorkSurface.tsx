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
import { useEffect, useRef } from "react";
import {
  MonitorIcon, TreeStructureIcon, GitDiffIcon, StackIcon, GaugeIcon,
  PulseIcon, SparkleIcon, FingerprintIcon,
} from "@phosphor-icons/react";
import type { AgentViewSummary, PendingAction, PlanReview } from "@kinu/core";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { tabCls } from "@/components/ui/form";
import type { AgentStatus, ExecutorOutput } from "@/hooks/use-kinu";
import type { ExecutorInfo } from "@/lib/executors";
import type { ToolInfo, MemoryEntry, ForkNode, BackgroundJob, ExecutorCommandResult, Rpc } from "@/lib/protocol";
import { OutputSurface, type PinnedPort } from "./OutputSurface";
import { AgentSurface } from "./AgentSurface";
import { ExplorationSurface } from "./ExplorationSurface";
import { WorkTab } from "./WorkTab";
import { EnvironmentSurface } from "./EnvironmentSurface";
import { ReleasesSurface } from "./ReleasesSurface";
import { ActivitySurface } from "./ActivitySurface";
import { AgentViewSurface } from "./AgentViewSurface";

export const SURFACES = ["Output", "Work", "Releases", "Exploration", "Agent", "Environment"] as const;
/** Not one of the segmented work surfaces: Activity is about the run rather
 *  than a place to work in it, so it sits apart at the right of the strip and
 *  carries no label. */
export const ACTIVITY_SURFACE = "Activity";
/** Tabs Kinu wrote. Namespaced rather than mixed into the tuple above so a
 *  view can never collide with a host surface by picking its name, and so
 *  every render path can tell the two apart without a lookup. */
export type AgentViewSurfaceKind = `view:${string}`;
export type SurfaceKind = (typeof SURFACES)[number] | typeof ACTIVITY_SURFACE | AgentViewSurfaceKind;

export const agentViewSurface = (slug: string): AgentViewSurfaceKind => `view:${slug}`;
export const agentViewSlug = (surface: SurfaceKind): string | null =>
  surface.startsWith("view:") ? surface.slice("view:".length) : null;

const SURFACE_ICON = {
  Output: MonitorIcon,
  Work: PulseIcon,
  Releases: GitDiffIcon,
  Exploration: TreeStructureIcon,
  Agent: FingerprintIcon,
  Environment: StackIcon,
} satisfies Record<(typeof SURFACES)[number], React.ComponentType<{ size?: number }>>;

export interface WorkSurfaceProps {
  surface: SurfaceKind;
  onSurface: (s: SurfaceKind) => void;
  // Output
  pinnedPorts: PinnedPort[];
  previewError: string | null;
  onRefreshPorts: () => void;
  plan: PlanReview | null;
  // Agent
  agentStatus: AgentStatus | null;
  tools: ToolInfo[];
  memory: MemoryEntry[];
  memoryContent: string;
  onSearchMemory: (q: string) => void;
  // Exploration — the tree of the search in flight, pushed by the engine.
  mctsTrees: ReadonlyMap<string, ForkNode>;
  /** Per-branch journal-write counter, pushed by `head_activity` — what makes an
   *  open branch's transcript grow while that branch works. */
  headActivity: ReadonlyMap<string, number>;
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
  /** The changelog was seen inside Work — zero the unseen count upstream. */
  onChangelogSeen?: () => void;
  /** Dashboards Kinu published for this workspace. Appended after the host
   *  surfaces, in their own marked group. */
  agentViews?: AgentViewSummary[];
  rpc: Rpc;
}

export function WorkSurface(props: WorkSurfaceProps) {
  const { surface, onSurface } = props;
  const strip = useRef<HTMLDivElement>(null);

  // A surface can be selected without being clicked (a deep link, a restored
  // tab) — keep the current one in view when the strip has to scroll.
  useEffect(() => {
    strip.current?.querySelector('[aria-current="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [surface]);

  return (
    <div className="@container flex flex-col h-full">
      {/* Activity sits OUTSIDE the scrolling strip. It used to be pinned right
          by `ml-auto`, which worked only while the tabs fit; once Kinu can
          append its own, the strip overflows and an `ml-auto` button scrolls
          away with everything else. */}
      <div className="border-b p-border shrink-0 flex items-stretch">
        {/* Below the breakpoint the switcher condenses to icons and only the
            current surface keeps its word, so the row stays one thin line
            instead of clipping a label; the strip still scrolls as the last
            resort. Six labels reach lower than seven did — measured in the
            gallery, not guessed. */}
        <div ref={strip} className="p-tabstrip flex items-center min-w-0 flex-1 px-2 gap-0.5 -mb-px">
          {SURFACES.map((s) => {
            const Icon = SURFACE_ICON[s];
            // Two signals, two homes, two encodings: live ports light Output
            // green, and decisions waiting on the owner light Work in accent.
            // Liveness gets no digit — something merely running needs nobody,
            // and the chat header's pulsing pill already says it.
            const badge = s === "Output" ? props.pinnedPorts.length
              : s === "Work" ? props.pendingActions.length : 0;
            const badgeTone = s === "Work" ? "p-accent-subtle p-accent" : "p-badge-success";
            return (
              <button key={s} onClick={() => onSurface(s)} title={s} aria-current={surface === s ? "true" : undefined}
                className={`${tabCls} ${surface === s ? "p-tab-active" : ""}`}>
                <Icon size={14} /><span className={surface === s ? "" : "hidden @[34rem]:inline"}>{s}</span>
                {badge > 0 && (
                  <span className={`inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full text-[10px] font-semibold p-num ${badgeTone}`}>{badge}</span>
                )}
              </button>
            );
          })}
        {/* Kinu's own tabs, after ours and behind a divider. The sparkle is
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
              title={`${view.title} — written by Kinu`}
              aria-current={surface === kind ? "true" : undefined}
              className={`${tabCls} ${surface === kind ? "p-tab-active" : ""}`}>
              <SparkleIcon size={14} />
              <span className={surface === kind ? "" : "hidden @[34rem]:inline"}>{view.title}</span>
            </button>
          );
        })}
        </div>
        <button
          onClick={() => onSurface(ACTIVITY_SURFACE)}
          aria-label="Activity"
          title="Activity: context, cost and cache"
          className={`${tabCls} px-2.5 ${surface === ACTIVITY_SURFACE ? "p-tab-active" : ""}`}>
          <GaugeIcon size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 min-h-0">
        <ErrorBoundary key={surface} label={surface}>
          {surface === "Output" && <OutputSurface
            pinnedPorts={props.pinnedPorts}
            previewError={props.previewError}
            onRefreshPorts={props.onRefreshPorts}
            plan={props.plan}
            executors={props.executors}
            lastActiveExecutor={props.lastActiveExecutor}
            rpc={props.rpc}
          />}
          {surface === "Work" && (
            <WorkTab
              pendingActions={props.pendingActions}
              backgroundJobs={props.backgroundJobs}
              onRefreshJobs={props.onRefreshJobs}
              onOpenSurface={onSurface}
              onChangelogSeen={props.onChangelogSeen}
              isStreaming={props.isStreaming}
              rpc={props.rpc}
            />
          )}
          {surface === "Releases" && <ReleasesSurface rpc={props.rpc} executors={props.executors} />}
          {surface === "Exploration" && (
            <ExplorationSurface
              liveTrees={props.mctsTrees}
              headActivity={props.headActivity}
              isStreaming={props.isStreaming}
              backgroundJobs={props.backgroundJobs}
              rpc={props.rpc}
            />
          )}
          {surface === "Agent" && (
            <AgentSurface
              agentStatus={props.agentStatus} tools={props.tools}
              memory={props.memory} memoryContent={props.memoryContent}
              onSearchMemory={props.onSearchMemory} rpc={props.rpc}
            />
          )}
          {surface === "Environment" && (
            <EnvironmentSurface
              rpc={props.rpc}
              executors={props.executors}
              executorOutputs={props.executorOutputs}
              lastActiveExecutor={props.lastActiveExecutor}
              onExecute={props.onExecute}
            />
          )}
          {surface === ACTIVITY_SURFACE && <ActivitySurface rpc={props.rpc} isStreaming={props.isStreaming} />}
          {agentViewSlug(surface) !== null && <AgentViewSurface slug={agentViewSlug(surface)!} rpc={props.rpc} />}
        </ErrorBoundary>
      </div>
    </div>
  );
}
