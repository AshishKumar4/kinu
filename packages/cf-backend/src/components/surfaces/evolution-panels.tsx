import { useState, useCallback, useEffect, useRef } from "react";
import { Loader } from "@cloudflare/kumo";
import { DatabaseIcon } from "@phosphor-icons/react";
import { scoreInterval, type QualityDay, type QualityWindow } from "@kinu.run/core";
import type { Rpc } from "@kinu.run/core";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { EmptyState } from "./shared";

interface GepaRunRow { runId: string; target: string; startedAt: number; status: string; winnerId: string | null; iterations: number; metricCalls: number }

interface GepaCandidate { id: string; parentId: string | null; aggregateScore: number; scores: Record<string, number>; createdAt: number }

interface GepaRunDetail { run: GepaRunRow | null; candidates: GepaCandidate[]; pareto: Array<{ candidateId: string; instanceId: string; score: number }> }

/** A running run is read again until it finishes. */
const runningAgain = (detail: GepaRunDetail | null): number | null => (detail?.run?.status === "running" ? 5000 : null);

function runDot(status: string): string {
  if (status === "completed") return "p-dot-success";

  if (status === "running") return "p-dot-warning";

  return "p-dot-neutral";
}

export function GepaView({ rpc }: { rpc: Rpc }) {
  const [sel, setSel] = useState<string | null>(null);
  // Each pick reads the run again: a running run's candidates and winner change under the same id.
  const [picks, setPicks] = useState(0);
  const load = useCallback(() => rpc<GepaRunRow[]>("getGepaRuns", [20]), [rpc]);
  const { resource, reload } = useAsyncResource(load);
  const runs = lastValue(resource);

  if (runs === null) {
    if (resource.status === "error") return <LoadFailure what="the self-tuning runs" message={resource.message} onRetry={reload} />;

    return <div className="flex justify-center py-8"><Loader size="sm" /></div>;
  }

  if (runs.length === 0) return <EmptyState icon={<DatabaseIcon size={28} />} title="No self-tuning runs yet" />;

  return (
    <div className="space-y-3 animate-fade-in overflow-y-auto h-full">
      <div className="space-y-1">
        {runs.map((r) => (
          <button key={r.runId} data-gepa-run={r.runId} aria-pressed={sel === r.runId} onClick={() => { setSel(r.runId); setPicks((made) => made + 1); }}
            className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors ${sel === r.runId ? "p-fill" : "p-card-hover"}`}>
            <span className={`size-1.5 rounded-full shrink-0 ${runDot(r.status)}`} />
            <span className="p-row-text p-text-2 flex-1 truncate">{r.target} · {r.iterations} iters · {r.metricCalls} evals</span>
            <span className="p-meta p-text-3 shrink-0">{new Date(r.startedAt).toLocaleDateString()}</span>
          </button>
        ))}
      </div>
      {sel !== null && <GepaRunCandidates rpc={rpc} runId={sel} pick={picks} />}
    </div>
  );
}

/** The selected run's candidates, read for that pick of it and again while it runs: a slower answer for a run no
 *  longer selected is never shown. */
function GepaRunCandidates({ rpc, runId, pick }: { rpc: Rpc; runId: string; pick: number }) {
  const load = useCallback(() => rpc<GepaRunDetail>("getGepaRun", [runId]), [rpc, runId]);
  const { resource, reload } = useAsyncResource(load, runningAgain, `${runId}:${String(pick)}`);
  const detail = lastValue(resource);

  if (detail === null) {
    return resource.status === "error"
      ? <LoadFailure what="this run's candidates" message={resource.message} onRetry={reload} />
      : <div className="flex justify-center py-4"><Loader size="sm" /></div>;
  }

  const paretoIds = new Set(detail.pareto.map((p) => p.candidateId));
  const maxAgg = Math.max(0.0001, ...detail.candidates.map((c) => c.aggregateScore));

  return (
    <div className="space-y-2" data-gepa-candidates={runId}>
      <div className="p-meta p-text-3">{detail.candidates.length} candidates · {paretoIds.size} on the Pareto front · winner {detail.run?.winnerId?.slice(0, 8) ?? "—"}</div>
      <div className="space-y-1">
        {detail.candidates.map((c) => {
          const onPareto = paretoIds.has(c.id);
          const isWinner = detail.run?.winnerId === c.id;
          // The interval keeps candidates from being read apart on a gap the eval set cannot resolve.
          const ci = scoreInterval(Object.values(c.scores));
          const barTone = onPareto ? "p-dot-info" : "p-dot-neutral";

          return (
            <div key={c.id} data-gepa-candidate={c.id} className="flex items-center gap-2 p-meta">
              <span className={`font-mono shrink-0 w-14 truncate ${isWinner ? "p-success" : "p-text-3"}`}>{c.id.slice(0, 8)}</span>
              <div className="flex-1 h-2 rounded-full p-fill overflow-hidden" title={`95% CI ${ci.lo.toFixed(2)}–${ci.hi.toFixed(2)} over ${ci.n} instances`}>
                <div className={`h-full ${isWinner ? "p-dot-success" : barTone}`} style={{ width: `${(c.aggregateScore / maxAgg) * 100}%` }} />
              </div>
              <span className="font-mono p-text-3 tabular-nums shrink-0 w-10 text-right">{c.aggregateScore.toFixed(2)}</span>
              <span className="hidden sm:inline font-mono p-text-3 tabular-nums shrink-0 w-20 text-right opacity-70">[{ci.lo.toFixed(2)}–{ci.hi.toFixed(2)}]</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}


/** A trend needs this many rated days to say anything. */
const TREND_DAYS = 3;

/** How it is doing: the last seven UTC days summed as core answers them (`getQualityWindow`), and the last thirty, one
 *  column a day, once enough of them were rated. `moved`: `getQuality`'s `reads_changed` count, which both reads track. */
export function QualityView({ rpc, moved }: { rpc: Rpc; moved: number }) {
  const load = useCallback(async () => {
    const [week, days] = await Promise.all([rpc<QualityWindow>("getQualityWindow", [7]), rpc<QualityDay[]>("getQuality", [30])]);

    return { week, days };
  }, [rpc]);

  const { resource, reload } = useAsyncResource(load);
  const read = lastValue(resource);
  const readMoved = useRef(moved);

  useEffect(() => {
    if (readMoved.current === moved) return;
    readMoved.current = moved;
    reload();
  }, [moved, reload]);

  if (read === null) {
    if (resource.status === "error") return <LoadFailure what="how it's doing" message={resource.message} onRetry={reload} />;

    return <div className="flex justify-center py-8" role="status"><Loader size="sm" /><span className="sr-only">Loading how it's doing</span></div>;
  }

  const { week, days } = read;
  const ratedDays = days.filter((day) => day.rated > 0).length;

  if (ratedDays === 0) return <p className="p-row-text p-text-3">No rated turns yet. Your reply to a turn rates it, and so does a thumb.</p>;

  const corrected = Math.round(week.corrected.mean * week.rated);
  const thumbs = week.thumbs > 0 ? `, ${String(week.thumbs)} by your thumbs` : "";

  return (
    <div className="space-y-3 animate-fade-in" data-quality-verdict>
      {week.rated === 0 ? (
        <p className="p-row-text p-text-3">No rated turns in the last 7 days.</p>
      ) : (
        <div className="flex items-baseline gap-2.5" title={`95% interval ${week.satisfaction.lo.toFixed(2)}–${week.satisfaction.hi.toFixed(2)}, ${week.from} to ${week.to} (UTC)`}>
          <span className={`size-2 shrink-0 self-center rounded-full ${toneOf(week.satisfaction.mean)}`} aria-hidden />
          <span className="shrink-0 whitespace-nowrap text-[20px] font-semibold leading-none tabular-nums p-text">
            {week.satisfaction.mean.toFixed(1)}<span className="text-[13px] font-normal p-text-3"> / 5</span>
          </span>
          <span className="min-w-0 p-meta p-text-3">
            over the last 7 days · {week.rated} of {week.turns} {week.turns === 1 ? "turn" : "turns"} rated{thumbs}
            {corrected > 0 ? ` · corrected ${String(corrected)} ${corrected === 1 ? "time" : "times"}` : ""}
          </span>
        </div>
      )}
      {ratedDays < TREND_DAYS
        ? <p className="p-meta p-text-4">A trend shows once three days have ratings.</p>
        : <SatisfactionDays days={days} />}
    </div>
  );
}

/** 1-5 onto [0, 1]. */
function toUnit(score: number): number {
  return Math.max(0, Math.min(1, (score - 1) / 4));
}

function toneOf(score: number): string {
  if (score >= 3.5) return "p-dot-success";

  if (score >= 2.5) return "p-dot-warning";

  return "p-dot-danger";
}

const TONE_INK = new Map([["p-dot-success", "var(--c-success)"], ["p-dot-warning", "var(--c-warning)"], ["p-dot-danger", "var(--c-danger)"]]);

/** The window's UTC days, one column each: a rated day's mean as a dot over its interval, an unrated day as a tick. */
function SatisfactionDays({ days }: { days: readonly QualityDay[] }) {
  const at = (score: number): string => `${String((1 - toUnit(score)) * 100)}%`;
  const label = (day: string): string => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

  return (
    <div className="p-card px-3 pt-3 pb-2">
      <div className="grid grid-cols-[14px_minmax(0,1fr)] gap-2">
        <div className="relative h-24 p-annotation p-text-4" aria-hidden>
          <span className="absolute top-0 -translate-y-1/2">5</span>
          <span className="absolute top-1/2 -translate-y-1/2">3</span>
          <span className="absolute bottom-0 translate-y-1/2">1</span>
        </div>
        <div className="relative h-24">
          <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-[var(--c-dash)]" />
          <div className="absolute inset-x-0 bottom-0 border-t p-border" />
          <div className="absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${String(days.length)}, minmax(0, 1fr))` }}>
            {days.map((day) => (
              <div key={day.day} className="relative"
                title={day.rated === 0 ? `${day.day}: no rated turns` : `${day.day}: ${day.satisfaction.mean.toFixed(2)} / 5 (95% interval ${day.satisfaction.lo.toFixed(2)}–${day.satisfaction.hi.toFixed(2)}) · ${String(day.rated)} of ${String(day.turns)} rated`}>
                {day.rated === 0 ? (
                  <span className="absolute bottom-0 left-1/2 h-1 w-px -translate-x-1/2 bg-[var(--c-border-strong)]" />
                ) : (
                  <>
                    <span className="absolute left-1/2 w-px -translate-x-1/2 opacity-50"
                      style={{ top: at(day.satisfaction.hi), bottom: `calc(100% - ${at(day.satisfaction.lo)})`, background: TONE_INK.get(toneOf(day.satisfaction.mean)) }} />
                    <span className="absolute left-1/2 size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full"
                      style={{ top: at(day.satisfaction.mean), background: TONE_INK.get(toneOf(day.satisfaction.mean)) }} />
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-1.5 flex justify-between pl-[22px] p-annotation p-text-4">
        <span>{label(days[0]?.day ?? "")}</span><span>{label(days.at(-1)?.day ?? "")}</span>
      </div>
    </div>
  );
}
