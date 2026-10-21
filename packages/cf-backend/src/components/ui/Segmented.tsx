/** Roving tabindex: the strip is one tab stop, arrows move inside it. */
import { useRef, useState, type ReactNode } from "react";

interface SegmentOption<T extends string> {
  readonly id: T;
  readonly label: string;
  readonly count?: number;
  /** Drawn alone, with the label as its name: two 28 px squares in a 32 px track (Workspaces' view). */
  readonly icon?: ReactNode;
}


/** A segment's box by size, at 13/20 wherever it sits (a workbench's smaller control text included): `md` 32, `sm` 24 for a
 *  28 track inside a 46 bar (a tool's view). */
const SEGMENT_BOX = { md: "px-2.5 py-[5px]", sm: "px-2 py-px" } as const;

export function Segmented<T extends string>({ label, segments, value, onChange, size = "md" }: {
  label: string;
  segments: readonly SegmentOption<T>[];
  value: T;
  onChange: (id: T) => void;
  size?: keyof typeof SEGMENT_BOX;
}) {
  const strip = useRef<HTMLDivElement>(null);
  // The tab a keystroke or click focused; null means "the selected one".
  const [focusId, setFocusId] = useState<T | null>(null);

  return (
    <div
      ref={strip}
      role="tablist"
      aria-label={label}
      className="flex min-w-0 items-center gap-0.5 rounded-[var(--r-control)] p-sunken p-0.5"
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
            aria-label={segment.icon === undefined ? undefined : segment.label}
            title={segment.icon === undefined ? undefined : segment.label}
            className={`flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border text-[13px] font-medium leading-5 ${segment.icon === undefined ? SEGMENT_BOX[size] : "size-7"}${selected ? " border-[var(--c-button-line)] bg-[var(--c-button-bg)] p-text shadow-[var(--shadow-button)]" : " border-transparent p-text-3 hover:p-text"}`}
          >
            {segment.icon ?? segment.label}
            {segment.count !== undefined && (
              <span className={`p-meta tabular-nums ${selected ? "p-text-2" : "p-text-3"}`}>{segment.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
