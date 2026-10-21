/**
 * What a row or a thing offers past its one action, behind ⋯ (docs/DESIGN-SYSTEM.md §2): Kumo's dropdown for its keys,
 * typeahead and focus, items 32 tall with a 16 icon, a danger item in danger ink, a rule above the destructive end.
 */
import type { ComponentType, ReactNode } from "react";
import { DropdownMenu } from "@cloudflare/kumo";
import { DotsThreeIcon } from "@phosphor-icons/react";

export interface MenuItem {
  readonly label: string;
  /** The item's own attribute, which a test finds it by wherever the menu opens (`data-device-revoke`). */
  readonly marker: `data-${string}`;
  /** Its tooltip and accessible name where the label alone is ambiguous ("Revoke device"). */
  readonly title?: string;
  readonly icon: ComponentType<{ size?: number }>;
  readonly run: () => void;
  readonly danger?: boolean;
  /** A rule above it: the destructive end of the menu. */
  readonly apart?: boolean;
}

export function Menu({ label, items, trigger }: {
  label: string;
  items: readonly MenuItem[];
  /** In place of ⋯, for a menu its trigger names (a view's options). */
  trigger?: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger render={<button type="button" aria-label={label} title={label} data-row-menu className="p-menu-trigger" />}>
        {trigger ?? <DotsThreeIcon size={16} weight="bold" />}
      </DropdownMenu.Trigger>
      {/* Its positioner over a dialog's scrim (z-50) and under the design bar: a row's ⋯ opens inside Plugins' modal too. */}
      <DropdownMenu.Content align="end" className="p-menu" style={{ zIndex: 60 }}>
        {items.map(({ label: itemLabel, marker, title, icon: Icon, run, danger = false, apart = false }) => (
          <div key={itemLabel} className="contents">
            {apart && <DropdownMenu.Separator />}
            <DropdownMenu.Item {...{ [marker]: "" }} title={title} aria-label={title} variant={danger ? "danger" : "default"} icon={<Icon size={16} />} onClick={run}>
              {itemLabel}
            </DropdownMenu.Item>
          </div>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
