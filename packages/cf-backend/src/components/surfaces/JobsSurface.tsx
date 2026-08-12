/**
 * Jobs surface — inspect & manage background jobs (auto-detached >30s tool
 * calls: think-heads, long execute_tools / run). Lists every job with its
 * status + result/error, and the operator controls the user asked for:
 * hard-cancel a running job, retry / dismiss a settled one, clear all settled.
 *
 * This is what the Tasks tab used to show. It was never a to-do list — a job
 * has a jobId, a status and a result — and the Tasks tab now holds the agent's
 * actual task list, so the two concepts stopped sharing one name.
 *
 * Self-contained: owns its fetch + a light poll (running jobs progress) +
 * the lifecycle RPCs. The Supervise altitude cross-links here.
 */
import { useState, useCallback } from "react";
import { Button, Badge } from "@cloudflare/kumo";
import {
  ClockIcon, XCircleIcon, ArrowClockwiseIcon, TrashIcon, CheckCircleIcon,
  WarningCircleIcon, ProhibitIcon, SpinnerGapIcon,
} from "@phosphor-icons/react";
import type { Rpc, BackgroundJob } from "@/lib/protocol";
import { EmptyState } from "./shared";

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function statusMeta(status: BackgroundJob["status"]) {
  switch (status) {
    case "running": return { icon: SpinnerGapIcon, tone: "p-warning", spin: true, label: "Running" };
    case "completed": return { icon: CheckCircleIcon, tone: "p-success", spin: false, label: "Completed" };
    case "failed": return { icon: WarningCircleIcon, tone: "p-danger", spin: false, label: "Failed" };
    case "cancelled": return { icon: ProhibitIcon, tone: "p-text-3", spin: false, label: "Cancelled" };
  }
}

export interface JobsSurfaceProps {
  jobs: BackgroundJob[];
  /** Re-fetch after a mutation; the hook also polls on its own cadence. */
  onRefresh: () => void;
  rpc: Rpc;
}

export function JobsSurface({ jobs, onRefresh, rpc }: JobsSurfaceProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const act = useCallback(async (id: string, method: string) => {
    setBusyId(id);
    setErr(null);
    try { await rpc(method, [id]); onRefresh(); }
    catch (e) { setErr(`${method.replace("BackgroundJob", "")} failed: ${(e as Error).message}`); }
    finally { setBusyId(null); }
  }, [rpc, onRefresh]);

  const clearSettled = useCallback(async () => {
    setErr(null);
    try { await rpc("clearBackgroundJobs", []); onRefresh(); }
    catch (e) { setErr(`clear failed: ${(e as Error).message}`); }
  }, [rpc, onRefresh]);

  if (jobs.length === 0) {
    return <EmptyState icon={<ClockIcon size={28} />} title="No background jobs"
      hint="When a tool call runs longer than 30s (parallel thinking, long commands), it detaches here and the agent is woken with the result. You can cancel, retry, or dismiss them." />;
  }

  const running = jobs.filter((j) => j.status === "running").length;
  const settled = jobs.length - running;

  return (
    <div className="space-y-3 animate-fade-in">
      <div className="flex items-center gap-2">
        <span className="text-xs p-text-2 font-medium">{jobs.length} job{jobs.length === 1 ? "" : "s"}</span>
        {running > 0 && <Badge variant="secondary">{running} running</Badge>}
        <div className="flex-1" />
        {settled > 0 && (
          <Button size="sm" variant="ghost" onClick={clearSettled}>
            <TrashIcon size={13} /><span className="ml-1">Clear settled</span>
          </Button>
        )}
      </div>

      {err && <div className="text-xs p-danger p-card rounded-lg px-3 py-2">{err}</div>}

      <div className="space-y-2">
        {jobs.map((j) => {
          const m = statusMeta(j.status);
          const Icon = m.icon;
          const detail = j.status === "completed" ? j.result : j.error;
          const isBusy = busyId === j.id;
          return (
            <div key={j.id} className="p-card rounded-lg p-3">
              <div className="flex items-start gap-2">
                <Icon size={15} className={`${m.tone} shrink-0 mt-0.5 ${m.spin ? "animate-spin" : ""}`} weight={j.status === "running" ? "bold" : "fill"} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium p-text">{j.kind}</span>
                    <code className="text-[10px] p-text-3">{j.id.replace(/^bgjob-/, "").slice(0, 8)}</code>
                  </div>
                  <div className="text-[10px] p-text-3">{m.label} · started {timeAgo(j.createdAt)}{j.settledAt ? ` · settled ${timeAgo(j.settledAt)}` : ""}</div>
                  {detail && <div className="text-[10px] p-text-2 mt-1 line-clamp-3 whitespace-pre-wrap break-words font-mono">{detail}</div>}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {j.status === "running" ? (
                    <Button size="sm" variant="ghost" disabled={isBusy} onClick={() => act(j.id, "cancelBackgroundJob")} title="Hard-cancel — aborts the underlying work">
                      <XCircleIcon size={13} /><span className="ml-1">Cancel</span>
                    </Button>
                  ) : (
                    <>
                      <Button size="sm" variant="ghost" disabled={isBusy} onClick={() => act(j.id, "retryBackgroundJob")} title="Re-run with the same input">
                        <ArrowClockwiseIcon size={13} />
                      </Button>
                      <Button size="sm" variant="ghost" disabled={isBusy} onClick={() => act(j.id, "dismissBackgroundJob")} title="Dismiss">
                        <TrashIcon size={13} />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
