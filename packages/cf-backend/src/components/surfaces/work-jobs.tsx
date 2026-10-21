/** Background jobs (auto-detached >30s tool calls) as Work cards, with cancel, retry and dismiss. */
import { Effect } from 'effect';
import { useState, useCallback } from "react";
import { Button } from "@/components/ui/Button";
import {
  XCircleIcon, ArrowClockwiseIcon, TrashIcon, CheckCircleIcon,
  WarningCircleIcon, ProhibitIcon, SpinnerGapIcon, BroadcastIcon,
} from "@phosphor-icons/react";
import type { BackgroundJob } from "@kinu.run/core/protocol";
import { jobName, jobPhase, lastOutputLines, shortJobId, timeAgo, type InspectedWork } from "@kinu.run/core";
import { showing, detach } from "@kinu.run/core/obs";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";
import { toneInk, type StatusTone } from "@/components/ui/Status";
import { GroupBlock } from "@/components/ui/Group";

/** How a background job stands, here and on the operator's drilldown: running is live; serving is healthy. */
export const JOB_TONE = {
  running: "live", serving: "success", completed: "success", failed: "danger", cancelled: "neutral",
} satisfies Record<BackgroundJob["status"], StatusTone>;

function statusMeta(status: BackgroundJob["status"]) {
  const tone = toneInk(JOB_TONE[status]);

  switch (status) {
    case "running": return { icon: SpinnerGapIcon, tone, spin: true, label: "Running" };
    case "serving": return { icon: BroadcastIcon, tone, spin: false, label: "Serving" };
    case "completed": return { icon: CheckCircleIcon, tone, spin: false, label: "Completed" };
    case "failed": return { icon: WarningCircleIcon, tone, spin: false, label: "Failed" };
    case "cancelled": return { icon: ProhibitIcon, tone, spin: false, label: "Cancelled" };
  }
}

/**
 * The durable resume count of a job still running, in the owner's words (the operator's drilldown keeps its own terse
 * count). Null when there is nothing to say: a settled job speaks only through its one recorded outcome, its result or
 * its error, which says whether the work was lost.
 */
function interruptionNote(job: BackgroundJob, now: number): string | null {
  const attempts = job.epoch;

  if (attempts === 0 || job.status !== "running") return null;
  const times = attempts === 1 ? "once" : `${attempts} times`;

  const waiting = job.resumeAfter != null && job.resumeAfter > now
    ? ` Next attempt ${timeUntil(job.resumeAfter - now)}.`
    : "";

  return `Interrupted and re-driven ${times}. The work was not lost.${waiting}`;
}

function lastOutput(output: BackgroundJob["output"]): string | null {
  return lastOutputLines(output, OUTPUT_LINES).join("\n") || null;
}

const OUTPUT_LINES = 4;

/** Rounded up, so a wait that exists never reads as "in 0s". */
function timeUntil(ms: number): string {
  const seconds = Math.ceil(ms / 1000);

  if (seconds < 60) return `in ${seconds}s`;

  return `in ${Math.ceil(seconds / 60)}m`;
}

/** A turn or effect still owed, as its own store records it: what it is, how it stands, and why or until when. */
export function InspectedRow({ work, now }: { work: InspectedWork; now: number }) {
  const notes = [
    work.phase,
    work.attempt !== null && work.attempt > 1 ? `attempt ${String(work.attempt)}` : null,
    work.blocked,
    work.until !== null && work.until > now ? `next try ${timeUntil(work.until - now)}` : null,
  ].filter((note) => note !== null);

  return (
    <div className="flex items-start gap-2 py-1" data-inspected={work.kind} data-phase={work.phase}>
      <span className="t-body">{work.actor === null ? work.label : `${work.actor} · ${work.label}`} <span className="p-text-3">· {notes.join(" · ")}</span></span>
    </div>
  );
}

interface JobCardProps {
  job: BackgroundJob;
  grouped?: boolean;
  /** Re-fetch after a mutation; the hook also polls on its own cadence. */
  onRefresh: () => void;
  rpc: WorkspaceRpc;
}


export function JobCard({ job, grouped = false, onRefresh, rpc }: JobCardProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const act = useCallback((method: "cancelBackgroundJob" | "retryBackgroundJob" | "dismissBackgroundJob") => detach(Effect.gen(function* () {
    setBusy(true);
    setErr(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      const outcome = yield* Effect.promise(async () => rpc(method, [job.id]));

      if (!outcome.ok) {
        setErr(("error" in outcome ? outcome.error : undefined) ?? `${method.replace("BackgroundJob", "")} was refused`);

        return;
      }

      onRefresh();
    }), showing((chain) => {
      setErr(`${method.replace("BackgroundJob", "")} failed: ${chain}`);
    })), Effect.sync(() => { setBusy(false); }));
  })), [rpc, onRefresh, job.id]);

  const m = statusMeta(job.status);
  const Icon = m.icon;
  const live = jobPhase(job, Date.now()) !== "settled";
  const detail = job.status === "completed" ? job.result : job.error;
  const printed = live ? lastOutput(job.output) : null;
  const name = jobName(job);
  const interrupted = interruptionNote(job, Date.now());

  return (
    <GroupBlock grouped={grouped} className="p-3">
      <div className="grid grid-cols-[var(--layout-mark-row-end)] items-start gap-2">
        <Icon size={15} className={`${m.tone} shrink-0 mt-px ${m.spin ? "animate-spin" : ""}`}
          weight={live ? "bold" : "fill"} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="t-item p-text truncate" title={name.title}>{name.title}</span>
            <code className="t-meta t-mono p-text-3 shrink-0">{name.shortId}</code>
          </div>
          <div className="t-meta p-text-3">
            {m.label} · started {timeAgo(job.createdAt)}{job.settledAt ? ` · settled ${timeAgo(job.settledAt)}` : ""}
          </div>
          {interrupted && (
            <div className="t-status p-warning">{interrupted}</div>
          )}
          {job.retriedBy && (
            <div className="t-meta t-mono mt-1 p-accent-fg">
              Retried as {shortJobId(job.retriedBy)}
            </div>
          )}
          {printed && <pre className="t-meta t-mono p-text-2 mt-1 whitespace-pre-wrap break-words" aria-label="Latest output">{printed}</pre>}
          {detail && <div className="t-meta t-mono p-text-2 mt-1 line-clamp-3 whitespace-pre-wrap break-words">{detail}</div>}
          {err && <div className="t-status p-danger mt-1">{err}</div>}
        </div>
        <div className="grid auto-cols-max grid-flow-col items-center gap-1 justify-self-end">
          {live ? (
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
    </GroupBlock>
  );
}
