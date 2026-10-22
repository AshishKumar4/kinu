/** A place with nothing in it yet (docs/DESIGN-SYSTEM.md §2): what it is for, and the one way to fill it. */
import type { ComponentType, ReactNode } from "react";

export function Empty({ icon: Icon, title, children, action }: {
  icon: ComponentType<{ size?: number; className?: string }>;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 p-12 text-center" data-empty>
      <Icon size={24} className="p-text-3" />
      <p className="t-item">{title}</p>
      {children !== undefined && <p className="max-w-sm t-body">{children}</p>}
      {action !== undefined && <div className="mt-2">{action}</div>}
    </div>
  );
}
