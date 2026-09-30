/** Unread history's height, so the scrollbar stands for the whole chat. */
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  HISTORY_RESERVE_ATTRIBUTE, RESERVE_END_ATTRIBUTE, RESERVE_START_ATTRIBUTE, SCROLL_EDGE_ATTRIBUTE,
  useGrowingScroll, type GrowingScrollOptions,
} from "@/hooks/use-growing-scroll";
import type { ChatHistory } from "@/hooks/use-chat-thread";
import { HistoryBoundary } from "@/components/surfaces/shared";

const FIRST_ROW_PX = 120;

export interface ReserveRange {
  readonly start: number;
  readonly end: number;
}

/** Mean row pitch (gap included) over every row seen, each read once. */
function useRowPitch(scroller: RefObject<Element | null>): number {
  const seen = useRef({ rows: new WeakSet<Element>(), pitch: 0, count: 0 });
  const [rowPx, setRowPx] = useState(FIRST_ROW_PX);

  useLayoutEffect(() => {
    const tally = seen.current;

    for (let row = scroller.current?.firstElementChild ?? null; row !== null; row = row.nextElementSibling) {
      const next: Element | null = row.nextElementSibling;

      if (next === null || row.hasAttribute(SCROLL_EDGE_ATTRIBUTE) || tally.rows.has(row)) continue;
      tally.rows.add(row);
      tally.pitch += next.getBoundingClientRect().top - row.getBoundingClientRect().top;
      tally.count += 1;
    }

    const measured = tally.count === 0 ? rowPx : Math.round(tally.pitch / tally.count);

    if (measured > 0 && measured !== rowPx) setRowPx(measured);
  });

  return rowPx;
}

export function useReservedScroll(options: GrowingScrollOptions) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const attach = useGrowingScroll(options);

  const ref = useCallback((node: HTMLDivElement | null) => {
    scroller.current = node;
    attach(node);
  }, [attach]);

  return { ref, rowPx: useRowPitch(scroller) };
}

export function historyBoundaryError(history: ChatHistory): string | null {
  return history.errorRange === null ? history.error : null;
}

export function HistoryReserve({ range, rowPx, history }: {
  range: ReserveRange | null | undefined; rowPx: number; history: ChatHistory;
}) {
  if (range === null || range === undefined || range.end <= range.start) return null;
  const failed = history.errorRange?.start === range.start && history.errorRange.end === range.end;

  return (
    <div
      {...{
        [SCROLL_EDGE_ATTRIBUTE]: "", [HISTORY_RESERVE_ATTRIBUTE]: "",
        [RESERVE_START_ATTRIBUTE]: String(range.start), [RESERVE_END_ATTRIBUTE]: String(range.end),
      }}
      aria-hidden={failed ? undefined : true}
      style={{
        height: (range.end - range.start) * rowPx,
        backgroundImage: "repeating-linear-gradient(to bottom, transparent 0 12px, color-mix(in srgb, currentColor 5%, transparent) 12px 20px, transparent 20px 28px)",
        backgroundSize: "60% 28px",
        backgroundRepeat: "repeat-y",
      }}
    >
      {failed && <div className="sticky top-0">
        <HistoryBoundary loading={history.loading} error={history.error} exhausted={false} onRetry={history.retry} />
      </div>}
    </div>
  );
}
