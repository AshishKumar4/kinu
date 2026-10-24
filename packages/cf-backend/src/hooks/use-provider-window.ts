/** A link to a provider's sign-in whose end the page learns itself, by its poll or the code pasted back: no finish page. */
import { useMemo, useRef, type MouseEvent } from "react";
import { openProviderWindow } from "@/lib/connect-window";

interface ProviderWindow {
  /** The link's click, taken into the sign-in's popup; a click asking for a tab, or a refused popup, is left to it. */
  open: (event: MouseEvent<HTMLAnchorElement>) => void;
  /** The sign-in's popup, opened now at a button's click and blank until its caller sends it on (`location.href`) once
   *  the sign-in's address is had; null when the browser refused it. */
  reserve: () => Window | null;
  /** Closes the popup, once the page learned the sign-in ended. */
  close: () => void;
}

/**
 * The sign-in opens in its popup (`openProviderWindow`) at the link's click, and the page closes it at the end it learns.
 * A click asking for a tab (a modifier held, or not the main button), or one whose popup the browser refused, is left to
 * the link, which opens a tab of its own, as a script cannot.
 */
export function useProviderWindow(flow: string): ProviderWindow {
  const opened = useRef<Window | null>(null);

  return useMemo(() => ({
    open(event) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      opened.current?.close();
      // Named afresh: a name still open would hand back that window, gone to the provider's origin and not ours to cut.
      opened.current = openProviderWindow(`kinu-${flow}-${crypto.randomUUID()}`, event.currentTarget.href);

      if (opened.current !== null) event.preventDefault();
    },
    reserve() {
      opened.current?.close();
      opened.current = openProviderWindow(`kinu-${flow}-${crypto.randomUUID()}`);

      return opened.current;
    },
    close() {
      opened.current?.close();
      opened.current = null;
    },
  }), [flow]);
}
