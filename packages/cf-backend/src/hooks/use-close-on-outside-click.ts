/**
 * Closes a menu on a press outside it. Inside is its React tree, not only its DOM: a dialog the menu opened is
 * portalled out of the menu's box, and a press in it must not close the menu that holds the dialog (and end the
 * dialog's work with it). `onClickCapture` goes on the menu's root, which React reaches before the document does.
 */
import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type RefObject } from "react";

export function useCloseOnOutsideClick(open: boolean, menu: RefObject<HTMLElement | null>, close: () => void) {
  const inside = useRef<Event | null>(null);

  useEffect(() => {
    if (!open) return;

    const onClick = (event: MouseEvent) => {
      if (inside.current === event || menu.current === null || !(event.target instanceof Node)) return;

      if (!menu.current.contains(event.target)) close();
    };

    document.addEventListener("click", onClick);

    return () => document.removeEventListener("click", onClick);
  }, [open, menu, close]);

  return { onClickCapture: (event: ReactMouseEvent) => { inside.current = event.nativeEvent; } };
}
