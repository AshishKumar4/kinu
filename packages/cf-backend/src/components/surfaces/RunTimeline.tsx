/**
 * Run Timeline — the scrubbable typed-span spine (Column B of the RUN
 * altitude). Renders the server-merged getRunTimeline() stream as one nested,
 * color-coded feed: LLM turns, tool/runtime calls, MCTS, scaffold, shadow-eval,
 * heads, GEPA, craft, reflection, curriculum, triggers, and first-class
 * failure spans (error/abort/recovery). Clicking a span drives the work
 * surface (Column C). A Follow toggle pins to the live frontier.
 */
import { useEffect, useRef } from "react";
import {
  SparkleIcon, WrenchIcon, TerminalIcon, TreeStructureIcon, GitBranchIcon,
  PackageIcon, BrainIcon, ArrowsClockwiseIcon, WarningCircleIcon, BookOpenIcon,
  GraduationCapIcon, LightningIcon, DatabaseIcon, ClockIcon, ProhibitIcon,
  ScalesIcon, GitMergeIcon,
} from "@phosphor-icons/react";
import type { TimelineSpan, TimelineKind } from "@/lib/protocol";

type KindMeta = { icon: React.ComponentType<{ size?: number; weight?: "regular" | "bold" | "fill" }>; tone: string };

// tone = a tailwind text colour class; kept muted + on-brand (accent for
// reasoning, red for failure, amber for recovery/scaffold churn).
const KIND_META: Record<TimelineKind, KindMeta> = {
  "llm-turn": { icon: SparkleIcon, tone: "text-purple-400" },
  "tool-call": { icon: WrenchIcon, tone: "p-text-2" },
  "runtime-exec": { icon: TerminalIcon, tone: "text-emerald-400" },
  "mcts": { icon: TreeStructureIcon, tone: "text-sky-400" },
  "scaffold": { icon: GitBranchIcon, tone: "text-amber-400" },
  "shadow-eval": { icon: ScalesIcon, tone: "text-amber-300" },
  "craft": { icon: PackageIcon, tone: "text-teal-400" },
  "reflection": { icon: BrainIcon, tone: "text-purple-300" },
  "head-split": { icon: GitBranchIcon, tone: "text-indigo-400" },
  "head-merge": { icon: GitMergeIcon, tone: "text-indigo-300" },
  "gepa": { icon: DatabaseIcon, tone: "text-fuchsia-400" },
  "skills": { icon: BookOpenIcon, tone: "text-cyan-400" },
  "curriculum": { icon: GraduationCapIcon, tone: "text-lime-400" },
  "trigger": { icon: LightningIcon, tone: "text-yellow-400" },
  "event-ingress": { icon: DatabaseIcon, tone: "p-text-3" },
  "error": { icon: WarningCircleIcon, tone: "text-red-400" },
  "abort": { icon: ProhibitIcon, tone: "text-red-400" },
  "recovery": { icon: ArrowsClockwiseIcon, tone: "text-amber-400" },
  "other": { icon: ClockIcon, tone: "p-text-3" },
};

function fmtElapsed(ms?: number): string {
  if (ms == null) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtClock(ts: number): string {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export interface RunTimelineProps {
  spans: TimelineSpan[];
  selectedRef?: string | null;
  onSelect?: (span: TimelineSpan) => void;
  follow: boolean;
  onToggleFollow: () => void;
}

export function RunTimeline({ spans, selectedRef, onSelect, follow, onToggleFollow }: RunTimelineProps) {
  const endRef = useRef<HTMLDivElement>(null);

  // Pin to the live frontier when Follow is on and a new span arrives.
  useEffect(() => {
    if (follow) endRef.current?.scrollIntoView({ block: "end" });
  }, [spans.length, follow]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b p-border shrink-0">
        <span className="text-xs font-medium p-text-2 flex items-center gap-1.5">
          <ClockIcon size={13} /> Run Timeline
        </span>
        <button
          onClick={onToggleFollow}
          className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
            follow ? "p-accent border-current" : "p-text-3 p-border hover:p-text-2"
          }`}
          title="Auto-scroll to the live frontier"
        >
          {follow ? "● Following" : "Follow"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-1 py-1.5">
        {spans.length === 0 ? (
          <div className="text-[11px] p-text-3 px-3 py-6 text-center">No activity yet.</div>
        ) : (
          <ol className="relative">
            {spans.map((s, i) => {
              const meta = KIND_META[s.kind] ?? KIND_META.other;
              const Icon = meta.icon;
              const selected = !!s.refId && s.refId === selectedRef;
              return (
                <li key={`${s.ts}-${i}`}>
                  <button
                    onClick={() => onSelect?.(s)}
                    className={`group w-full flex items-start gap-2 px-2 py-1 rounded-md text-left transition-colors ${
                      selected ? "p-elevated" : "hover:p-card"
                    }`}
                  >
                    <span className={`mt-0.5 shrink-0 ${meta.tone}`}><Icon size={14} weight="bold" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="text-xs p-text truncate">{s.label}</span>
                        {s.elapsedMs != null && (
                          <span className="text-[10px] p-text-3 tabular-nums shrink-0">{fmtElapsed(s.elapsedMs)}</span>
                        )}
                      </span>
                      {s.detail && <span className="block text-[10px] p-text-3 truncate">{s.detail}</span>}
                    </span>
                    <span className="text-[9px] p-text-3 tabular-nums shrink-0 opacity-0 group-hover:opacity-100">{fmtClock(s.ts)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
