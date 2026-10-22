/** Something to read or set beside what opened it (docs/DESIGN-SYSTEM.md §2): Kumo's popover at the card radius. */
import type { ReactElement, ReactNode } from "react";
import { Popover as KumoPopover } from "@cloudflare/kumo";

export function Popover({ trigger, title, children }: { trigger: ReactElement; title?: string; children: ReactNode }) {
  return (
    <KumoPopover>
      <KumoPopover.Trigger render={trigger} />
      <KumoPopover.Content className="p-popover">
        {title !== undefined && <KumoPopover.Title className="t-title">{title}</KumoPopover.Title>}
        {children}
      </KumoPopover.Content>
    </KumoPopover>
  );
}
