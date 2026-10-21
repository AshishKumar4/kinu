/** A name for something that shows only an icon (docs/DESIGN-SYSTEM.md §2): inverse ink, 400 ms in, no arrow. */
import type { ReactElement, ReactNode } from "react";
import { Tooltip as KumoTooltip } from "@cloudflare/kumo";

export function Tooltip({ content, children }: { content: ReactNode; children: ReactElement }) {
  // Kumo puts `className` on the trigger, so the words carry the look and the popup around them is styled by its data.
  return <KumoTooltip content={<span data-tooltip-body>{content}</span>} delay={400} render={children} />;
}
