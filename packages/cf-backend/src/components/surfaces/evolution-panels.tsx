import { useState, useCallback, useEffect, useRef } from "react";
import { Loader } from "@cloudflare/kumo";
import { DatabaseIcon, GaugeIcon } from "@phosphor-icons/react";
import { scoreInterval, type QualityDay } from "@kinu.run/core";
import type { Rpc } from "@kinu.run/core";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { EmptyState, Metric } from "./shared";

interface GepaRunRow { runId: string; target: string; startedAt: number; status: string; winnerId: string | null; iterations: number; metricCalls: number }

interface GepaCandidate { id: string; parentId: string | null; aggregateScore: number; scores: Record<string, number>; createdAt: number }

interface GepaRunDetail { run: GepaRunRow | null; candidates: GepaCandidate[]; pareto: Array<{ candidateId: string; instanceId: string; score: number }> }

function runDot(status: string): string {
  if (status === "completed") return "p-dot-success";

  if (status === "running") return "p-dot-warning";

  return "p-dot-neutral";
}

export function GepaView({ rpc }: { rpc: Rpc }) {
  const [sel, setSel] = useState<string | null>(null);
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
          <button key={r.runId} onClick={() => setSel(r.runId)}
            className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors ${sel === r.runId ? "p-fill" : "p-card-hover"}`}>
            <span className={`size-1.5 rounded-full shrink-0 ${runDot(r.status)}`} />
            <span className="p-row-text p-text-2 flex-1 truncate">{r.target} · {r.iterations} iters · {r.metricCalls} evals</span>
            <span className="p-meta p-text-3 shrink-0">{new Date(r.startedAt).toLocaleDateString()}</span>
          </button>
        ))}
      </div>
      {sel !== null && <GepaRunCandidates rpc={rpc} runId={sel} />}
    </div>
  );
}

/** The selected run's candidates, read for that run: a slower answer for a run no longer selected is never shown. */
function GepaRunCandidates({ rpc, runId }: { rpc: Rpc; runId: string }) {
  const load = useCallback(() => rpc<GepaRunDetail>("getGepaRun", [runId]), [rpc, runId]);
  const { resource, reload } = useAsyncResource(load, undefined, runId);
  const detail = lastValue(resource);

  if (detail === null) {
    return resource.status === "error"
      ? <LoadFailure what="this run's candidates" message={resource.message} onRetry={reload} />
      : <div className="flex justify-center py-4"><Loader size="sm" /></div>;
  }

  const paretoIds = new Set(detail.pareto.map((p) => p.candidateId));
  const maxAgg = Math.max(0.0001, ...detail.candidates.map((c) => c.aggregateScore));

  return (
    <div className="space-y-2">
      <div className="p-meta p-text-3">{detail.candidates.length} candidates · {paretoIds.size} on the Pareto front · winner {detail.run?.winnerId?.slice(0, 8) ?? "—"}</div>
      <div className="space-y-1">
        {detail.candidates.map((c) => {
          const onPareto = paretoIds.has(c.id);
          const isWinner = detail.run?.winnerId === c.id;
          // The interval keeps candidates from being read apart on a gap the eval set cannot resolve.
          const ci = scoreInterval(Object.values(c.scores));
          const barTone = onPareto ? "p-dot-info" : "p-dot-neutral";

          return (
            <div key={c.id} className="flex items-center gap-2 p-meta">
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


// Satisfaction per day (`getQuality`, evolution/ratings.ts): the mean rating 1-5 with its 95% interval. `moved`: its
// `reads_changed` count.
export function QualityView({ rpc, moved }: { rpc: Rpc; moved: number }) {
  const load = useCallback(() => rpc<QualityDay[]>("getQuality", [30]), [rpc]);
  const { resource, reload } = useAsyncResource(load);
  const days = lastValue(resource);
  const readMoved = useRef(moved);

  useEffect(() => {
    if (readMoved.current === moved) return;
    readMoved.current = moved;
    reload();
  }, [moved, reload]);

  if (days === null) {
    if (resource.status === "error") return <LoadFailure what="the quality history" message={resource.message} onRetry={reload} />;

    return <div className="flex justify-center py-8" role="status"><Loader size="sm" /><span className="sr-only">Loading quality history</span></div>;
  }

  const rated = days.filter((day) => day.rated > 0);

  if (rated.length === 0) {
    return <EmptyState icon={<GaugeIcon size={28} />} title="No rated turns yet" hint="A turn is rated from your reply to it, or by your thumbs." />;
  }

  const week = days.slice(-7);
  const weekScores = week.reduce((sum, day) => sum + day.satisfaction.mean * day.rated, 0);
  const weekRated = week.reduce((sum, day) => sum + day.rated, 0);
  const weekTurns = week.reduce((sum, day) => sum + day.turns, 0);
  const weekThumbs = week.reduce((sum, day) => sum + day.thumbs, 0);
  const weekCorrected = week.reduce((sum, day) => sum + day.corrected.mean * day.rated, 0);

  return (
    <div className="space-y-4 animate-fade-in overflow-y-auto h-full">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Metric label="Satisfaction, 7 days" value={weekRated === 0 ? "—" : `${(weekScores / weekRated).toFixed(2)} / 5`} />
        <Metric label="Corrected" value={weekRated === 0 ? "—" : `${Math.round((weekCorrected / weekRated) * 100)}%`} />
        <Metric label="Turns rated" value={`${weekRated} of ${weekTurns}`} />
        <Metric label="By your thumbs" value={`${weekThumbs}`} />
      </div>

      <section className="space-y-1.5">
        <div className="p-eyebrow">Satisfaction per day</div>
        <SatisfactionSparkline days={rated} />
      </section>

      <section className="space-y-1">
        {[...rated].reverse().map((day) => (
          <div key={day.day} className="flex items-center gap-2 p-meta"
            title={`95% CI ${day.satisfaction.lo.toFixed(2)}–${day.satisfaction.hi.toFixed(2)} over ${day.rated} rated turns`}>
            <span className="p-text-3 shrink-0 w-20 tabular-nums">{day.day}</span>
            <div className="flex-1 h-2 rounded-full p-fill relative overflow-hidden">
              <div className="absolute inset-y-0 p-dot-info opacity-40" style={{
                left: `${toUnit(day.satisfaction.lo) * 100}%`,
                width: `${Math.max(1, (toUnit(day.satisfaction.hi) - toUnit(day.satisfaction.lo)) * 100)}%`,
              }} />
              <div className={`absolute inset-y-0 w-0.5 ${toneOf(day.satisfaction.mean)}`} style={{ left: `${toUnit(day.satisfaction.mean) * 100}%` }} />
            </div>
            <span className="font-mono p-text-3 tabular-nums shrink-0 w-10 text-right">{day.satisfaction.mean.toFixed(2)}</span>
            <span className="hidden sm:inline p-text-3 tabular-nums shrink-0 w-24 text-right">{day.rated}/{day.turns} rated · {Math.round(day.corrected.mean * 100)}% corrected</span>
          </div>
        ))}
      </section>
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

// Non-scaling stroke keeps the path crisp under preserveAspectRatio="none".
function SatisfactionSparkline({ days }: { days: QualityDay[] }) {
  const W = 100, H = 32, pad = 2;
  const n = days.length;
  const x = (i: number) => n <= 1 ? W / 2 : pad + (i / (n - 1)) * (W - 2 * pad);
  const y = (score: number) => pad + (1 - toUnit(score)) * (H - 2 * pad);
  const line = days.map((day, i) => `${x(i).toFixed(2)},${y(day.satisfaction.mean).toFixed(2)}`).join(" ");

  const band = [
    ...days.map((day, i) => `${x(i).toFixed(2)},${y(day.satisfaction.hi).toFixed(2)}`),
    ...[...days].reverse().map((day, i) => `${x(n - 1 - i).toFixed(2)},${y(day.satisfaction.lo).toFixed(2)}`),
  ].join(" ");

  return (
    <div className="rounded-lg border p-border p-surface p-2">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-24">
        {n > 1 && <polygon points={band} fill="var(--c-accent)" opacity={0.14} />}
        {n > 1 && <polyline points={line} fill="none" stroke="var(--c-accent)" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
        {days.map((day, i) => (
          <circle key={day.day} cx={x(i)} cy={y(day.satisfaction.mean)} r={1.4} fill="var(--c-accent)" vectorEffect="non-scaling-stroke">
            <title>{`${day.day} · ${day.satisfaction.mean.toFixed(2)} / 5 (95% CI ${day.satisfaction.lo.toFixed(2)}–${day.satisfaction.hi.toFixed(2)}) · ${day.rated} rated`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}
