/** Background jobs (auto-detached >30s tool calls) as Work cards, with cancel, retry and dismiss. */
import { useState, useCallback } from "react";
import { Button } from "@cloudflare/kumo";
import {
  XCircleIcon, ArrowClockwiseIcon, TrashIcon, CheckCircleIcon,
  WarningCircleIcon, ProhibitIcon, SpinnerGapIcon,
} from "@phosphor-icons/react";
import type { Rpc } from "@kinu.run/core";
import type { BackgroundJob } from "@kinu.run/core/protocol";
import { timeAgo } from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";

function statusMeta(status: BackgroundJob["status"]) {
  switch (status) {
    case "running": return { icon: SpinnerGapIcon, tone: "p-warning", spin: true, label: "Running" };
    case "completed": return { icon: CheckCircleIcon, tone: "p-success", spin: false, label: "Completed" };
    case "failed": return { icon: WarningCircleIcon, tone: "p-danger", spin: false, label: "Failed" };
    case "cancelled": return { icon: ProhibitIcon, tone: "p-text-3", spin: false, label: "Cancelled" };
  }
}

/** The durable resume count, shown nowhere else. Null when there is nothing to say. */
function interruptionNote(job: BackgroundJob, now: number): string | null {
  const attempts = job.resumeAttempts ?? 0;

  if (attempts === 0) return null;
  const times = attempts === 1 ? "once" : `${attempts} times`;

  const waiting = job.resumeAfter != null && job.resumeAfter > now
    ? ` Next attempt ${timeUntil(job.resumeAfter - now)}.`
    : "";

  return `Interrupted and re-driven ${times}. The work was not lost.${waiting}`;
}

/** Rounded up, so a wait that exists never reads as "in 0s". */
function timeUntil(ms: number): string {
  const seconds = Math.ceil(ms / 1000);

  if (seconds < 60) return `in ${seconds}s`;

  return `in ${Math.ceil(seconds / 60)}m`;
}

export interface JobCardProps {
  job: BackgroundJob;
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
  const interrupted = interruptionNote(job, Date.now());

  return (
    <div className={grouped ? "p-3" : "p-group p-3"}>
      <div className="grid grid-cols-[15px_minmax(0,1fr)_auto] items-start gap-2">
        <Icon size={15} className={`${m.tone} shrink-0 mt-0.5 ${m.spin ? "animate-spin" : ""}`}
          weight={job.status === "running" ? "bold" : "fill"} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="p-row-text font-medium p-text">{job.kind}</span>
            <code className="p-annotation p-text-3">{job.id.replace(/^bgjob-/, "").slice(0, 8)}</code>
          </div>
          <div className="p-meta p-text-3">
            {m.label} · started {timeAgo(job.createdAt)}{job.settledAt ? ` · settled ${timeAgo(job.settledAt)}` : ""}
          </div>
          {interrupted && (
            <div className="p-t-status p-warning">{interrupted}</div>
          )}
          {job.retriedBy && (
            <div className="mt-1 p-annotation p-accent">
              Retried as {job.retriedBy.replace(/^bgjob-/, "").slice(0, 8)}
            </div>
          )}
          {detail && <div className="p-annotation p-text-2 mt-1 line-clamp-3 whitespace-pre-wrap break-words">{detail}</div>}
          {err && <div className="p-t-status p-danger mt-1">{err}</div>}
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
