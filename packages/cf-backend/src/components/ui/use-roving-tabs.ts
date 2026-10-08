/** WAI-ARIA tabs: one tab stop; arrows, Home and End move focus; a click, Enter or Space opens. */
import { useState, type FocusEvent, type KeyboardEvent, type RefObject } from "react";

function stepped(key: string, index: number, count: number): number | null {
  switch (key) {
    case "ArrowLeft": return (index - 1 + count) % count;
    case "ArrowRight": return (index + 1) % count;
    case "Home": return 0;
    case "End": return count - 1;
    default: return null;
  }
}

/** `ids` in drawn order; `selected` is the open tab, or null when the open panel has no tab in this strip. */
export function useRovingTabs<T extends string>(strip: RefObject<HTMLElement | null>, ids: readonly T[], selected: T | null) {
  const [focused, setFocused] = useState<T | null>(null);
  const open = selected !== null && ids.includes(selected) ? selected : ids[0];
  const stop = focused !== null && ids.includes(focused) ? focused : open;

  const list = {
    role: "tablist" as const,
    onKeyDown: (event: KeyboardEvent<HTMLElement>): void => {
      const next = stop === undefined ? null : stepped(event.key, ids.indexOf(stop), ids.length);

      if (next === null) return;
      event.preventDefault();
      const id = ids[next];

      if (id === undefined) return;
      setFocused(id);
      strip.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
    },
    onBlur: (event: FocusEvent<HTMLElement>): void => {
      if (!(event.relatedTarget instanceof Node) || !strip.current?.contains(event.relatedTarget)) setFocused(null);
    },
  };

  const tab = (id: T) => ({
    role: "tab" as const,
    "aria-selected": id === selected,
    tabIndex: id === stop ? 0 : -1,
    onFocus: () => setFocused(id),
  });

  return { list, tab };
}
