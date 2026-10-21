/** One tile for every kind of thing in the Drive; folders are the one exception, a short chip in the same columns. */
import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  AppWindowIcon, BookOpenIcon, BroadcastIcon, CheckIcon, DotsThreeIcon, FileCodeIcon, FileCsvIcon, FileIcon, FileImageIcon,
  FilePdfIcon, FileTextIcon, FileZipIcon, FolderSimpleIcon, GitForkIcon, LinkSimpleIcon, SquaresFourIcon,
} from "@phosphor-icons/react";
import { useCloseOnOutsideClick } from "@/hooks/use-close-on-outside-click";
import { TILE, TILE_GRID, TileShell } from "@/components/ui/Tiles";

export const GRID = TILE_GRID;

type DataAttributes = Readonly<Record<`data-${string}`, string>>;

export interface MenuItem {
  readonly label: string;
  readonly icon: ReactNode;
  readonly onSelect: () => void;
  readonly danger?: boolean;
  /** A rule above the item: the destructive end of the menu. */
  readonly apart?: boolean;
  /** Offered but refused: it stays reachable, with the reason under its label. */
  readonly refused?: string;
  readonly marker?: `data-${string}`;
  /** A choice the menu shows as made or not: a box, or one of a set (`radio`). */
  readonly checked?: boolean;
  readonly radio?: true;
}

/** What opens a menu: `More for <name>` behind ⋯ unless another is named; `className` sizes it among other controls. */
interface MenuTrigger { readonly icon: ReactNode; readonly label: string; readonly className?: string }

/** `className` places it: the caller's position (`absolute …`, or `relative` in a row of controls). */
export function TileMenu({ name, items, initiallyOpen = false, className, trigger }: {
  name: string;
  items: readonly MenuItem[];
  initiallyOpen?: boolean;
  className: string;
  trigger?: MenuTrigger;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  useCloseOnOutsideClick(open, menu, close);

  if (items.length === 0) return null;

  return (
    <div ref={menu} className={`${open ? "z-50" : "z-10"} ${className}`}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={trigger?.label ?? `More for ${name}`} title={trigger?.label}
        data-drive-menu onClick={() => setOpen((value) => !value)}
        className={`flex items-center justify-center transition-colors hover:p-text ${trigger?.className ?? "size-7 rounded-[var(--r-control)] hover:bg-[var(--c-hover)]"} ${open ? "bg-[var(--c-fill)] p-text" : "p-text-3"}`}>
        {trigger?.icon ?? <DotsThreeIcon size={18} weight="bold" />}
      </button>
      {open && (
        <>
          <div aria-hidden="true" className="p-scrim fixed inset-0 z-40 sm:hidden" onClick={close} />
          <div role="menu" aria-label={name}
            className="fixed inset-x-3 bottom-3 z-50 p-card border p-border p-1 p-shadow-overlay animate-fade-in font-sans sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:z-20 sm:mt-1 sm:w-52">
            <p className="t-status truncate px-2 pb-1 pt-1 p-text-3 sm:hidden">{name}</p>
            {items.map((item, index) => {
              const refused = item.refused === undefined ? null : { label: `${id}-${String(index)}-label`, reason: `${id}-${String(index)}-reason` };

              return (
                <div key={item.label}>
                  {item.apart === true && <div className="mx-1 my-2 border-t p-border" />}
                  <button type="button" role={menuRole(item)} aria-checked={item.checked} aria-disabled={refused === null ? undefined : true}
                    aria-labelledby={refused?.label} aria-describedby={refused?.reason}
                    {...(item.marker === undefined ? {} : { [item.marker]: "" })}
                    onClick={() => { if (refused !== null) return; setOpen(false); item.onSelect(); }}
                    className={`t-body flex w-full gap-3 rounded-md px-2 py-2 text-left transition-colors sm:gap-3 sm:px-2 sm:py-1 ${refused === null ? "items-center hover:bg-[var(--c-hover)]" : "cursor-default items-start"}  ${item.danger === true ? "p-danger" : "p-text"}`}>
                    <span className={`flex shrink-0 ${item.danger === true ? "" : "p-text-3"} ${refused === null ? "" : "mt-px opacity-45"}`}>{item.icon}</span>
                    {refused === null ? item.label : (
                      <span className="min-w-0">
                        <span id={refused.label} className="block opacity-45">{item.label}</span>
                        <span id={refused.reason} className="t-meta mt-px block p-text-3">{item.refused}</span>
                      </span>
                    )}
                    {item.checked === true && <CheckIcon size={14} weight="bold" className="ml-auto shrink-0 p-accent" />}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function menuRole(item: MenuItem): "menuitem" | "menuitemcheckbox" | "menuitemradio" {
  if (item.checked === undefined) return "menuitem";

  return item.radio === true ? "menuitemradio" : "menuitemcheckbox";
}

function Opener({ href, onOpen, className, label, children }: {
  href?: string;
  onOpen?: () => void;
  className: string;
  label: string;
  children: ReactNode;
}) {
  if (href !== undefined) return <Link to={href} aria-label={label} className={className}>{children}</Link>;

  if (onOpen === undefined) return <div className={className}>{children}</div>;

  return <button type="button" aria-label={label} onClick={onOpen} className={`w-full text-left ${className}`}>{children}</button>;
}

export function Tile({ href, onOpen, picture, icon, title, meta, unseen = false, menu, menuOpen = false, attributes }: {
  href?: string;
  onOpen?: () => void;
  picture: ReactNode;
  icon: ReactNode;
  title: string;
  meta: ReactNode;
  unseen?: boolean;
  menu: readonly MenuItem[];
  menuOpen?: boolean;
  attributes?: DataAttributes;
}) {
  return (
    <li className="relative min-w-0" {...attributes}>
      <Opener href={href} onOpen={onOpen} label={title} className={TILE}>
        <TileShell cover={picture} title={(
          <span data-drive-tile-name>
            {unseen && <span className="mb-px mr-2 inline-block size-1.5 rounded-full p-dot-accent align-middle" title="New" />}
            {title}
          </span>
        )}>
          <span className="t-meta flex min-w-0 items-center gap-2 pr-8 p-text-3">
            <span className="flex shrink-0 [&>svg]:size-3.5">{icon}</span>
            <span className="flex min-w-0 items-center gap-2" data-drive-tile-meta>{meta}</span>
          </span>
        </TileShell>
      </Opener>
      <TileMenu name={title} items={menu} initiallyOpen={menuOpen} className="absolute bottom-3 right-2" />
    </li>
  );
}

/** A folder: a row of a `p-group` (`row`), as My stuff lists its folders, or a card among a grid's tiles. */
export function FolderTile({ href, name, icon, menu, attributes, row = false }: {
  href: string;
  name: string;
  icon: ReactNode;
  menu: readonly MenuItem[];
  attributes?: DataAttributes;
  row?: boolean;
}) {
  return (
    <li className="relative min-w-0" {...attributes}>
      <Link to={href} className={`flex h-12 items-center gap-3 pl-3 pr-8 ${row ? "p-row-hover" : "rounded-lg border p-border p-surface p-card-lift"}`}>
        <span className="flex shrink-0">{icon}</span>
        <span className="t-item truncate p-text" data-drive-tile-name>{name}</span>
      </Link>
      <TileMenu name={name} items={menu} className="absolute right-2 top-3" />
    </li>
  );
}

export function FileCover({ name, image }: { name: string; image?: string }) {
  if (image !== undefined) {
    return <img src={image} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />;
  }

  const extension = name.includes(".") ? name.split(".").at(-1) ?? "" : "";

  return (
    <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-sunken">
      <span className="p-text-3 [&>svg]:size-[34px]">{fileIcon(name)}</span>
      {extension !== "" && <span className="t-meta t-mono uppercase p-text-3">{extension}</span>}
    </span>
  );
}

export const FOLDER_ICON = <FolderSimpleIcon size={18} weight="fill" className="p-info" />;

export const LINK_ICON = <LinkSimpleIcon size={18} className="p-info" />;

export const SKILLS_ICON = <BookOpenIcon size={18} weight="fill" className="p-success" />;

export const SLATE_ICON = <AppWindowIcon size={16} />;

export const SHARE_ICON = {
  live: <BroadcastIcon size={16} />,
  blueprint: <GitForkIcon size={16} />,
  workspace: <SquaresFourIcon size={16} />,
} as const;

export function fileIcon(name: string): ReactNode {
  switch (name.split(".").at(-1)?.toLowerCase()) {
    case "md":
    case "markdown":
    case "txt": return <FileTextIcon size={16} />;
    case "csv":
    case "tsv": return <FileCsvIcon size={16} />;
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "svg": return <FileImageIcon size={16} />;
    case "pdf": return <FilePdfIcon size={16} />;
    case "ts":
    case "tsx":
    case "js":
    case "json":
    case "py":
    case "sh": return <FileCodeIcon size={16} />;
    case "zip": return <FileZipIcon size={16} />;
    case undefined:
    default: return <FileIcon size={16} />;
  }
}
