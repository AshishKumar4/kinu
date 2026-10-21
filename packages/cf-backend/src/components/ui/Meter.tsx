/** How much of something is used (docs/DESIGN-SYSTEM.md §2): a 4 bar in the accent, warning from 80%, danger at 100%. */
import { Meter as KumoMeter } from "@cloudflare/kumo";

function toneOf(value: number): string {
  if (value >= 100) return "p-meter-danger";

  return value >= 80 ? "p-meter-warning" : "p-meter-accent";
}

export function Meter({ label, value, shown }: { label: string; value: number; shown?: string }) {
  return <KumoMeter label={label} value={value} customValue={shown} showValue={shown !== undefined} className="p-meter" trackClassName="p-meter-track" indicatorClassName={toneOf(value)} />;
}

/** How far a run of steps has gone, as one thin bar with no words of its own: what it is is said beside it. */
export function ProgressBar({ value, max }: { value: number; max: number }) {
  return (
    <div className="p-progress" role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <div className="p-progress-fill" style={{ width: `${String(Math.max(6, (value / Math.max(1, max)) * 100))}%` }} />
    </div>
  );
}
