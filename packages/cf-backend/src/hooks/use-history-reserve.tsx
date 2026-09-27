/** Unloaded history's height, above the oldest loaded row, so the scrollbar stands for the whole chat. */
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { HISTORY_RESERVE_ATTRIBUTE, SCROLL_EDGE_ATTRIBUTE } from "@/hooks/use-growing-scroll";

const FIRST_ROW_PX = 120;

export interface HistoryReserveSize {
  readonly ref: RefObject<HTMLDivElement | null>;
  readonly height: number;
}

/** Mean row pitch (gap included) over every row seen, each read once. */
export function useHistoryReserve(unread: number): HistoryReserveSize {
  const ref = useRef<HTMLDivElement | null>(null);
  const seen = useRef({ rows: new WeakSet<Element>(), pitch: 0, count: 0 });
  const [rowPx, setRowPx] = useState(FIRST_ROW_PX);

  useLayoutEffect(() => {
    const tally = seen.current;
    let row = ref.current?.nextElementSibling ?? null;

    while (row !== null) {
      const next: Element | null = row.nextElementSibling;

      if (!row.hasAttribute(SCROLL_EDGE_ATTRIBUTE)) {
        if (tally.rows.has(row) || next === null) break;
        tally.rows.add(row);
        tally.pitch += next.getBoundingClientRect().top - row.getBoundingClientRect().top;
        tally.count += 1;
      }

      row = next;
    }

    const measured = tally.count === 0 ? rowPx : Math.round(tally.pitch / tally.count);

    if (measured > 0 && measured !== rowPx) setRowPx(measured);
  });

  return { ref, height: unread * rowPx };
}

export function HistoryReserve({ reserve }: { reserve: HistoryReserveSize }) {
  if (reserve.height === 0) return null;

  return (
    <div
      ref={reserve.ref}
      {...{ [SCROLL_EDGE_ATTRIBUTE]: "", [HISTORY_RESERVE_ATTRIBUTE]: "" }}
      aria-hidden="true"
      style={{
        height: reserve.height,
        backgroundImage: "repeating-linear-gradient(to bottom, transparent 0 12px, color-mix(in srgb, currentColor 5%, transparent) 12px 20px, transparent 20px 28px)",
        backgroundSize: "60% 28px",
        backgroundRepeat: "repeat-y",
      }}
    />
  );
}
