import { useLayoutEffect, type RefObject } from "react";

/** kumo's InputArea has no resize logic; a `max-h-*` class clamps growth. */
export function useAutogrow(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    const el = ref.current;

    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}
