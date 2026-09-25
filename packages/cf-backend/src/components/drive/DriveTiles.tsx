/** One tile for every kind of thing in the Drive; folders are the one exception, a short chip in the same columns. */
import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  AppWindowIcon, BookOpenIcon, BroadcastIcon, DotsThreeIcon, FileCodeIcon, FileCsvIcon, FileIcon, FileImageIcon,
  FilePdfIcon, FileTextIcon, FileZipIcon, FolderSimpleIcon, GitForkIcon, LinkSimpleIcon, SquaresFourIcon,
} from "@phosphor-icons/react";
import { useCloseOnOutsideClick } from "@/hooks/use-close-on-outside-click";
import { coverLetter, hueOf, tileBadge, tileWash } from "@/components/ui/cover";

export const GRID = "grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(240px,1fr))] sm:gap-4";

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
}

export function TileMenu({ name, items, initiallyOpen = false, className }: {
  name: string;
  items: readonly MenuItem[];
  initiallyOpen?: boolean;
  className: string;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  useCloseOnOutsideClick(open, menu, close);

  if (items.length === 0) return null;

  return (
    <div ref={menu} className={`absolute ${open ? "z-50" : "z-10"} ${className}`}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`More for ${name}`} data-drive-menu
        onClick={() => setOpen((value) => !value)}
        className={`flex size-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--c-elevated)] hover:p-text ${open ? "bg-[var(--c-elevated)] p-text" : "p-text-3"}`}>
        <DotsThreeIcon size={18} weight="bold" />
      </button>
      {open && (
        <>
          <div aria-hidden="true" className="p-scrim fixed inset-0 z-40 sm:hidden" onClick={close} />
          <div role="menu" aria-label={name}
            className="fixed inset-x-3 bottom-3 z-50 p-card border p-border p-1.5 p-shadow-overlay animate-fade-in sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:z-20 sm:mt-1 sm:w-52">
            <p className="truncate px-2.5 pb-1.5 pt-1 p-meta font-medium p-text-3 sm:hidden">{name}</p>
            {items.map((item, index) => {
              const refused = item.refused === undefined ? null : { label: `${id}-${String(index)}-label`, reason: `${id}-${String(index)}-reason` };

              return (
                <div key={item.label}>
                  {item.apart === true && <div className="mx-1 my-1.5 border-t p-border" />}
                  <button type="button" role="menuitem" aria-disabled={refused === null ? undefined : true}
                    aria-labelledby={refused?.label} aria-describedby={refused?.reason}
                    {...(item.marker === undefined ? {} : { [item.marker]: "" })}
                    onClick={() => { if (refused !== null) return; setOpen(false); item.onSelect(); }}
                    className={`flex w-full gap-3 rounded-md px-2.5 py-2.5 text-left text-[15px] transition-colors sm:gap-2.5 sm:px-2 sm:py-1.5 sm:text-sm ${refused === null ? "items-center hover:bg-[var(--c-elevated)]" : "cursor-default items-start"} ${item.danger === true ? "p-danger" : "p-text"}`}>
                    <span className={`flex shrink-0 ${item.danger === true ? "" : "p-text-3"} ${refused === null ? "" : "mt-0.5 opacity-45"}`}>{item.icon}</span>
                    {refused === null ? item.label : (
                      <span className="min-w-0">
                        <span id={refused.label} className="block opacity-45">{item.label}</span>
                        <span id={refused.reason} className="mt-0.5 block p-meta p-text-3">{item.refused}</span>
                      </span>
                    )}
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
      <Opener href={href} onOpen={onOpen} label={title}
        className="flex h-full flex-col overflow-hidden rounded-[14px] border p-border p-surface p-card-lift focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-accent)]">
        <span className="relative block aspect-[16/10] shrink-0 overflow-hidden border-b p-border">{picture}</span>
        <span className="flex flex-1 items-start gap-2.5 py-2.5 pl-3 pr-9 sm:pr-10">
          <span className="mt-0.5 hidden size-5 shrink-0 items-center justify-center p-text-3 sm:flex">{icon}</span>
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 break-words p-row-text font-medium p-text" data-drive-tile-name>
              {unseen && <span className="mb-px mr-1.5 inline-block size-1.5 rounded-full p-dot-accent align-middle" title="New" />}
              {title}
            </span>
            <span className="mt-px flex min-w-0 items-center gap-1.5 p-meta p-text-3" data-drive-tile-meta>{meta}</span>
          </span>
        </span>
      </Opener>
      <TileMenu name={title} items={menu} initiallyOpen={menuOpen} className="bottom-2.5 right-1.5 sm:bottom-3 sm:right-2" />
    </li>
  );
}

export function FolderTile({ href, name, icon, menu, attributes }: {
  href: string;
  name: string;
  icon: ReactNode;
  menu: readonly MenuItem[];
  attributes?: DataAttributes;
}) {
  return (
    <li className="relative min-w-0" {...attributes}>
      <Link to={href} className="flex h-12 items-center gap-2.5 rounded-lg border p-border p-surface pl-3.5 pr-10 p-card-lift">
        <span className="flex shrink-0">{icon}</span>
        <span className="truncate p-row-text font-medium p-text" data-drive-tile-name>{name}</span>
      </Link>
      <TileMenu name={name} items={menu} className="right-2 top-2.5" />
    </li>
  );
}

/** The picture of a slate or share until it has one of its own. */
export function Cover({ title, seed = title }: { title: string; seed?: string }) {
  const hue = hueOf(seed);

  return (
    <span className="absolute inset-0 flex items-center justify-center p-recessed" style={tileWash(hue)}>
      <span aria-hidden="true" className="flex size-11 items-center justify-center rounded-xl text-lg font-semibold" style={tileBadge(hue)}>
        {coverLetter(title)}
      </span>
    </span>
  );
}

export function FileCover({ name, image }: { name: string; image?: string }) {
  if (image !== undefined) {
    return <img src={image} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />;
  }

  const extension = name.includes(".") ? name.split(".").at(-1) ?? "" : "";

  return (
    <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-recessed">
      <span className="p-text-4 [&>svg]:size-[34px]">{fileIcon(name)}</span>
      {extension !== "" && <span className="p-annotation uppercase p-text-3">{extension}</span>}
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
