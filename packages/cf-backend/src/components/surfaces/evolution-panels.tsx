/**
 * Is the agent getting better? — the two measurements that answer it.
 *
 * GEPA runs produce CANDIDATES for the next scaffold version; the quality
 * scoreboard scores the live scaffold against graded turns and is keyed by
 * `scaffoldVersion` row by row. Both used to sit under Exploration, next to
 * the fork strategies, because the strategy code is adjacent — but nobody
 * comparing fork branches also wants a Wilson interval, and both of these are
 * about the agent's own trajectory across its versions. They live under
 * Agent → Evolution now, beside the lineage they measure.
 */
import { useState, useCallback } from "react";
import { Loader } from "@cloudflare/kumo";
import { DatabaseIcon, GaugeIcon } from "@phosphor-icons/react";
import {
  DEFAULT_QUALITY_THRESHOLD, describeCalibrationGap, lossInterval, scoreInterval,
  type AlignmentConvergence, type CalibrationReport, type ScoreInterval,
} from "@proteus/core";
import type { Rpc } from "@/lib/protocol";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { type AsyncResource, lastValue, loadFailed, loadSucceeded, useAsyncResource } from "@/hooks/use-async-resource";
import { EmptyState, Metric, scoreColor } from "./shared";

interface GepaRunRow { runId: string; target: string; startedAt: number; status: string; winnerId: string | null; iterations: number; metricCalls: number }
interface GepaCandidate { id: string; parentId: string | null; aggregateScore: number; scores: Record<string, number>; createdAt: number }
interface GepaRunDetail { run: GepaRunRow | null; candidates: GepaCandidate[]; pareto: Array<{ candidateId: string; instanceId: string; score: number }> }

export function GepaView({ rpc }: { rpc: Rpc }) {
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<AsyncResource<GepaRunDetail>>({ status: "loading" });
  const load = useCallback(() => rpc<GepaRunRow[]>("getGepaRuns", [20]), [rpc]);
  const { resource, reload } = useAsyncResource(load);
  const open = useCallback((runId: string) => {
    setSel(runId);
    setDetail({ status: "loading" });
    rpc<GepaRunDetail>("getGepaRun", [runId]).then(
      (d) => setDetail(loadSucceeded(d)),
      (err) => setDetail((prev) => loadFailed(prev, err)),
    );
  }, [rpc]);

  const runs = lastValue(resource);
  if (runs === null) {
    if (resource.status === "error") return <LoadFailure what="the self-tuning runs" message={resource.message} onRetry={reload} />;
    return <div className="flex justify-center py-8"><Loader size="sm" /></div>;
  }
  if (runs.length === 0) return <EmptyState icon={<DatabaseIcon size={28} />} title="No self-tuning runs yet" hint="Trigger a scaffold self-tuning pass (GEPA) from Settings; its candidates + Pareto front appear here." />;

  const loadedDetail = lastValue(detail);
  const paretoIds = new Set((loadedDetail?.pareto ?? []).map((p) => p.candidateId));
  const maxAgg = Math.max(0.0001, ...(loadedDetail?.candidates ?? []).map((c) => c.aggregateScore));
  return (
    <div className="space-y-3 animate-fade-in overflow-y-auto h-full">
      <div className="space-y-1">
        {runs.map((r) => (
          <button key={r.runId} onClick={() => open(r.runId)}
            className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors ${sel === r.runId ? "p-fill" : "hover:p-card"}`}>
            <span className={`size-1.5 rounded-full shrink-0 ${r.status === "completed" ? "p-dot-success" : r.status === "running" ? "p-dot-warning" : "p-dot-neutral"}`} />
            <span className="text-[11px] p-text-2 flex-1 truncate">{r.target} · {r.iterations} iters · {r.metricCalls} evals</span>
            <span className="text-[10px] p-text-3 shrink-0">{new Date(r.startedAt).toLocaleDateString()}</span>
          </button>
        ))}
      </div>

      {sel && (loadedDetail === null ? (
        detail.status === "error"
          ? <LoadFailure what="this run's candidates" message={detail.message} onRetry={() => open(sel)} />
          : <div className="flex justify-center py-4"><Loader size="sm" /></div>
      ) : (
        <div className="space-y-2">
          <div className="text-[11px] p-text-3">{loadedDetail.candidates.length} candidates · {paretoIds.size} on the Pareto front · winner {loadedDetail.run?.winnerId?.slice(0, 8) ?? "—"}</div>
          {/* Candidate aggregate-score bars; Pareto-front + winner highlighted. */}
          <div className="space-y-1">
            {loadedDetail.candidates.map((c) => {
              const onPareto = paretoIds.has(c.id);
              const isWinner = loadedDetail.run?.winnerId === c.id;
              // The aggregate is a mean over a handful of judged instances —
              // shown with its interval so two candidates aren't read apart on
              // a gap the eval set can't resolve.
              const ci = scoreInterval(Object.values(c.scores));
              return (
                <div key={c.id} className="flex items-center gap-2 text-[10px]">
                  <span className={`font-mono shrink-0 w-14 truncate ${isWinner ? "p-success" : "p-text-3"}`}>{c.id.slice(0, 8)}</span>
                  <div className="flex-1 h-2 rounded-full p-fill overflow-hidden" title={`95% CI ${ci.lo.toFixed(2)}–${ci.hi.toFixed(2)} over ${ci.n} instances`}>
                    <div className={`h-full ${isWinner ? "p-dot-success" : onPareto ? "p-dot-info" : "p-dot-neutral"}`} style={{ width: `${(c.aggregateScore / maxAgg) * 100}%` }} />
                  </div>
                  <span className="font-mono p-text-3 tabular-nums shrink-0 w-10 text-right">{c.aggregateScore.toFixed(2)}</span>
                  <span className="hidden sm:inline font-mono p-text-3 tabular-nums shrink-0 w-20 text-right opacity-70">[{ci.lo.toFixed(2)}–{ci.hi.toFixed(2)}]</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Quality scoreboard ────────────────────────────────────────── */

// The replay-eval loss curve (getReplayEvals): the live scaffold re-scored
// against graded turns over time. Each row is tagged with the scaffold_version
// it ran under, so version changes mark before-vs-after-evolution boundaries.
interface ReplayEvalRow {
  id: string; ranAt: number; sampleSize: number;
  acceptedCount: number; negativeCount: number;
  meanScore: number; loss: number; scaffoldVersion: number | null;
  /** 95% interval on meanScore — a dozen judge verdicts is not a point. */
  interval: ScoreInterval;
}

// A reported score is never shown alone: the 95% interval sits under it, at
// the sample sizes these runs use it is the whole story.
function ScoreWithInterval({ value, interval, className }: { value: number; interval: ScoreInterval; className?: string }) {
  return (
    <span className="flex flex-col leading-tight">
      <span className={className}>{value.toFixed(3)}</span>
      <span className="text-[9px] p-text-3 tabular-nums">95% CI {interval.lo.toFixed(2)}–{interval.hi.toFixed(2)}</span>
    </span>
  );
}

// Both quality signals load together so the pane resolves once, rather than
// flashing an empty state while the second call is still in flight.
export function QualityView({ rpc }: { rpc: Rpc }) {
  const load = useCallback(async () => {
    const [rows, align, calibration] = await Promise.all([
      rpc<ReplayEvalRow[]>("getReplayEvals", [50]),
      rpc<AlignmentConvergence>("getAlignmentConvergence"),
      rpc<CalibrationReport>("getOutcomeCalibration"),
    ]);
    return { rows, align, calibration };
  }, [rpc]);
  const { resource, reload } = useAsyncResource(load);

  const data = lastValue(resource);
  if (data === null) {
    if (resource.status === "error") return <LoadFailure what="the quality history" message={resource.message} onRetry={reload} />;
    return <div className="flex justify-center py-8"><Loader size="sm" /></div>;
  }
  const { rows, align, calibration } = data;
  const hasAlignment = align.overall.turns > 0;
  if (rows.length === 0 && !hasAlignment) return <EmptyState icon={<GaugeIcon size={28} />} title="No quality history yet" hint="Replay-eval runs (fired by lifetime evolution; browsable via agent.replayEvals) re-score the live scaffold against graded turns. The loss curve, K_align, and latest aggregate appear here." />;

  return (
    <div className="space-y-4 animate-fade-in overflow-y-auto h-full">
      {hasAlignment && <AlignmentPanel k={align} calibration={calibration} />}
      {rows.length > 0 && <ReplayEvalPanel rows={rows} />}
    </div>
  );
}

function ReplayEvalPanel({ rows }: { rows: ReplayEvalRow[] }) {
  const chrono = [...rows].reverse(); // oldest → newest for the curve
  const latest = rows[0];
  const latestLoss = lossInterval(latest.interval);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Metric label="Latest score" value={<ScoreWithInterval value={latest.meanScore} interval={latest.interval} className={scoreColor(latest.meanScore)} />} />
        <Metric label="Loss" value={<ScoreWithInterval value={latest.loss} interval={latestLoss} />} />
        <Metric label="Sample" value={`${latest.sampleSize} (${latest.acceptedCount}✓ / ${latest.negativeCount}✗)`} />
        <Metric label="Scaffold" value={latest.scaffoldVersion ?? "—"} />
      </div>

      <section className="space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-normal p-text-3">Mean score over time</div>
          <div className="text-[10px] p-text-3">floor {DEFAULT_QUALITY_THRESHOLD.toFixed(2)}</div>
        </div>
        <QualitySparkline points={chrono} threshold={DEFAULT_QUALITY_THRESHOLD} />
      </section>

      <section className="space-y-1.5">
        <div className="text-[10px] uppercase tracking-normal p-text-3">Recent runs</div>
        <div className="space-y-1">
          {rows.map((r, i) => {
            const prev = rows[i + 1]; // next-oldest
            const evolved = prev != null && prev.scaffoldVersion !== r.scaffoldVersion;
            return (
              <div key={r.id} className="flex items-center gap-2 text-[10px]">
                <span className="p-text-3 shrink-0 w-16 truncate">{new Date(r.ranAt).toLocaleDateString()}</span>
                {r.scaffoldVersion != null && (
                  <span className={`shrink-0 font-mono ${evolved ? "p-accent" : "p-text-3"}`} title={evolved ? "scaffold evolved" : undefined}>v{r.scaffoldVersion}{evolved ? "↑" : ""}</span>
                )}
                <div className="flex-1 h-2 rounded-full p-fill overflow-hidden" title={`95% CI ${r.interval.lo.toFixed(2)}–${r.interval.hi.toFixed(2)} over ${r.sampleSize} turns`}>
                  <div className={`h-full ${r.meanScore >= 0.7 ? "p-dot-success" : r.meanScore >= 0.4 ? "p-dot-warning" : "p-dot-danger"}`} style={{ width: `${Math.max(0, Math.min(1, r.meanScore)) * 100}%` }} />
                </div>
                <span className="font-mono p-text-3 tabular-nums shrink-0 w-10 text-right">{r.meanScore.toFixed(2)}</span>
                <span className="hidden sm:inline font-mono p-text-3 tabular-nums shrink-0 w-20 text-right opacity-70">[{r.interval.lo.toFixed(2)}–{r.interval.hi.toFixed(2)}]</span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/* ── K_align (Alignment Convergence Rate) ──────────────────────── */

// How often the user had to correct the agent, per 100 graded turns, split by
// the scaffold version that served them — computed from the turn_outcomes
// ledger alone (no benchmark, no judge). Every rate is shown WITH its 95%
// Wilson interval, and a segment whose interval is too wide to read is drawn
// muted, because the point of this panel is to stop small numbers being
// over-read as progress.
const TREND_STYLE: Record<AlignmentConvergence["trend"], { label: string; className: string }> = {
  improving: { label: "improving", className: "p-success" },
  worsening: { label: "worsening", className: "p-danger" },
  flat: { label: "no detectable change", className: "p-text-2" },
  insufficient: { label: "not enough data", className: "p-text-3" },
};

function AlignmentPanel({ k, calibration }: { k: AlignmentConvergence; calibration: CalibrationReport }) {
  const trend = TREND_STYLE[k.trend];
  // One shared scale so segment intervals are visually comparable; the floor
  // keeps a near-zero rate from filling the whole track.
  const scaleMax = Math.max(20, ...k.segments.map((s) => s.rate.highPer100));
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[10px] uppercase tracking-normal p-text-3">K_align · corrections per 100 turns</div>
        <div className={`text-[10px] ${trend.className}`}>
          {trend.label}{k.deltaPer100 !== null ? ` (${k.deltaPer100 > 0 ? "+" : ""}${k.deltaPer100.toFixed(1)})` : ""}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <Metric label="Rate" value={`${k.overall.rate.per100.toFixed(1)}`} />
        <Metric label="95% interval" value={`${k.overall.rate.lowPer100.toFixed(1)}–${k.overall.rate.highPer100.toFixed(1)}`} />
        <Metric label="Graded turns" value={`${k.overall.turns}${k.overall.abandoned > 0 ? ` (+${k.overall.abandoned} ungraded)` : ""}`} />
      </div>
      <div className="space-y-1">
        {k.segments.map((s) => (
          <div key={`${s.scaffoldVersion ?? "none"}-${s.firstAt}`}
            className={`flex items-center gap-2 text-[10px] ${s.rate.reliable ? "" : "opacity-50"}`}
            title={s.rate.reliable ? undefined : "interval too wide to read as a rate"}>
            <span className="shrink-0 font-mono p-text-3 w-8">v{s.scaffoldVersion ?? "?"}</span>
            <span className="shrink-0 p-text-3 w-12 tabular-nums">n={s.turns}</span>
            <div className="flex-1 h-2 rounded-full p-fill relative overflow-hidden">
              <div className="absolute inset-y-0 p-dot-info opacity-40" style={{
                left: `${(s.rate.lowPer100 / scaleMax) * 100}%`,
                width: `${Math.max(1, ((s.rate.highPer100 - s.rate.lowPer100) / scaleMax) * 100)}%`,
              }} />
              <div className="absolute inset-y-0 w-0.5 p-dot-info" style={{ left: `${(s.rate.per100 / scaleMax) * 100}%` }} />
            </div>
            <span className="font-mono p-text-3 tabular-nums shrink-0 w-8 text-right">{s.rate.per100.toFixed(1)}</span>
          </div>
        ))}
      </div>
      <div className="text-[10px] p-text-3">{k.note}</div>
      <CalibrationNote report={calibration} />
    </section>
  );
}

// The rate above is the CLASSIFIER's count of corrections. How far that is from
// the real one is measurable, and until it has been measured this says so
// rather than letting the number read as ground truth.
function CalibrationNote({ report }: { report: CalibrationReport }) {
  if (report.accuracy === null || report.overall === null) {
    // The gap sentence already opens with the verdict ("uncalibrated — no
    // hand-labeled turns yet"), so leading with the word again stutters on the
    // commonest case of all: a workspace nobody has hand-labeled.
    const reason = report.gap === null ? "Uncalibrated" : sentenceCase(describeCalibrationGap(report.gap));
    return (
      <div className="text-[10px] p-text-3">
        <span className="p-warning">{reason}.</span>
        {" The rate above is what the classifier counted, not a measured one. "}
        Check ~100 turns by hand with <span className="font-mono">proteus label export</span>.
      </div>
    );
  }
  const per100 = (value: number): string => (value * 100).toFixed(1);
  const { corrected, bias } = report.overall;
  return (
    <div className="text-[10px] p-text-3">
      Corrected: <span className="font-mono p-text tabular-nums">{per100(corrected.mean)}</span>
      {` per 100 (95% CI ${per100(corrected.lo)}–${per100(corrected.hi)}), `}
      {`${bias >= 0 ? "+" : ""}${per100(bias)} off what the classifier said · `}
      {`sensitivity ${report.accuracy.sensitivity.mean.toFixed(2)}, specificity ${report.accuracy.specificity.mean.toFixed(2)}`}
      {report.kappa === null ? "" : `, κ ${report.kappa.value.toFixed(2)}`}
      {` · ${report.labeled} hand labels`}
    </div>
  );
}

// Inline SVG mean-score curve with a dashed quality-floor reference. Points are
// coloured by score band; the path uses a non-scaling stroke so it stays crisp
// under preserveAspectRatio="none".
function QualitySparkline({ points, threshold }: { points: ReplayEvalRow[]; threshold: number }) {
  const W = 100, H = 32, pad = 2;
  const n = points.length;
  const x = (i: number) => n <= 1 ? W / 2 : pad + (i / (n - 1)) * (W - 2 * pad);
  const y = (score: number) => pad + (1 - Math.max(0, Math.min(1, score))) * (H - 2 * pad);
  const line = points.map((p, i) => `${x(i).toFixed(2)},${y(p.meanScore).toFixed(2)}`).join(" ");
  // The 95% band the means sit inside — drawn so the curve can't be read as
  // more precise than it is.
  const band = [
    ...points.map((p, i) => `${x(i).toFixed(2)},${y(p.interval.hi).toFixed(2)}`),
    ...[...points].reverse().map((p, i) => `${x(points.length - 1 - i).toFixed(2)},${y(p.interval.lo).toFixed(2)}`),
  ].join(" ");
  const floorY = y(threshold).toFixed(2);
  const dotColor = (s: number) => s >= 0.7 ? "var(--c-success)" : s >= 0.4 ? "var(--c-warning)" : "var(--c-danger)";
  return (
    <div className="rounded-lg border p-border p-surface p-2">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-24">
        <line x1={pad} y1={floorY} x2={W - pad} y2={floorY} stroke="var(--c-text-3)" strokeWidth={0.4} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" opacity={0.6} />
        {n > 1 && <polygon points={band} fill="var(--c-accent)" opacity={0.14} />}
        {n > 1 && <polyline points={line} fill="none" stroke="var(--c-accent)" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
        {points.map((p, i) => (
          <circle key={p.id} cx={x(i)} cy={y(p.meanScore)} r={1.4} fill={dotColor(p.meanScore)} vectorEffect="non-scaling-stroke">
            <title>{`${new Date(p.ranAt).toLocaleString()} · score ${p.meanScore.toFixed(3)} (95% CI ${p.interval.lo.toFixed(2)}–${p.interval.hi.toFixed(2)}) · loss ${p.loss.toFixed(3)}${p.scaffoldVersion != null ? ` · scaffold v${p.scaffoldVersion}` : ""}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
