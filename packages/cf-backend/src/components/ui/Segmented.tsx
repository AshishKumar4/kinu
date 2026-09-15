/**
 * The one exclusive-choice control: a strip of underline tabs, the app's own
 * `p-tab`/`p-tabstrip` grammar, where the pages need a filter rather than a
 * page. Roving tabindex — the strip is one tab stop, the arrows move inside
 * it — with `aria-selected` on the chosen tab. A segment may carry a count,
 * drawn after its label in the small tabular figure so a wide number never
 * shifts the label's seat.
 */
import { useRef, useState } from "react";

export interface SegmentOption<T extends string> {
  readonly id: T;
  readonly label: string;
  readonly count?: number;
}


export function Segmented<T extends string>({ label, segments, value, onChange }: {
  label: string;
  segments: readonly SegmentOption<T>[];
  value: T;
  onChange: (id: T) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  // The tab a keystroke or click focused; null means "the selected one".
  const [focusId, setFocusId] = useState<T | null>(null);

  return (
    <div
      ref={strip}
      role="tablist"
      aria-label={label}
      className="p-tabstrip flex min-w-0 border-b p-border"
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node) || !strip.current?.contains(event.relatedTarget)) setFocusId(null);
      }}
      onKeyDown={(event) => {
        let step: number;

        switch (event.key) {
          case "ArrowLeft": step = -1; break;
          case "ArrowRight": step = 1; break;
          case "Home": step = -segments.length; break;
          case "End": step = segments.length; break;
          default: return;
        }

        event.preventDefault();

        const index = segments.findIndex((segment) => segment.id === (focusId ?? value));
        const next = segments[(index + step + segments.length) % segments.length];

        if (next === undefined) return;
        setFocusId(next.id);
        strip.current?.querySelector<HTMLElement>(`[data-segment="${next.id}"]`)?.focus();
      }}
    >
      {segments.map((segment) => {
        const selected = segment.id === value;

        return (
          <button
            key={segment.id}
            type="button"
            role="tab"
            data-segment={segment.id}
            aria-selected={selected}
            tabIndex={(focusId ?? value) === segment.id ? 0 : -1}
            onClick={() => onChange(segment.id)}
            onFocus={() => setFocusId(segment.id)}
            className={`p-tab -mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2.5 py-1.5 p-t-control${selected ? " p-tab-active" : ""}`}
          >
            {segment.label}
            {segment.count !== undefined && (
              <span className={`p-meta tabular-nums ${selected ? "p-text-2" : "p-text-4"}`}>{segment.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
