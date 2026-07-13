/**
 * Work Surface — Column C of the RUN altitude. A thin segmented switcher over
 * the workspace's pinned work surfaces (Output · Brain · Reasoning · Product ·
 * Tasks · Environment), NOT a row of co-equal debug tabs. The Run Timeline
 * (Column B) drives which surface is active; this owns the switcher chrome +
 * dispatch.
 */
import {
  MonitorIcon, BrainIcon, TreeStructureIcon, ClockIcon, GitDiffIcon, StackIcon,
} from "@phosphor-icons/react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { AgentStatus, ExecutorOutput } from "@/hooks/use-proteus";
import type { ExecutorInfo } from "@/lib/executors";
import type { ToolInfo, MemoryEntry, MCTSNode, BackgroundJob, Rpc } from "@/lib/protocol";
import { OutputSurface, type PinnedPort } from "./OutputSurface";
import { BrainSurface } from "./BrainSurface";
import { ReasoningSurface } from "./ReasoningSurface";
import { TasksSurface } from "./TasksSurface";
import { EnvironmentSurface } from "./EnvironmentSurface";
import { ProductChangesSurface } from "./ProductChangesSurface";

export const SURFACES = ["Output", "Brain", "Reasoning", "Product", "Tasks", "Environment"] as const;
export type SurfaceKind = (typeof SURFACES)[number];

const SURFACE_ICON: Record<SurfaceKind, React.ComponentType<{ size?: number }>> = {
  Output: MonitorIcon,
  Brain: BrainIcon,
  Reasoning: TreeStructureIcon,
  Product: GitDiffIcon,
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
  rpc: Rpc;
}

export function WorkSurface(props: WorkSurfaceProps) {
  const { surface, onSurface } = props;
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center border-b p-border px-2 gap-0.5 shrink-0">
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
            <button key={s} onClick={() => onSurface(s)}
              className={`px-3 py-2.5 text-xs font-medium transition-colors border-b -mb-px flex items-center gap-1.5 ${
                surface === s ? "p-tab-active border-b-[1.5px]" : "p-text-2 border-transparent hover:p-text"
              }`}>
              <Icon size={13} /><span>{s}</span>
              {badge > 0 && (
                <span className={`inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full text-[10px] font-semibold ${badgeTone}`}>{badge}</span>
              )}
            </button>
          );
        })}
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
          {surface === "Reasoning" && <ReasoningSurface mctsTree={props.mctsTree} rpc={props.rpc} />}
          {surface === "Product" && <ProductChangesSurface rpc={props.rpc} />}
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
        </ErrorBoundary>
      </div>
    </div>
  );
}
