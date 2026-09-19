/**
 * The one exclusive-choice control: a recessed pill of rounded segments, where
 * the pages need a filter rather than a page. Roving tabindex — the strip is
 * one tab stop, the arrows move inside it — with `aria-selected` on the chosen
 * segment. A segment may carry a count, drawn after its label in the small
 * tabular figure so a wide number never shifts the label's seat.
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
      className="flex min-w-0 items-center gap-0.5 rounded-lg p-recessed p-0.5"
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node) || !strip.current?.contains(event.relatedTarget)) setFocusId(null);
      }}
      onKeyDown={(event) => {
        if (segments.length === 0) return;

        const index = segments.findIndex((segment) => segment.id === (focusId ?? value));
        let nextIndex: number;

        switch (event.key) {
          case "ArrowLeft": nextIndex = (index - 1 + segments.length) % segments.length; break;
          case "ArrowRight": nextIndex = (index + 1) % segments.length; break;
          case "Home": nextIndex = 0; break;
          case "End": nextIndex = segments.length - 1; break;
          default: return;
        }

        event.preventDefault();

        const next = segments[nextIndex];

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
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 p-t-control${selected ? " p-surface p-text shadow-[0_1px_2px_var(--c-shadow-drop)]" : " p-text-3 hover:p-text"}`}
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
