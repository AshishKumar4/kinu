/**
 * Choosing files from the device (docs/DESIGN-SYSTEM.md §2): the browser's file input, never drawn. A Button or a menu
 * item opens it through its ref, so the control a person sees is always the system's. `folder` picks a whole folder.
 */
import type { ComponentProps } from "react";

export function FilePicker({ folder = false, ...rest }: Omit<ComponentProps<"input">, "type" | "hidden" | "className"> & { folder?: boolean }) {
  return <input type="file" hidden {...(folder ? { webkitdirectory: "" } : {})} {...rest} />;
}
