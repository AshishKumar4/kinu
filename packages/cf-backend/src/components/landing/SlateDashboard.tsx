/**
 * The sample body of the landing page's slate frame: what the agent's
 * dashboard looks like once it is open. Drawn in the page rather than served,
 * because the landing page's CSP is `frame-src 'none'`. The chrome around it
 * is the product's own preview header.
 *
 * The numbers are sample data and the frame says so. Charts rise and draw on
 * first paint; under `prefers-reduced-motion` they render settled.
 */
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

const LABELS = [
  ['bug', 14],
  ['billing', 9],
  ['question', 7],
  ['feature', 5],
] as const;

const WEEKS = ['W28', 'W29', 'W30', 'W31', 'W32', 'W33', 'W34', 'W35'] as const;
const OPENED = [12, 15, 11, 18, 14, 16, 13, 17] as const;
const CLOSED = [10, 13, 12, 16, 15, 14, 15, 16] as const;

const OLDEST = [
  ['#1182', 'Refund never posts when the card was replaced', '9d'],
  ['#1190', 'Invoice PDF shows the old company name', '6d'],
  ['#1201', 'Webhook retries stop after the third failure', '4d'],
] as const;

const OPEN_NOW = LABELS.reduce((sum, [, count]) => sum + count, 0);
const CHART_WIDTH = 240;
const CHART_HEIGHT = 72;
const MAX_WEEKLY = 20;

function polyline(values: readonly number[]): string {
  const step = CHART_WIDTH / (values.length - 1);
  return values
    .map((value, index) => `${String(index * step)},${String(CHART_HEIGHT - (value / MAX_WEEKLY) * CHART_HEIGHT)}`)
    .join(' ');
}

/** Counts from zero to `value` over `duration` ms, or shows `value` at once
 *  when the reader asked for reduced motion. */
function Counter({ value, duration = 900 }: { value: number; duration?: number }): ReactElement {
  const reduced = useRef(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [shown, setShown] = useState(reduced.current ? value : 0);
  useEffect(() => {
    if (reduced.current) return;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number): void => {
      const progress = Math.min(1, (now - start) / duration);
      setShown(Math.round(value * (1 - (1 - progress) ** 3)));
      if (progress < 1) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [value, duration]);
  return <>{shown}</>;
}

const KPIS: ReadonlyArray<{ readonly label: string; readonly value: ReactNode }> = [
  { label: 'Open now', value: <Counter value={OPEN_NOW} /> },
  { label: 'Closed · week', value: <Counter value={CLOSED[CLOSED.length - 1] ?? 0} /> },
  { label: 'Median close', value: '2.4d' },
];

export function SlateDashboard(): ReactElement {
  return (
    <div data-slate-dashboard className="p-bg p-text min-h-0 flex-1 overflow-y-auto px-4 py-4 font-sans">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h4 className="text-[15px] font-semibold tracking-[-.01em]">Support queue</h4>
          <p className="text-[11px] p-text-3">Issues from the GitHub connection · refreshed on open</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border p-border px-2 py-0.5 text-[10.5px] p-text-3"><span className="size-1.5 rounded-full p-dot-success p-dot-pulse" />Sample data</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {KPIS.map(({ label, value }) => (
          <div key={label} className="rounded-lg border p-border p-surface px-3 py-2.5">
            <div className="text-[10px] uppercase tracking-[.12em] p-text-4">{label}</div>
            <div className="mt-1 text-[22px] font-semibold tracking-[-.02em] p-num">{value}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 grid gap-3">
        <div className="rounded-lg border p-border p-surface px-3 py-2.5">
          <div className="mb-2 text-[10px] uppercase tracking-[.12em] p-text-4">Open by label</div>
          <div className="flex h-[88px] items-end gap-3">
            {LABELS.map(([label, count], index) => (
              <div key={label} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                <div className="flex h-[64px] w-full items-end">
                  <div
                    className="landing-rise w-full rounded-t-sm bg-[var(--c-accent)]"
                    style={{ height: `${String((count / LABELS[0][1]) * 100)}%`, animationDelay: `${String(index * 90)}ms`, opacity: 1 - index * 0.16 }}
                  />
                </div>
                <span className="text-[10px] p-text-3"><span className="p-text-2">{count}</span> {label}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-lg border p-border p-surface px-3 py-2.5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[10px] uppercase tracking-[.12em] p-text-4">
            <span>Opened vs closed · weekly</span>
            <span className="flex items-center gap-2 normal-case tracking-normal"><span className="inline-flex items-center gap-1"><span className="h-0.5 w-3 bg-[var(--c-accent)]" />opened</span><span className="inline-flex items-center gap-1"><span className="h-0.5 w-3 bg-[var(--c-success)]" />closed</span></span>
          </div>
          <svg viewBox={`0 0 ${String(CHART_WIDTH)} ${String(CHART_HEIGHT)}`} preserveAspectRatio="none" className="h-[72px] w-full overflow-visible" aria-hidden="true">
            {[0.25, 0.5, 0.75].map((fraction) => (
              <line key={fraction} x1={0} x2={CHART_WIDTH} y1={CHART_HEIGHT * fraction} y2={CHART_HEIGHT * fraction} stroke="var(--c-border)" strokeWidth={1} />
            ))}
            <polyline points={polyline(OPENED)} fill="none" stroke="var(--c-accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" className="landing-draw" pathLength={1} />
            <polyline points={polyline(CLOSED)} fill="none" stroke="var(--c-success)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" className="landing-draw" pathLength={1} style={{ animationDelay: '220ms' }} />
          </svg>
          <div className="mt-1 flex justify-between text-[9.5px] p-text-4">{WEEKS.map((week) => <span key={week}>{week}</span>)}</div>
        </div>
      </div>
      <div className="mt-3 rounded-lg border p-border p-surface">
        <div className="border-b p-border px-3 py-2 text-[10px] uppercase tracking-[.12em] p-text-4">Oldest waiting</div>
        {OLDEST.map(([id, title, age], index) => (
          <div key={id} className={`flex items-center gap-3 px-3 py-2 text-[12px] ${index > 0 ? 'border-t border-dashed border-[var(--c-dash)]' : ''}`}>
            <code className="shrink-0 text-[10.5px] p-text-4">{id}</code>
            <span className="min-w-0 flex-1 truncate p-text-2">{title}</span>
            <span className="shrink-0 text-[10.5px] p-warning">{age}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
