/** Background jobs (auto-detached >30s tool calls) as Work cards, with cancel, retry and dismiss. */
import { Effect } from 'effect';
import { useState, useCallback } from "react";
import { Button } from "@cloudflare/kumo";
import {
  XCircleIcon, ArrowClockwiseIcon, TrashIcon, CheckCircleIcon,
  WarningCircleIcon, ProhibitIcon, SpinnerGapIcon, BroadcastIcon,
} from "@phosphor-icons/react";
import type { Rpc } from "@kinu.run/core";
import type { BackgroundJob } from "@kinu.run/core/protocol";
import { jobName, jobPhase, lastOutputLines, shortJobId, timeAgo, type InspectedWork } from "@kinu.run/core";
import { showing, detach } from "@kinu.run/core/obs";

function statusMeta(status: BackgroundJob["status"]) {
  switch (status) {
    case "running": return { icon: SpinnerGapIcon, tone: "p-warning", spin: true, label: "Running" };
    case "serving": return { icon: BroadcastIcon, tone: "p-success", spin: false, label: "Serving" };
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
      <span className="p-row-text">{work.actor === null ? work.label : `${work.actor} · ${work.label}`} <span className="p-text-3">· {notes.join(" · ")}</span></span>
    </div>
  );
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

  const act = useCallback((method: string) => detach(Effect.gen(function* () {
    setBusy(true);
    setErr(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      const outcome = yield* Effect.promise(async () => rpc<JobControlOutcome>(method, [job.id]));

      if (!outcome.ok) {
        setErr(outcome.error ?? `${method.replace("BackgroundJob", "")} was refused`);

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
    <div className={grouped ? "p-3" : "p-group p-3"}>
      <div className="grid grid-cols-[15px_minmax(0,1fr)_auto] items-start gap-2">
        <Icon size={15} className={`${m.tone} shrink-0 mt-0.5 ${m.spin ? "animate-spin" : ""}`}
          weight={live ? "bold" : "fill"} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="p-row-text font-medium p-text truncate" title={name.title}>{name.title}</span>
            <code className="p-annotation p-text-3 shrink-0">{name.shortId}</code>
          </div>
          <div className="p-meta p-text-3">
            {m.label} · started {timeAgo(job.createdAt)}{job.settledAt ? ` · settled ${timeAgo(job.settledAt)}` : ""}
          </div>
          {interrupted && (
            <div className="p-t-status p-warning">{interrupted}</div>
          )}
          {job.retriedBy && (
            <div className="mt-1 p-annotation p-accent">
              Retried as {shortJobId(job.retriedBy)}
            </div>
          )}
          {printed && <pre className="p-annotation p-text-2 mt-1 whitespace-pre-wrap break-words font-mono" aria-label="Latest output">{printed}</pre>}
          {detail && <div className="p-annotation p-text-2 mt-1 line-clamp-3 whitespace-pre-wrap break-words">{detail}</div>}
          {err && <div className="p-t-status p-danger mt-1">{err}</div>}
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
    </div>
  );
}
