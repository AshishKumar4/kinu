/** How much of something is used (docs/DESIGN-SYSTEM.md §2): a 4 bar in the accent, warning from 80%, danger at 100%. */
import { Meter as KumoMeter } from "@cloudflare/kumo";

function toneOf(value: number): string {
  if (value >= 100) return "p-meter-danger";

  return value >= 80 ? "p-meter-warning" : "p-meter-accent";
}

export function Meter({ label, value, shown }: { label: string; value: number; shown?: string }) {
  return <KumoMeter label={label} value={value} customValue={shown} showValue={shown !== undefined} className="p-meter" trackClassName="p-meter-track" indicatorClassName={toneOf(value)} />;
}
