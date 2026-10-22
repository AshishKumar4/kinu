/**
 * An underline strip of places (docs/DESIGN-SYSTEM.md §2): 40 tall, each a link or a press, the current one in the
 * accent's ink over a 2 px bar on the strip's hairline. Workspace tabs are their own and stay as they are.
 */
import type { ComponentType } from "react";
import { Link } from "react-router-dom";

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ComponentType<{ size?: number; className?: string }>;
  /** A route; else the tab is pressed and `onChoose` hears it. */
  readonly to?: string;
}

export function Tabs({ label, items, current, onChoose }: {
  label: string;
  items: readonly TabItem[];
  current: string;
  onChoose?: (id: string) => void;
}) {
  return (
    <nav aria-label={label} className="p-tabs">
      {items.map(({ id, label: name, icon: Icon, to }) => {
        const here = id === current;
        const inner = <>{Icon !== undefined && <Icon size={16} className={here ? "" : "p-text-3"} />}{name}</>;

        if (to !== undefined) return <Link key={id} to={to} aria-current={here ? "page" : undefined} data-tab={id} className="p-tabs-tab">{inner}</Link>;

        return <button key={id} type="button" aria-current={here ? "page" : undefined} data-tab={id} onClick={() => onChoose?.(id)} className="p-tabs-tab">{inner}</button>;
      })}
    </nav>
  );
}
