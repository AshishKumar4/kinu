/**
 * An icon set on a small tile of the hover wash (docs/DESIGN-SYSTEM.md §2), marking what a row or card is: a need's
 * brand, a step's kind. `sm` 20, `md` 24, `lg` 28; the icon's own size and ink stay the caller's.
 */
import type { ReactNode } from "react";

const SIZE = { sm: "size-5", md: "size-6", lg: "size-7" } satisfies Readonly<Record<string, string>>;

export function IconTile({ size = "md", className, children }: { size?: keyof typeof SIZE; className?: string; children: ReactNode }) {
  return <span className={`p-icon-tile ${SIZE[size]}${className === undefined ? "" : ` ${className}`}`}>{children}</span>;
}
