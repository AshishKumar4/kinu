/** Unloaded history's height, above the oldest loaded row, so the scrollbar stands for the whole chat. */
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { HISTORY_RESERVE_ATTRIBUTE, SCROLL_EDGE_ATTRIBUTE } from "@/hooks/use-growing-scroll";

const FIRST_ROW_PX = 120;

const SAMPLE_ROWS = 40;


export interface HistoryReserveSize {
  readonly ref: RefObject<HTMLDivElement | null>;
  readonly height: number;
}

export function useHistoryReserve(unread: number): HistoryReserveSize {
  const ref = useRef<HTMLDivElement | null>(null);
  const [rowPx, setRowPx] = useState(FIRST_ROW_PX);

  useLayoutEffect(() => {
    const rows: Element[] = [];

    for (let row = ref.current?.nextElementSibling ?? null; row !== null && rows.length < SAMPLE_ROWS; row = row.nextElementSibling) {
      if (!row.hasAttribute(SCROLL_EDGE_ATTRIBUTE)) rows.push(row);
    }

    if (rows.length === 0) return;
    const measured = Math.round(rows.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0) / rows.length);

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
