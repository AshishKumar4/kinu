/** Nothing here fetches: the page passes each tile only the actions it can serve. */
import { useCallback, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AppWindowIcon, BroadcastIcon, DotsThreeIcon, GitBranchIcon } from "@phosphor-icons/react";
import type { LiveShareVisibility } from "@kinu.run/core";
import { useCloseOnOutsideClick } from "@/hooks/use-close-on-outside-click";
import { copyLabel, useCopy } from "@/hooks/use-copy";

type TileKind = "slate" | "blueprint" | "live";

export type TileAction =
  | { readonly label: string; readonly icon: ReactNode; readonly to: string }
  | { readonly label: string; readonly icon: ReactNode; readonly onSelect: () => void }
  | { readonly label: string; readonly icon: ReactNode; readonly copy: string };

export interface DriveTile {
  /** Unique inside its section; also what the gate addresses the tile by. */
  readonly key: string;
  readonly kind: TileKind;
  readonly name: string;
  readonly meta: readonly string[];
  readonly visibility?: LiveShareVisibility;
  readonly to?: string;
  readonly actions: readonly TileAction[];
}

const VISIBILITY_LABEL: Record<LiveShareVisibility, string> = { public: "public", users: "shared" };

const MENU_ITEM = "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm p-card-hover";

/** Percent sizing: the preview is 16:10 of whatever column the grid gives it. */
const GLYPH = "h-[26%] w-[26%] p-text-4";

function TileGlyph({ kind }: { kind: TileKind }) {
  if (kind === "slate") return <AppWindowIcon className={GLYPH} />;

  if (kind === "live") return <BroadcastIcon className={GLYPH} />;

  return <GitBranchIcon className={GLYPH} />;
}

/** A copy item keeps the menu open; its result becomes the label. */
function TileMenu({ name, actions }: { name: string; actions: readonly TileAction[] }) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const { status, copy } = useCopy();
  useCloseOnOutsideClick(open, menu, close);

  if (actions.length === 0) return null;

  return (
    <div ref={menu} className="relative shrink-0">
      <button type="button" data-drive-tile-menu aria-haspopup="menu" aria-expanded={open} aria-label={`Actions for ${name}`}
        onClick={() => setOpen((value) => !value)}
        className="rounded-md p-1 p-text-3 transition-colors hover:bg-[var(--c-elevated)] hover:p-text">
        <DotsThreeIcon size={16} weight="bold" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-10 mt-1 w-44 p-card border p-border p-1.5 p-shadow-menu">
          {actions.map((action) => {
            if ("to" in action) {
              return (
                <Link key={action.label} role="menuitem" to={action.to} data-drive-tile-action={action.label} className={MENU_ITEM} onClick={close}>
                  {action.icon} {action.label}
                </Link>
              );
            }

            if ("copy" in action) {
              return (
                <button key={action.label} type="button" role="menuitem" data-drive-tile-action={action.label} className={MENU_ITEM}
                  onClick={() => copy(action.copy)}>
                  {action.icon} {copyLabel(status, action.label)}
                </button>
              );
            }

            return (
              <button key={action.label} type="button" role="menuitem" data-drive-tile-action={action.label} className={MENU_ITEM}
                onClick={() => { setOpen(false); action.onSelect(); }}>
                {action.icon} {action.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TileCard({ tile }: { tile: DriveTile }) {
  return (
    <li data-drive-tile={tile.key} data-drive-tile-kind={tile.kind} className="p-card p-card-lift rounded-xl">
      <div className="relative flex aspect-[16/10] items-center justify-center overflow-hidden rounded-t-xl border-b p-border bg-[var(--c-elevated)]">
        <TileGlyph kind={tile.kind} />
        {tile.visibility !== undefined && (
          <span data-drive-tile-visibility className="p-badge-info absolute top-2 right-2 rounded px-1.5 py-0.5 text-[10px]">
            {VISIBILITY_LABEL[tile.visibility]}
          </span>
        )}
      </div>
      <div className="flex items-start gap-2 px-4 py-3">
        <span className="min-w-0 flex-1">
          {tile.to === undefined
            ? <span data-drive-tile-name className="block truncate p-row-text p-text">{tile.name}</span>
            : <Link to={tile.to} data-drive-tile-name className="block truncate p-row-text p-text hover:p-accent">{tile.name}</Link>}
          <span data-drive-tile-meta className="mt-0.5 block truncate p-meta p-text-3">{tile.meta.join(" · ")}</span>
        </span>
        <TileMenu name={tile.name} actions={tile.actions} />
      </div>
    </li>
  );
}

export function DriveTileSection({ title, empty, tiles }: { title: string; empty: string; tiles: readonly DriveTile[] }) {
  return (
    <section data-drive-section={title} aria-label={title}>
      <h2 className="p-heading text-[15px] p-text">{title}</h2>
      {tiles.length === 0 ? (
        <p data-drive-section-empty className="mt-1.5 p-meta p-text-4">{empty}</p>
      ) : (
        <ul className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {tiles.map((tile) => <TileCard key={tile.key} tile={tile} />)}
        </ul>
      )}
    </section>
  );
}
