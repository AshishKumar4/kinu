/**
 * One row grid for everything connected or addable (docs/DESIGN-SYSTEM.md §2; design review 2026-10-20, A3): Plugins'
 * Connected and Add, and Settings › Devices. Tile · name and meta · status, set from the left of its own 120 px track
 * so the dots of a column stack · the ⋯ or `+`. A device's Sandbox switch is a track of its own before the last
 * (`control`); what a row says past its two lines sits under the name (`below`). On a phone the row is tile · name · ⋯.
 */
import type { ComponentType, ReactNode } from "react";

/** A 32 tile for a thing with no brand mark (`BrandMark` at 18 draws the same box for one that has one). */
export function RowTile({ icon: Icon }: { icon: ComponentType<{ size?: number; className?: string }> }) {
  return (
    <span className="p-row-tile">
      <Icon size={18} />
    </span>
  );
}

export function Row({ tile, title, meta, status, control, action, below, selected = false, attributes }: {
  tile: ReactNode;
  title: ReactNode;
  meta: ReactNode;
  /** A plain `Status`; nothing for a row not yet added. */
  status?: ReactNode;
  control?: ReactNode;
  action: ReactNode;
  below?: ReactNode;
  selected?: boolean;
  attributes: Readonly<Record<`data-${string}`, string | undefined>>;
}) {
  // `min-w-0`: unwrapped text sets the row's min-content and floors the grid track.
  return (
    <div {...attributes} aria-current={selected || undefined} className={`p-row${control === undefined ? "" : " p-row-control"}`}>
      {tile}
      <div className="min-w-0">
        <div className="truncate t-item">{title}</div>
        <div className="truncate t-meta">{meta}</div>
      </div>
      {control === undefined ? <div className="min-w-0" data-plugin-status>{status}</div> : (
        // Two tracks of the row from `sm`; on a phone, a line of their own under the name, so the name keeps its room.
        <div className="p-row-state">
          <div className="min-w-0" data-plugin-status>{status}</div>
          <div className="flex items-center gap-2">{control}</div>
        </div>
      )}
      <div className="flex justify-end">{action}</div>
      {below !== undefined && <div className="col-start-2 col-end-[-1] min-w-0 pb-2">{below}</div>}
    </div>
  );
}

/** The `+` of an addable row: a 28 ghost square in the row's last cell, on the x of a connected row's ⋯. */
export const ROW_ACTION = "p-row-action";
