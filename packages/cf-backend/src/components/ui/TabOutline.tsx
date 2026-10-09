/** The browser-tab hairline both bars draw: one line that is the bar's bottom rule and the open tab's silhouette, and
 *  glides between tabs. A list draws it flat when its open tab is in another list. */
import { useLayoutEffect, useRef, useState, type RefObject } from "react";

type Overflow = "none" | "start" | "end" | "both";

function overflowOf(list: HTMLElement): Overflow {
  const start = list.scrollLeft > 1;
  const end = list.scrollWidth - list.clientWidth - list.scrollLeft > 1;

  if (start && end) return "both";

  if (start) return "start";

  return end ? "end" : "none";
}

/** The open tab's edges in the strip's content; with none, the rule runs flat. */
interface OutlineGeometry { readonly left: number; readonly right: number; readonly width: number }

const FLARE = 8;

export interface TabOutlineState {
  readonly geometry: OutlineGeometry | null;
  readonly glide: boolean;
  readonly overflow: Overflow;
  readonly settle: () => void;
}

/** One hairline in five parts: rule, concave flare, the tab's body, flare, rule. */
export function TabOutline({ outline }: { outline: TabOutlineState }) {
  const { geometry, glide, settle } = outline;

  if (geometry === null) return null;
  const { left, right, width } = geometry;
  const flat = left === right;

  return (
    <li aria-hidden className="p-bar-outline" style={{ width }} data-glide={glide ? "" : undefined} onTransitionEnd={settle}>
      <span data-part="arm-start" style={{ width: flat ? width : left + 1 }} />
      {!flat && <>
        <span data-part="flare-start" style={{ left: left + 1 }} />
        <span data-part="body" style={{ left: left + FLARE, width: right - left - 2 * FLARE }} />
        <span data-part="flare-end" style={{ left: right - FLARE - 1 }} />
        <span data-part="arm-end" style={{ left: right - 1 }} />
      </>}
    </li>
  );
}

/** Where the list's content ends: its last item, not the outline drawn over them. */
function contentEnd(list: HTMLElement): number {
  let end = 0;

  for (const child of list.children) {
    if (child instanceof HTMLElement && !child.classList.contains("p-bar-outline")) end = Math.max(end, child.offsetLeft + child.offsetWidth);
  }

  return end;
}

/**
 * Measures the open tab (`data-key` = `active`) inside the list's scrolled content. Only a selection change glides; a
 * resize, a rename or the first paint lands in place, so nothing moves that the person did not move.
 */
export function useTabOutline(strip: RefObject<HTMLUListElement | null>, active: string | null, layout: string): TabOutlineState {
  const [geometry, setGeometry] = useState<OutlineGeometry | null>(null);
  const [glide, setGlide] = useState(false);
  const [overflow, setOverflow] = useState<Overflow>("none");
  const shownKey = useRef<string | null>(null);

  useLayoutEffect(() => {
    const list = strip.current;

    if (list === null) return undefined;
    const tab = active === null ? null : list.querySelector<HTMLElement>(`[data-key="${CSS.escape(active)}"]`);

    const place = () => {
      const width = Math.max(list.clientWidth, contentEnd(list));

      setGeometry(tab === null ? { left: width, right: width, width } : { left: tab.offsetLeft, right: tab.offsetLeft + tab.offsetWidth, width });
      setOverflow(overflowOf(list));
    };

    if (shownKey.current !== null && active !== null && shownKey.current !== active) setGlide(true);
    shownKey.current = active;
    place();

    if (tab !== null) list.scrollLeft = Math.min(tab.offsetLeft, Math.max(list.scrollLeft, tab.offsetLeft + tab.offsetWidth - list.clientWidth));

    const observer = new ResizeObserver(place);
    const scrolled = () => setOverflow(overflowOf(list));

    observer.observe(list);

    for (const child of list.children) observer.observe(child);

    list.addEventListener("scroll", scrolled, { passive: true });

    return () => {
      observer.disconnect();
      list.removeEventListener("scroll", scrolled);
    };
  }, [strip, active, layout]);

  return { geometry, glide, overflow, settle: () => setGlide(false) };
}
