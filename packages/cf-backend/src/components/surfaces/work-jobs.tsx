/**
 * Background jobs — auto-detached >30s tool calls (forks, long execute_tools /
 * run) — as cards in the Work surface, with the operator controls: hard-cancel
 * a running job, retry / dismiss a settled one.
 *
 * A job was never a to-do item, and it was never a separate question either: a
 * running job belongs beside the plan it is working through and a settled one
 * belongs in the journal beside everything else that finished. This file owns
 * the card and the lifecycle RPCs; the Work surface decides which half of it
 * a given job lands in.
 */
import { useState, useCallback } from "react";
import { Button } from "@cloudflare/kumo";
import {
  XCircleIcon, ArrowClockwiseIcon, TrashIcon, CheckCircleIcon,
  WarningCircleIcon, ProhibitIcon, SpinnerGapIcon,
} from "@phosphor-icons/react";
import type { Rpc, BackgroundJob } from "@/lib/protocol";
import { timeAgo } from "./shared";

function statusMeta(status: BackgroundJob["status"]) {
  switch (status) {
    case "running": return { icon: SpinnerGapIcon, tone: "p-warning", spin: true, label: "Running" };
    case "completed": return { icon: CheckCircleIcon, tone: "p-success", spin: false, label: "Completed" };
    case "failed": return { icon: WarningCircleIcon, tone: "p-danger", spin: false, label: "Failed" };
    case "cancelled": return { icon: ProhibitIcon, tone: "p-text-3", spin: false, label: "Cancelled" };
  }
}

export interface JobCardProps {
  job: BackgroundJob;
  /** Re-fetch after a mutation; the hook also polls on its own cadence. */
  onRefresh: () => void;
  rpc: Rpc;
}

export function JobCard({ job, onRefresh, rpc }: JobCardProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const act = useCallback(async (method: string) => {
    setBusy(true);
    setErr(null);
    try { await rpc(method, [job.id]); onRefresh(); }
    catch (e) { setErr(`${method.replace("BackgroundJob", "")} failed: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }, [rpc, onRefresh, job.id]);

  const m = statusMeta(job.status);
  const Icon = m.icon;
  const detail = job.status === "completed" ? job.result : job.error;

  return (
    <div className="p-card rounded-lg p-3">
      <div className="flex items-start gap-2">
        <Icon size={15} className={`${m.tone} shrink-0 mt-0.5 ${m.spin ? "animate-spin" : ""}`}
          weight={job.status === "running" ? "bold" : "fill"} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium p-text">{job.kind}</span>
            <code className="text-[10px] p-text-3">{job.id.replace(/^bgjob-/, "").slice(0, 8)}</code>
          </div>
          <div className="text-[10px] p-text-3">
            {m.label} · started {timeAgo(job.createdAt)}{job.settledAt ? ` · settled ${timeAgo(job.settledAt)}` : ""}
          </div>
          {detail && <div className="text-[10px] p-text-2 mt-1 line-clamp-3 whitespace-pre-wrap break-words font-mono">{detail}</div>}
          {err && <div className="text-[10px] p-danger mt-1">{err}</div>}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {job.status === "running" ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("cancelBackgroundJob")}
              title="Hard-cancel — aborts the underlying work">
              <XCircleIcon size={13} /><span className="ml-1">Cancel</span>
            </Button>
          ) : (
            <>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("retryBackgroundJob")}
                title="Re-run with the same input" aria-label="Retry">
                <ArrowClockwiseIcon size={13} />
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("dismissBackgroundJob")}
                title="Dismiss" aria-label="Dismiss">
                <TrashIcon size={13} />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
