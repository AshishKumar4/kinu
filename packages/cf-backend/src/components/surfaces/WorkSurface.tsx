/**
 * Work Surface — Column C of the RUN altitude. A thin segmented switcher over
 * the agent's pinned work surfaces (Output · Brain · Reasoning · Devices),
 * NOT a row of co-equal debug tabs. The Run Timeline (Column B) drives which
 * surface is active; this owns the switcher chrome + dispatch.
 */
import {
  MonitorIcon, BrainIcon, TreeStructureIcon, DesktopTowerIcon, ClockIcon, GitDiffIcon,
} from "@phosphor-icons/react";
import ExecutorsPanel from "@/components/ExecutorsPanel";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { AgentStatus, ExecutorOutput } from "@/hooks/use-proteus";
import type { ToolInfo, MemoryEntry, MCTSNode, BackgroundJob, Rpc } from "@/lib/protocol";
import { OutputSurface, type PinnedPort } from "./OutputSurface";
import { BrainSurface } from "./BrainSurface";
import { ReasoningSurface } from "./ReasoningSurface";
import { TasksSurface } from "./TasksSurface";
import { ProductChangesSurface } from "./ProductChangesSurface";

export const SURFACES = ["Output", "Brain", "Reasoning", "Product", "Tasks", "Devices"] as const;
export type SurfaceKind = (typeof SURFACES)[number];

const SURFACE_ICON: Record<SurfaceKind, React.ComponentType<{ size?: number }>> = {
  Output: MonitorIcon,
  Brain: BrainIcon,
  Reasoning: TreeStructureIcon,
  Product: GitDiffIcon,
  Tasks: ClockIcon,
  Devices: DesktopTowerIcon,
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
  // Devices (ExecutorsPanel)
  executors: Array<{ name: string; kind: string; capabilities: string[]; available: boolean }>;
  executorOutputs: Map<string, ExecutorOutput[]>;
  lastActiveExecutor?: string | null;
  onExecute: (id: string, cmd: string) => Promise<{ stdout?: string; stderr?: string; exitCode?: number; error?: string }>;
  agentName?: string;
  // Background tasks (Tasks surface) + live running count for its tab badge.
  backgroundJobs: BackgroundJob[];
  runningTaskCount?: number;
  onRefreshTasks: () => void;
  rpc: Rpc;
}

export function WorkSurface(props: WorkSurfaceProps) {
  const { surface, onSurface } = props;
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center border-b p-border px-2 gap-0.5 shrink-0">
        {SURFACES.map((s) => {
          const Icon = SURFACE_ICON[s];
          const badge = (s === "Output" || s === "Devices") ? props.pinnedPorts.length
            : s === "Tasks" ? (props.runningTaskCount ?? 0) : 0;
          const badgeTone = s === "Tasks" ? "bg-amber-500/20 text-amber-300" : "bg-emerald-500/20 text-emerald-300";
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
            />
          )}
          {surface === "Reasoning" && <ReasoningSurface mctsTree={props.mctsTree} rpc={props.rpc} />}
          {surface === "Product" && <ProductChangesSurface rpc={props.rpc} />}
          {surface === "Tasks" && <TasksSurface jobs={props.backgroundJobs} onRefresh={props.onRefreshTasks} rpc={props.rpc} />}
          {surface === "Devices" && (
            <div className="h-full -m-5">
              <ExecutorsPanel
                executors={props.executors}
                outputs={props.executorOutputs}
                onExecute={props.onExecute}
                agentName={props.agentName}
                rpc={props.rpc}
                pinnedPorts={props.pinnedPorts}
              />
            </div>
          )}
        </ErrorBoundary>
      </div>
    </div>
  );
}
