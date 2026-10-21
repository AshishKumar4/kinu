/** Roving tabindex: the strip is one tab stop, arrows move inside it. */
import { useRef, useState, type ReactNode } from "react";
import { Link, type To } from "react-router-dom";

interface SegmentOption<T extends string> {
  readonly id: T;
  readonly label: string;
  readonly count?: number;
  /** Drawn alone, with the label as its name: two 28 px squares in a 32 px track (Workspaces' view). */
  readonly icon?: ReactNode;
}


/** A segment's box by size, at 13/20 wherever it sits (a workbench's smaller control text included): `md` 32, `sm` 24 for a
 *  28 track inside a 46 bar (a tool's view). */
const SEGMENT_BOX = { md: "h-8 px-2", sm: "h-6 px-2" } satisfies Record<"md" | "sm", string>;

/** The track, and a segment on it: the thumb raised on the button's ground and edge, the rest flat in the third ink. */
const TRACK = "flex w-fit min-w-0 items-center gap-0.5 rounded-[var(--r-control)] p-sunken p-0.5";

const SEGMENT = "t-item flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--r-inner)] border";

const SEGMENT_ON = "border-[var(--c-button-line)] bg-[var(--c-button-bg)] p-text shadow-[var(--shadow-button)]";

const SEGMENT_OFF = "border-transparent p-text-3 hover:p-text";

export function Segmented<T extends string>({ label, segments, value, onChange, size = "md", disabled = false }: {
  label: string;
  segments: readonly SegmentOption<T>[];
  value: T;
  onChange: (id: T) => void;
  size?: keyof typeof SEGMENT_BOX;
  disabled?: boolean;
}) {
  const strip = useRef<HTMLDivElement>(null);
  // The tab a keystroke or click focused; null means "the selected one".
  const [focusId, setFocusId] = useState<T | null>(null);

  return (
    <div
      ref={strip}
      role="tablist"
      aria-label={label}
      className={TRACK}
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
            disabled={disabled}
            onClick={() => onChange(segment.id)}
            onFocus={() => setFocusId(segment.id)}
            aria-label={segment.icon === undefined ? undefined : segment.label}
            title={segment.icon === undefined ? undefined : segment.label}
            className={`${SEGMENT} ${segment.icon === undefined ? SEGMENT_BOX[size] : "size-7"} ${selected ? SEGMENT_ON : SEGMENT_OFF}`}
          >
            {segment.icon ?? segment.label}
            {segment.count !== undefined && (
              <span className={`t-meta tabular-nums ${selected ? "p-text-2" : "p-text-3"}`}>{segment.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Places to go, drawn as a segmented switch: each a link, the one here raised. Drive's places below `lg`. */
export function SegmentedNav({ label, segments, current, size = "md" }: {
  label: string;
  segments: readonly { readonly id: string; readonly label: string; readonly to: To; readonly state?: unknown; readonly mark?: ReactNode; readonly data?: Readonly<Record<`data-${string}`, string>> }[];
  current: string;
  size?: keyof typeof SEGMENT_BOX;
}) {
  return (
    <nav aria-label={label} className={TRACK}>
      {segments.map((segment) => (
        <Link key={segment.id} to={segment.to} state={segment.state} aria-current={segment.id === current ? "page" : undefined} {...segment.data}
          className={`${SEGMENT} ${SEGMENT_BOX[size]} ${segment.id === current ? SEGMENT_ON : SEGMENT_OFF}`}>
          {segment.label}
          {segment.mark}
        </Link>
      ))}
    </nav>
  );
}
