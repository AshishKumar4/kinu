/** One tile for every kind of thing in the Drive; folders are the one exception, a short chip in the same columns. */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  AppWindowIcon, BookOpenIcon, BroadcastIcon, FileCodeIcon, FileCsvIcon, FileIcon, FileImageIcon,
  FilePdfIcon, FileTextIcon, FileZipIcon, FolderSimpleIcon, GitForkIcon, LinkSimpleIcon, SquaresFourIcon,
} from "@phosphor-icons/react";
import { TILE, TILE_GRID, TileShell } from "@/components/ui/Tiles";
import { Dot } from "@/components/ui/Dot";
import { Menu, type MenuItem } from "@/components/ui/Menu";

export const GRID = TILE_GRID;

type DataAttributes = Readonly<Record<`data-${string}`, string>>;

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
            {unseen && <Dot tone="accent" label="New" className="mb-px mr-2 align-middle" />}
            {title}
          </span>
        )}>
          <span className="t-meta flex min-w-0 items-center gap-2 pr-8 p-text-3">
            <span className="flex shrink-0 [&>svg]:size-3.5">{icon}</span>
            <span className="flex min-w-0 items-center gap-2" data-drive-tile-meta>{meta}</span>
          </span>
        </TileShell>
      </Opener>
      <Menu name={title} items={menu} initiallyOpen={menuOpen} className="absolute bottom-3 right-2" />
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
      <Menu name={name} items={menu} className="absolute right-2 top-3" />
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
