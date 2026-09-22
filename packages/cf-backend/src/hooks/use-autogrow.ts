import { useLayoutEffect, type RefObject } from "react";

/** Size a textarea to its content on every change of `value` (kumo's InputArea
 *  has no resize logic). A `max-h-*` class on the element clamps the growth;
 *  past it the textarea scrolls internally, and an emptied value collapses it
 *  back to one row. */
export function useAutogrow(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    const el = ref.current;

    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}
