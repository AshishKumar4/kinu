import { useEffect, type RefObject } from "react";

function pixelsOf(event: WheelEvent, page: number): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16;

  return event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? event.deltaY * page : event.deltaY;
}

/** A vertical wheel scrolls a tab strip whose scrollbar is hidden. */
export function useWheelScrollsSideways(strip: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = strip.current;

    if (element === null) return;

    // React's wheel listener is passive, so it could not keep the page still.
    const onWheel = (event: WheelEvent): void => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const before = element.scrollLeft;

      element.scrollLeft += pixelsOf(event, element.clientWidth);

      if (element.scrollLeft !== before) event.preventDefault();
    };

    element.addEventListener("wheel", onWheel, { passive: false });

    return () => element.removeEventListener("wheel", onWheel);
  }, [strip]);
}
