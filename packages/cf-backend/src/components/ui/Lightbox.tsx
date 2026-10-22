/**
 * Pictures at full size over the page (docs/DESIGN-SYSTEM.md §2, Dialog for media): `ShotFrame` a picture in the thread
 * that opens it, `LightboxStep` the previous or next one. Their CSS is the approved lightbox's.
 */
import type { ComponentProps } from "react";

export function ShotFrame({ className, type = "button", ...rest }: ComponentProps<"button">) {
  return <button type={type} className={`p-shot-frame${className === undefined ? "" : ` ${className}`}`} {...rest} />;
}

/** `side` sets it at the stage's left or right edge. */
export function LightboxStep({ side, className, type = "button", ...rest }: ComponentProps<"button"> & { side: "left" | "right" }) {
  return <button type={type} className={`p-lightbox-step ${side === "left" ? "left-4" : "right-4"}${className === undefined ? "" : ` ${className}`}`} {...rest} />;
}
