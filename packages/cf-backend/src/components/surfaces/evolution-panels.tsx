import { useState, useCallback } from "react";
import { Loader } from "@cloudflare/kumo";
import { DatabaseIcon, GaugeIcon } from "@phosphor-icons/react";
import {
  DEFAULT_QUALITY_THRESHOLD, describeCalibrationGap, lossInterval, scoreInterval,
  type AlignmentConvergence, type CalibrationReport, type ScoreInterval,
} from "@kinu.run/core";
import type { Rpc } from "@kinu.run/core";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { type AsyncResource, lastValue, loadFailed, loadSucceeded, useAsyncResource } from "@/hooks/use-async-resource";
import { EmptyState, Metric, scoreColor } from "./shared";

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
  const [detail, setDetail] = useState<AsyncResource<GepaRunDetail>>({ status: "loading" });
  const load = useCallback(() => rpc<GepaRunRow[]>("getGepaRuns", [20]), [rpc]);
  const { resource, reload } = useAsyncResource(load);

  const open = useCallback(async (runId: string) => {
    setSel(runId);
    setDetail({ status: "loading" });

    try {
      const runDetail = await rpc<GepaRunDetail>("getGepaRun", [runId]);
      setDetail(loadSucceeded(runDetail));
    } catch (cause) {
      setDetail((previous) => loadFailed(previous, { cause }));
    }
  }, [rpc]);

  const runs = lastValue(resource);

  if (runs === null) {
    if (resource.status === "error") return <LoadFailure what="the self-tuning runs" message={resource.message} onRetry={reload} />;

    return <div className="flex justify-center py-8"><Loader size="sm" /></div>;
  }

  if (runs.length === 0) return <EmptyState icon={<DatabaseIcon size={28} />} title="No self-tuning runs yet" />;

  const loadedDetail = lastValue(detail);
  const paretoIds = new Set((loadedDetail?.pareto ?? []).map((p) => p.candidateId));
  const maxAgg = Math.max(0.0001, ...(loadedDetail?.candidates ?? []).map((c) => c.aggregateScore));

  return (
    <div className="space-y-3 animate-fade-in overflow-y-auto h-full">
      <div className="space-y-1">
        {runs.map((r) => (
          <button key={r.runId} onClick={() => open(r.runId)}
            className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors ${sel === r.runId ? "p-fill" : "p-card-hover"}`}>
            <span className={`size-1.5 rounded-full shrink-0 ${runDot(r.status)}`} />
            <span className="p-row-text p-text-2 flex-1 truncate">{r.target} · {r.iterations} iters · {r.metricCalls} evals</span>
            <span className="p-meta p-text-3 shrink-0">{new Date(r.startedAt).toLocaleDateString()}</span>
          </button>
        ))}
      </div>

      {sel !== null && loadedDetail === null && (
        detail.status === "error"
          ? <LoadFailure what="this run's candidates" message={detail.message} onRetry={() => open(sel)} />
          : <div className="flex justify-center py-4"><Loader size="sm" /></div>
      )}
      {sel !== null && loadedDetail !== null && (
        <div className="space-y-2">
          <div className="p-meta p-text-3">{loadedDetail.candidates.length} candidates · {paretoIds.size} on the Pareto front · winner {loadedDetail.run?.winnerId?.slice(0, 8) ?? "—"}</div>
          <div className="space-y-1">
            {loadedDetail.candidates.map((c) => {
              const onPareto = paretoIds.has(c.id);
              const isWinner = loadedDetail.run?.winnerId === c.id;
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
      )}
    </div>
  );
}


interface ReplayEvalRow {
  id: string; ranAt: number; sampleSize: number;
  acceptedCount: number; negativeCount: number;
  meanScore: number; loss: number; scaffoldVersion: number | null;
  interval: ScoreInterval;
}

function ScoreWithInterval({ value, interval, className }: { value: number; interval: ScoreInterval; className?: string }) {
  return (
    <span className="flex flex-col leading-tight">
      <span className={className}>{value.toFixed(3)}</span>
      <span className="p-meta p-text-3 tabular-nums">95% CI {interval.lo.toFixed(2)}–{interval.hi.toFixed(2)}</span>
    </span>
  );
}

// Each signal publishes on its own branch so one failing does not blank the other; the SDK call deadline bounds a stalled read.
export function QualityView({ rpc }: { rpc: Rpc }) {
  const loadRows = useCallback(() => rpc<ReplayEvalRow[]>("getReplayEvals", [50]), [rpc]);

  const loadAlignment = useCallback(async () => {
    const [align, calibration] = await Promise.all([
      rpc<AlignmentConvergence>("getAlignmentConvergence"),
      rpc<CalibrationReport>("getOutcomeCalibration"),
    ]);

    return { align, calibration };
  }, [rpc]);

  const rows = useAsyncResource(loadRows);
  const alignment = useAsyncResource(loadAlignment);


  const loadedRows = lastValue(rows.resource);
  const loadedAlignment = lastValue(alignment.resource);
  const hasAlignment = loadedAlignment !== null && loadedAlignment.align.overall.turns > 0;

  const bothEmpty = loadedRows !== null && loadedRows.length === 0
    && loadedAlignment !== null && !hasAlignment;

  if (bothEmpty) return <EmptyState icon={<GaugeIcon size={28} />} title="No quality history yet" />;

  return (
    <div className="space-y-4 animate-fade-in overflow-y-auto h-full">
      <section data-quality-branch="alignment">
        {alignment.resource.status === "loading" && (
          <div className="flex justify-center py-4" role="status">
            <Loader size="sm" /><span className="sr-only">Loading alignment history</span>
          </div>
        )}
        {alignment.resource.status === "error" && (
          <LoadFailure what="the alignment ledger" message={alignment.resource.message} onRetry={alignment.reload} />
        )}
        {hasAlignment && <AlignmentPanel k={loadedAlignment.align} calibration={loadedAlignment.calibration} />}
      </section>
      <section data-quality-branch="replay">
        {rows.resource.status === "loading" && (
          <div className="flex justify-center py-4" role="status">
            <Loader size="sm" /><span className="sr-only">Loading replay-eval history</span>
          </div>
        )}
        {rows.resource.status === "error" && (
          <LoadFailure what="the replay-eval history" message={rows.resource.message} onRetry={rows.reload} />
        )}
        {loadedRows !== null && loadedRows.length > 0 && <ReplayEvalPanel rows={loadedRows} />}
      </section>
    </div>
  );
}

function ReplayEvalPanel({ rows }: { rows: ReplayEvalRow[] }) {
  const chrono = [...rows].reverse();
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
          <div className="p-eyebrow">Mean score over time</div>
          <div className="p-meta p-text-3">floor {DEFAULT_QUALITY_THRESHOLD.toFixed(2)}</div>
        </div>
        <QualitySparkline points={chrono} threshold={DEFAULT_QUALITY_THRESHOLD} />
      </section>

      <section className="space-y-1.5">
        <div className="p-eyebrow">Recent runs</div>
        <div className="space-y-1">
          {rows.map((r, i) => {
            const prev = rows[i + 1];
            const evolved = prev != null && prev.scaffoldVersion !== r.scaffoldVersion;
            const belowSuccess = r.meanScore >= 0.4 ? "p-dot-warning" : "p-dot-danger";

            return (
              <div key={r.id} className="flex items-center gap-2 p-meta">
                <span className="p-text-3 shrink-0 w-16 truncate">{new Date(r.ranAt).toLocaleDateString()}</span>
                {r.scaffoldVersion != null && (
                  <span className={`shrink-0 font-mono ${evolved ? "p-accent" : "p-text-3"}`} title={evolved ? "scaffold evolved" : undefined}>v{r.scaffoldVersion}{evolved ? "↑" : ""}</span>
                )}
                <div className="flex-1 h-2 rounded-full p-fill overflow-hidden" title={`95% CI ${r.interval.lo.toFixed(2)}–${r.interval.hi.toFixed(2)} over ${r.sampleSize} turns`}>
                  <div className={`h-full ${r.meanScore >= 0.7 ? "p-dot-success" : belowSuccess}`} style={{ width: `${Math.max(0, Math.min(1, r.meanScore)) * 100}%` }} />
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


// Segments whose Wilson interval is too wide are muted so small numbers are not over-read.
const TREND_STYLE = {
  improving: { label: "improving", className: "p-success" },
  worsening: { label: "worsening", className: "p-danger" },
  flat: { label: "no detectable change", className: "p-text-2" },
  insufficient: { label: "not enough data", className: "p-text-3" },
} satisfies Record<AlignmentConvergence["trend"], { label: string; className: string }>;

function AlignmentPanel({ k, calibration }: { k: AlignmentConvergence; calibration: CalibrationReport }) {
  const trend = TREND_STYLE[k.trend];
  const scaleMax = Math.max(20, ...k.segments.map((s) => s.rate.highPer100));

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="p-eyebrow">K_align · corrections per 100 turns</div>
        <div className={`p-t-status ${trend.className}`}>
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
            className={`flex items-center gap-2 p-meta ${s.rate.reliable ? "" : "opacity-50"}`}
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
      <div className="p-meta p-text-3">{k.note}</div>
      <CalibrationNote report={calibration} />
    </section>
  );
}

function CalibrationNote({ report }: { report: CalibrationReport }) {
  if (report.accuracy === null || report.overall === null) {
    const reason = report.gap === null ? "Uncalibrated" : sentenceCase(describeCalibrationGap(report.gap));

    return (
      <div className="p-meta p-text-3">
        <span className="p-warning">{reason}.</span>
        {" The classifier counted this rate. "}
        Check about 100 turns by hand with <span className="font-mono">kinu label export</span>.
      </div>
    );
  }

  const per100 = (value: number): string => (value * 100).toFixed(1);
  const { corrected, bias } = report.overall;

  return (
    <div className="p-meta p-text-3">
      Corrected: <span className="font-mono p-text tabular-nums">{per100(corrected.mean)}</span>
      {` per 100 (95% CI ${per100(corrected.lo)}–${per100(corrected.hi)}), `}
      {`${bias >= 0 ? "+" : ""}${per100(bias)} off what the classifier said · `}
      {`sensitivity ${report.accuracy.sensitivity.mean.toFixed(2)}, specificity ${report.accuracy.specificity.mean.toFixed(2)}`}
      {report.kappa === null ? "" : `, κ ${report.kappa.value.toFixed(2)}`}
      {` · ${report.labeled} hand labels`}
    </div>
  );
}

// Non-scaling stroke keeps the path crisp under preserveAspectRatio="none".
function QualitySparkline({ points, threshold }: { points: ReplayEvalRow[]; threshold: number }) {
  const W = 100, H = 32, pad = 2;
  const n = points.length;
  const x = (i: number) => n <= 1 ? W / 2 : pad + (i / (n - 1)) * (W - 2 * pad);
  const y = (score: number) => pad + (1 - Math.max(0, Math.min(1, score))) * (H - 2 * pad);
  const line = points.map((p, i) => `${x(i).toFixed(2)},${y(p.meanScore).toFixed(2)}`).join(" ");

  const band = [
    ...points.map((p, i) => `${x(i).toFixed(2)},${y(p.interval.hi).toFixed(2)}`),
    ...[...points].reverse().map((p, i) => `${x(points.length - 1 - i).toFixed(2)},${y(p.interval.lo).toFixed(2)}`),
  ].join(" ");

  const floorY = y(threshold).toFixed(2);

  const dotColor = (s: number): string => {
    if (s >= 0.7) return "var(--c-success)";

    if (s >= 0.4) return "var(--c-warning)";

    return "var(--c-danger)";
  };

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
