/**
 * One tile system for every grid of things to open (design review 2026-10-20, "tiles"): Workspaces, Explore and Drive.
 * Tiles are 300 px or more across, with a 20 px gap: 349 at 1440 and 1920, 312 at 1280, one column on a phone. A tile
 * is a 16:10 cover over a hairline and a short body; hovered, only its edge darkens. A thing with no picture gets a
 * typeset cover, never an empty box.
 */
import type { ReactNode } from "react";
import { WorkspaceLogo } from "@/components/Marks";

export const TILE_GRID = "grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))]";

/** The tile's own box: the card radius and edge, its border darkening on hover. */
export const TILE = "group flex h-full min-w-0 flex-col overflow-hidden rounded-[var(--r-card)] border p-border p-surface transition-[border-color] duration-[var(--dur-state)] ease-out hover:border-[var(--c-border-strong)] data-[force=hover]:border-[var(--c-border-strong)]";

/** The cover's frame: 16:10, over a hairline; a picture or a typeset cover fills it. */
const TILE_COVER = "relative block aspect-[16/10] w-full shrink-0 overflow-hidden border-b p-border";

const TILE_BODY = "flex min-h-0 flex-1 flex-col gap-1 px-4 pb-3 pt-3";

const TILE_TITLE = "t-label truncate p-text";

/**
 * A cover for a thing with no picture: its mark at the top left, and what it is for set large at the bottom left, as a
 * title page would set it. `line` null sets the title itself. `mark` is the thing's face where it has one other than its
 * logo (Home's assistant, by its mascot); false leaves the corner to what the tile sets there (Explore's kind badge). The
 * ground is one step off the tile's body in every look (`--c-fill`), never darker than the page.
 */
export function TypesetCover({ title, line, logo = null, mark }: { title: string; line: string | null; logo?: string | null; mark?: ReactNode }) {
  return (
    <span data-typeset-cover className="absolute inset-0 flex flex-col justify-between bg-[var(--c-fill)] p-5">
      <span className="flex">{mark === undefined ? <WorkspaceLogo title={title} logo={logo} size={32} /> : mark}</span>
      <span className="t-title line-clamp-3 text-[var(--c-text-2)]">{line ?? title}</span>
    </span>
  );
}

/**
 * A capture of a page, set on the cover's recessed ground at a 12 px inset with the control radius: a light page and a
 * dark one sit in the same frame, so no tile in a grid is the odd one out by its page's mode.
 */
export function CaptureMat({ children }: { children: ReactNode }) {
  return (
    <span className="absolute inset-0 p-sunken" data-capture-mat>
      <span className="absolute inset-3 overflow-hidden rounded-[var(--r-inner)] border p-border">{children}</span>
    </span>
  );
}

/** A tile: the cover, then its body. `children` is the body's lines under the title. */
export function TileShell({ cover, title, children }: { cover: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <>
      <span className={TILE_COVER}>{cover}</span>
      <span className={TILE_BODY}>
        <span className={TILE_TITLE}>{title}</span>
        {children}
      </span>
    </>
  );
}
