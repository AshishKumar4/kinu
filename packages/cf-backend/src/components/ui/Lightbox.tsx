/**
 * Pictures at full size over the page (docs/DESIGN-SYSTEM.md §2, Dialog for media): `LightboxFrame` the dialog,
 * `ShotFrame` a picture in the thread that opens it, `LightboxStep` the previous or next one. Their CSS is the approved lightbox's.
 */
import type { ComponentProps, KeyboardEvent, ReactNode } from "react";
import { Dialog } from "@cloudflare/kumo/primitives/dialog";

/** The lightbox over the whole window: Base UI's dialog for focus and Escape; a press on its ground closes it, and
 *  `onKeyDown` hears the keys that step through it. Portalled above every pane, whatever transform its opener's column
 *  carries. */
export function LightboxFrame({ label, onClose, onKeyDown, children }: {
  label: string;
  onClose: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal className="isolate">
        <Dialog.Popup className="p-lightbox outline-none" aria-label={label} onKeyDown={onKeyDown}
          onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ShotFrame({ className, type = "button", ...rest }: ComponentProps<"button">) {
  return <button type={type} className={`p-shot-frame${className === undefined ? "" : ` ${className}`}`} {...rest} />;
}

/** `side` sets it at the stage's left or right edge. */
export function LightboxStep({ side, className, type = "button", ...rest }: ComponentProps<"button"> & { side: "left" | "right" }) {
  return <button type={type} className={`p-lightbox-step ${side === "left" ? "left-4" : "right-4"}${className === undefined ? "" : ` ${className}`}`} {...rest} />;
}
