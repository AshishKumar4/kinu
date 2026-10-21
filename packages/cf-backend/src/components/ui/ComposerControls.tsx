/**
 * The approved composer's own controls (docs/DESIGN-SYSTEM.md §2, Composer), their CSS the composer's: the one filled
 * circle (`send`: Send, Steer, and Stop with nothing drafted) and a quiet word in its row (`word`: Auto, Plan, Recover,
 * Branch), pressed where it is a mode.
 */
import type { ComponentProps } from "react";

const LOOK = { send: "p-composer-send", word: "p-composer-quiet" } satisfies Readonly<Record<string, string>>;

export function ComposerButton({ look, className, type = "button", ...rest }: ComponentProps<"button"> & { look: keyof typeof LOOK }) {
  return <button type={type} className={`${LOOK[look]}${className === undefined ? "" : ` ${className}`}`} {...rest} />;
}
