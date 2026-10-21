/**
 * What a row or a thing offers past its one action, behind ⋯ (docs/DESIGN-SYSTEM.md §2): Base UI's menu, through Kumo's
 * primitives, for its keys, typeahead, focus and ARIA. Items are 32 tall with a 16 icon; a danger item is in danger ink;
 * a rule sits above the destructive end. On a phone the same menu rises from the bottom edge as a sheet over a scrim,
 * named by what it is for; its keys and focus are the menu's own either way. A choice, a box or one of a set, closes it
 * as any item does.
 */
import { Fragment, useId, type ReactElement, type ReactNode } from "react";
import { CheckIcon, DotsThreeIcon } from "@phosphor-icons/react";
import { Menu as Base } from "@cloudflare/kumo/primitives/menu";
import { useMediaQuery } from "@/hooks/use-media-query";

export interface MenuItem {
  readonly label: string;
  readonly icon?: ReactNode;
  readonly onSelect: () => void;
  readonly danger?: boolean;
  /** A rule above the item: the destructive end of the menu. */
  readonly apart?: boolean;
  /** Offered but refused: it stays in the menu, disabled, with the reason under its label. */
  readonly refused?: string;
  readonly marker?: `data-${string}`;
  /** A choice the menu shows as made or not: a box, or one of a set (`radio`). */
  readonly checked?: boolean;
  readonly radio?: true;
  /** Its tooltip where the label alone is ambiguous ("Revoke device"). */
  readonly title?: string;
}

/** What opens a menu in place of ⋯, named by `label`: an icon in ⋯'s square, or a control of the page's own (its New). */
export type MenuTrigger = { readonly label: string } & ({ readonly icon: ReactNode } | { readonly control: ReactElement });

/** A point 12 above the middle of the viewport's bottom edge: where a phone's sheet rises from. */
const BOTTOM_EDGE = {
  getBoundingClientRect: () => DOMRect.fromRect({ x: window.innerWidth / 2, y: window.innerHeight - 12, width: 0, height: 0 }),
};

export function Menu({ name, items, trigger, className, initiallyOpen = false }: {
  /** What the menu is for: the trigger's name ("More for X") and the sheet's title. */
  name: string;
  items: readonly MenuItem[];
  trigger?: MenuTrigger;
  /** Placement of the trigger only. */
  className?: string;
  initiallyOpen?: boolean;
}) {
  const sheet = !useMediaQuery("(min-width: 640px)");

  if (items.length === 0) return null;

  const label = trigger?.label ?? `More for ${name}`;

  return (
    // A sheet holds the page still under its scrim; a desktop menu lets a press elsewhere close it and land.
    <Base.Root defaultOpen={initiallyOpen} modal={sheet}>
      {trigger !== undefined && "control" in trigger
        ? <Base.Trigger render={trigger.control} aria-label={label} />
        : (
          <Base.Trigger aria-label={label} title={label} data-row-menu className={`p-menu-trigger${className === undefined ? "" : ` ${className}`}`}>
            {trigger?.icon ?? <DotsThreeIcon size={16} weight="bold" />}
          </Base.Trigger>
        )}
      <Base.Portal>
        {sheet && <Base.Backdrop className="p-menu-scrim" />}
        <Base.Positioner className="p-menu-positioner" {...(sheet ? { anchor: BOTTOM_EDGE, side: "top", align: "center", sideOffset: 0 } : { align: "end", sideOffset: 4 })}>
          <Base.Popup className="p-menu" aria-label={name} data-sheet={sheet ? "" : undefined}>
            {sheet && <p className="p-menu-name t-status">{name}</p>}
            <Items items={items} />
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}

/** The items in order, a run of `radio` items as one group whose value is the checked one. */
function Items({ items }: { items: readonly MenuItem[] }) {
  const runs: MenuItem[][] = [];

  for (const item of items) {
    const last = runs.at(-1);

    if (item.radio === true && last?.[0]?.radio === true && item.apart !== true) last.push(item);
    else runs.push([item]);
  }

  return runs.map((run) => {
    const [first] = run;

    if (first === undefined) return null;

    if (first.radio !== true) return <Fragment key={first.label}>{first.apart === true && <Base.Separator className="p-menu-rule" />}<One item={first} /></Fragment>;

    return (
      <Fragment key={first.label}>
        {first.apart === true && <Base.Separator className="p-menu-rule" />}
        <Base.RadioGroup value={run.find((item) => item.checked === true)?.label ?? null}
          onValueChange={(value) => run.find((item) => item.label === value)?.onSelect()}>
          {run.map((item) => (
            <Base.RadioItem key={item.label} value={item.label} closeOnClick title={item.title} className="p-menu-item" {...marker(item)}>
              <Face item={item} />
              <Base.RadioItemIndicator className="p-menu-check"><CheckIcon size={14} weight="bold" /></Base.RadioItemIndicator>
            </Base.RadioItem>
          ))}
        </Base.RadioGroup>
      </Fragment>
    );
  });
}

function One({ item }: { item: MenuItem }) {
  const look = `p-menu-item${item.danger === true ? " p-menu-danger" : ""}`;

  if (item.checked !== undefined) {
    return (
      <Base.CheckboxItem checked={item.checked} onCheckedChange={() => item.onSelect()} closeOnClick title={item.title} className={look} {...marker(item)}>
        <Face item={item} />
        <Base.CheckboxItemIndicator className="p-menu-check"><CheckIcon size={14} weight="bold" /></Base.CheckboxItemIndicator>
      </Base.CheckboxItem>
    );
  }

  return <Plain item={item} look={look} />;
}

/** An item to press; a refused one is disabled, named by its label and described by its reason. */
function Plain({ item, look }: { item: MenuItem; look: string }) {
  const id = useId();
  const named = item.refused === undefined ? {} : { "aria-labelledby": `${id}-label`, "aria-describedby": `${id}-reason` };

  return (
    <Base.Item disabled={item.refused !== undefined} onClick={() => item.onSelect()} title={item.title} className={look} {...named} {...marker(item)}>
      <Face item={item} id={id} />
    </Base.Item>
  );
}

/** Icon and label; a refused item's reason under its label, each with the id `Plain` names it by. */
function Face({ item, id }: { item: MenuItem; id?: string }) {
  return (
    <>
      {item.icon !== undefined && <span className="p-menu-icon">{item.icon}</span>}
      {item.refused === undefined ? <span className="min-w-0 flex-1 truncate">{item.label}</span> : (
        <span className="min-w-0 flex-1">
          <span id={`${id ?? ""}-label`} className="block">{item.label}</span>
          <span id={`${id ?? ""}-reason`} className="t-meta block">{item.refused}</span>
        </span>
      )}
    </>
  );
}

function marker(item: MenuItem): Readonly<Record<string, string>> {
  return item.marker === undefined ? {} : { [item.marker]: "" };
}
