/** A name for something that shows only an icon (docs/DESIGN-SYSTEM.md §2): inverse ink, 400 ms in, no arrow. */
import type { ReactElement, ReactNode } from "react";
import { Tooltip as KumoTooltip } from "@cloudflare/kumo";

export function Tooltip({ content, children }: { content: ReactNode; children: ReactElement }) {
  return <KumoTooltip content={content} delay={400} className="p-tooltip" render={children} />;
}
