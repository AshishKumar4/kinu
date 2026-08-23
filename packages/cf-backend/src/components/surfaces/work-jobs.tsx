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
import { renderThrownChain } from "@kinu.run/core/obs";

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
  /** Render inside the journal's shared grouped-row container. */
  grouped?: boolean;
  /** Re-fetch after a mutation; the hook also polls on its own cadence. */
  onRefresh: () => void;
  rpc: Rpc;
}

interface JobControlOutcome {
  readonly ok: boolean;
  readonly error?: string;
}

export function JobCard({ job, grouped = false, onRefresh, rpc }: JobCardProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const act = useCallback(async (method: string) => {
    setBusy(true);
    setErr(null);
    try {
      const outcome = await rpc<JobControlOutcome>(method, [job.id]);
      if (!outcome.ok) {
        setErr(outcome.error ?? `${method.replace("BackgroundJob", "")} was refused`);
        return;
      }
      onRefresh();
    }
    catch (error) {
      const message = renderThrownChain({ cause: error });
      setErr(`${method.replace("BackgroundJob", "")} failed: ${message}`);
    }
    finally { setBusy(false); }
  }, [rpc, onRefresh, job.id]);

  const m = statusMeta(job.status);
  const Icon = m.icon;
  const detail = job.status === "completed" ? job.result : job.error;

  return (
    <div className={grouped ? "p-3" : "p-group p-3"}>
      <div className="grid grid-cols-[15px_minmax(0,1fr)_auto] items-start gap-2">
        <Icon size={15} className={`${m.tone} shrink-0 mt-0.5 ${m.spin ? "animate-spin" : ""}`}
          weight={job.status === "running" ? "bold" : "fill"} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] leading-[18px] font-medium p-text">{job.kind}</span>
            <code className="text-[10px] p-text-3">{job.id.replace(/^bgjob-/, "").slice(0, 8)}</code>
          </div>
          <div className="text-[10.5px] leading-[15px] p-text-3">
            {m.label} · started {timeAgo(job.createdAt)}{job.settledAt ? ` · settled ${timeAgo(job.settledAt)}` : ""}
          </div>
          {job.retriedBy && (
            <div className="mt-1 font-mono text-[10px] p-gold">
              Retried as {job.retriedBy.replace(/^bgjob-/, "").slice(0, 8)}
            </div>
          )}
          {detail && <div className="text-[11.5px] leading-[16px] p-text-2 mt-1 line-clamp-3 whitespace-pre-wrap break-words font-mono">{detail}</div>}
          {err && <div className="text-[10px] p-danger mt-1">{err}</div>}
        </div>
        <div className="grid auto-cols-max grid-flow-col items-center gap-1 justify-self-end">
          {job.status === "running" ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("cancelBackgroundJob")}
              title="Hard-cancel, aborting the underlying work">
              <XCircleIcon size={13} /><span className="ml-1">Cancel</span>
            </Button>
          ) : (
            <>
              {!job.retriedBy && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("retryBackgroundJob")}
                  title="Re-run with the same input" aria-label="Retry">
                  <ArrowClockwiseIcon size={13} />
                </Button>
              )}
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
