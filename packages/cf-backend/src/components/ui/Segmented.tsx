import { useRef } from "react";
import { useRovingTabs } from "./use-roving-tabs";

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
  const roving = useRovingTabs(strip, segments.map((segment) => segment.id), value);

  return (
    <div ref={strip} {...roving.list} aria-label={label} className="flex min-w-0 items-center gap-0.5 rounded-lg p-recessed p-0.5">
      {segments.map((segment) => {
        const selected = segment.id === value;

        return (
          <button
            key={segment.id}
            type="button"
            {...roving.tab(segment.id)}
            data-segment={segment.id}
            onClick={() => onChange(segment.id)}
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
