/**
 * Choosing files from the device (docs/DESIGN-SYSTEM.md §2): the browser's file input, never drawn. A Button or a menu
 * item opens it through its ref, so the control a person sees is always the system's. `folder` picks a whole folder.
 */
import type { ComponentProps, ReactNode } from "react";

export function FilePicker({ folder = false, ...rest }: Omit<ComponentProps<"input">, "type" | "hidden" | "className"> & { folder?: boolean }) {
  return <input type="file" hidden {...(folder ? { webkitdirectory: "" } : {})} {...rest} />;
}

/** Over a place files can be dropped on, while they are held over it: what dropping them does, on the accent. `flush`
 *  keeps the edge inside the place, where it fills its column to the brim (the chat's). */
export function DropHint({ flush = false, children }: { flush?: boolean; children: ReactNode }) {
  return (
    <div aria-hidden="true" className="p-drop-hint" data-flush={flush ? "" : undefined}>
      <span className="t-label p-drop-hint-words">{children}</span>
    </div>
  );
}
