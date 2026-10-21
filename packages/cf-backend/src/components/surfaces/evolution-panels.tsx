import { useCallback } from "react";
import { Loader } from "@/components/ui/Loader";
import type { QualityDay } from "@kinu.run/core";
import { toneFill, type StatusTone } from "@/components/ui/Status";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource, useReloadWhenMoved } from "@/hooks/use-async-resource";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";
import { Surface } from "@/components/ui/Surface";

/** A trend needs this many rated days to say anything. */
const TREND_DAYS = 3;

/** How it is doing: the last seven UTC days summed as core answers them (`getQualityWindow`), and the last thirty, one
 *  column a day, once enough of them were rated. `moved`: `getQuality`'s `reads_changed` count, which both reads track. */
export function QualityView({ rpc, moved }: { rpc: WorkspaceRpc; moved: number }) {
  const load = useCallback(async () => {
    const [week, days] = await Promise.all([rpc("getQualityWindow", [7]), rpc("getQuality", [30])]);

    return { week, days };
  }, [rpc]);

  const { resource, reload } = useAsyncResource(load);
  const read = lastValue(resource);

  useReloadWhenMoved(moved, reload);

  if (read === null) {
    if (resource.status === "error") return <LoadFailure what="how it's doing" message={resource.message} onRetry={reload} />;

    return <div className="flex justify-center py-8" role="status"><Loader size="sm" /><span className="sr-only">Loading activity</span></div>;
  }

  const { week, days } = read;
  const ratedDays = days.filter((day) => day.rated > 0).length;

  if (ratedDays === 0) return <p className="t-body p-text-3">No rated turns yet.</p>;

  const corrected = Math.round(week.corrected.mean * week.rated);
  const thumbs = week.thumbs > 0 ? `, ${String(week.thumbs)} by your thumbs` : "";

  return (
    <div className="space-y-3 animate-fade-in" data-quality-verdict>
      {week.rated === 0 ? (
        <p className="t-body p-text-3">No rated turns in the last 7 days.</p>
      ) : (
        <div className="flex items-baseline gap-3" title={`95% interval ${week.satisfaction.lo.toFixed(2)}–${week.satisfaction.hi.toFixed(2)}, ${week.from} to ${week.to} (UTC)`}>
          <Surface look="round" as="span" className="size-2 shrink-0 self-center" style={{ background: toneFill(toneOf(week.satisfaction.mean)) }} aria-hidden />
          <span className="t-title shrink-0 whitespace-nowrap tabular-nums p-text">
            {week.satisfaction.mean.toFixed(1)}<span className="t-body p-text-3"> / 5</span>
          </span>
          <span className="t-meta min-w-0 p-text-3">
            over the last 7 days · {week.rated} of {week.turns} {week.turns === 1 ? "turn" : "turns"} rated{thumbs}
            {corrected > 0 ? ` · corrected ${String(corrected)} ${corrected === 1 ? "time" : "times"}` : ""}
          </span>
        </div>
      )}
      {ratedDays < TREND_DAYS
        ? <p className="t-meta p-text-3">A trend shows once three days have ratings.</p>
        : <SatisfactionDays days={days} />}
    </div>
  );
}

/** 1-5 onto [0, 1]. */
function toUnit(score: number): number {
  return Math.max(0, Math.min(1, (score - 1) / 4));
}

function toneOf(score: number): StatusTone {
  if (score >= 3.5) return "success";

  if (score >= 2.5) return "warning";

  return "danger";
}

/** The window's UTC days, one column each: a rated day's mean as a dot over its interval, an unrated day as a tick. */
function SatisfactionDays({ days }: { days: readonly QualityDay[] }) {
  const at = (score: number): string => `${String((1 - toUnit(score)) * 100)}%`;
  const label = (day: string): string => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

  return (
    <div className="p-card px-3 pt-3 pb-2">
      <div className="grid grid-cols-[14px_minmax(0,1fr)] gap-2">
        <div className="t-meta t-mono relative h-24 p-text-3" aria-hidden>
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
                      style={{ top: at(day.satisfaction.hi), bottom: `calc(100% - ${at(day.satisfaction.lo)})`, background: toneFill(toneOf(day.satisfaction.mean)) }} />
                    <Surface look="round" as="span" className="absolute left-1/2 size-[7px] -translate-x-1/2 -translate-y-1/2" style={{ top: at(day.satisfaction.mean), background: toneFill(toneOf(day.satisfaction.mean)) }} />
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="t-meta t-mono mt-2 flex justify-between pl-[22px] p-text-3">
        <span>{label(days[0]?.day ?? "")}</span><span>{label(days.at(-1)?.day ?? "")}</span>
      </div>
    </div>
  );
}
