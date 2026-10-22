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
export function ProgressBar({ value, max, label, onCover = false }: { value: number; max: number; label?: string; onCover?: boolean }) {
  return (
    <div className="p-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} data-on-cover={onCover ? "" : undefined}>
      <div className="p-progress-fill" style={{ width: `${String(Math.max(6, (value / Math.max(1, max)) * 100))}%` }} />
    </div>
  );
}

export type ShareTone = "accent" | "warning" | "danger";

/** A share of a whole as the bar alone, 6 tall, where its words are said beside it (a context window filled); the
 *  feature says when it reads as a warning. */
export function ShareBar({ share, tone }: { share: number; tone: ShareTone }) {
  return <div className="p-share" data-tone={tone}><span style={{ width: `${String(Math.min(Math.max(share, 0), 1) * 100)}%` }} /></div>;
}

/** A whole split into its parts, each a share in its own fill and named on hover. */
export function StackedBar({ parts }: { parts: readonly { key: string; share: number; fill: string; title: string }[] }) {
  return (
    <div className="p-stacked">
      {parts.map((part) => <span key={part.key} title={part.title} style={{ width: `${String(part.share * 100)}%`, background: part.fill }} />)}
    </div>
  );
}

/** A part's fill as the key beside its name. */
export function Swatch({ fill }: { fill: string }) {
  return <span className="p-swatch" style={{ background: fill }} />;
}

/** Where a run of steps stands, as a row of dots: the current one long, those done faint, those to come on the fill. */
export function StepDots({ label, steps, at }: { label: string; steps: readonly string[]; at: number }) {
  return (
    <ol aria-label={label} className="flex items-center justify-center gap-2">
      {steps.map((step, index) => (
        <li key={step} aria-current={index === at ? "step" : undefined}>
          <span className="p-step-dot" data-state={dotState(index, at)} />
        </li>
      ))}
    </ol>
  );
}

function dotState(index: number, at: number): "current" | "done" | "next" {
  if (index === at) return "current";

  return index < at ? "done" : "next";
}
