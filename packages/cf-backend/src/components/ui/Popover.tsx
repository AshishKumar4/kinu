/** Something to read or set beside what opened it (docs/DESIGN-SYSTEM.md §2): Kumo's popover at the card radius. It
 *  takes focus as it opens, gives it back on Escape, and keeps to the room the window has beside its trigger. */
import type { ReactElement, ReactNode } from "react";
import { Popover as KumoPopover } from "@cloudflare/kumo";

export function Popover({ trigger, title, label, open, onOpenChange, side, align, className, children }: {
  trigger: ReactElement;
  title?: string;
  /** Its name for a screen reader, where it shows no title. */
  label?: string;
  /** Held by its caller, which hears each change. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  className?: string;
  children: ReactNode;
}) {
  return (
    <KumoPopover {...(open !== undefined && { open })} {...(onOpenChange !== undefined && { onOpenChange: (next: boolean) => { onOpenChange(next); } })}>
      <KumoPopover.Trigger render={trigger} />
      <KumoPopover.Content className={className ?? "p-popover"} {...(side !== undefined && { side })} {...(align !== undefined && { align })}>
        {title !== undefined && <KumoPopover.Title className="t-title">{title}</KumoPopover.Title>}
        {label !== undefined && <KumoPopover.Title className="sr-only">{label}</KumoPopover.Title>}
        {children}
      </KumoPopover.Content>
    </KumoPopover>
  );
}
