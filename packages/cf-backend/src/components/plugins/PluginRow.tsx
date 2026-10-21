/** An endpoint URL is never the row's second line; the catalog description is. */
import type { ComponentType, ReactNode } from "react";
import type { StatusTone } from "@/components/ui/Status";

export interface PluginStatus {
  readonly label: string;
  readonly tone: StatusTone;
}

/** 32 px, `BrandMark` at 18 (its tile is 1.8 times the mark), so a mixed list keeps one left edge. */
export function PluginTile({ icon: Icon }: { icon: ComponentType<{ size?: number; className?: string }> }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border p-border bg-[var(--c-fill)] p-text-3">
      <Icon size={18} />
    </span>
  );
}

/** The `+` of an addable row: a 28 ghost square in the row's last cell, on the x of a connected row's ⋯. */
export const PLUGIN_ACTION = "flex size-7 shrink-0 items-center justify-center rounded-[var(--r-control)] p-text-3 transition-colors hover:bg-[var(--c-hover)] hover:p-text disabled:opacity-40 disabled:hover:bg-transparent";

/**
 * One row grid for everything connected or addable (design review 2026-10-20, A3): Plugins' Connected and Add, and
 * Settings › Devices. Tile · name and meta · status, set from the left of its own 120 px track so the dots of a column
 * stack · the ⋯ or `+`. A device's Sandbox switch is a track of its own before the last (`control`); what a row says
 * past its two lines sits under the name (`below`).
 */
export function PluginRow({ tile, title, meta, status, control, action, below, attributes }: {
  tile: ReactNode;
  title: ReactNode;
  meta: ReactNode;
  /** A plain `Status`; nothing for a row not yet added. */
  status?: ReactNode;
  control?: ReactNode;
  action: ReactNode;
  below?: ReactNode;
  attributes: Readonly<Record<`data-${string}`, string | undefined>>;
}) {
  // `min-w-0`: unwrapped text sets the row's min-content and floors the grid track.
  return (
    <div {...attributes} className={`p-plugin-row${control === undefined ? "" : " p-plugin-row-control"}`}>
      {tile}
      <div className="min-w-0">
        <div className="truncate p-row-text font-medium p-text">{title}</div>
        <div className="truncate p-meta p-text-3">{meta}</div>
      </div>
      {control === undefined ? <div className="min-w-0" data-plugin-status>{status}</div> : (
        // Two tracks of the row from `sm`; on a phone, a line of their own under the name, so the name keeps its room.
        <div className="p-plugin-row-state">
          <div className="min-w-0" data-plugin-status>{status}</div>
          <div className="flex items-center gap-2">{control}</div>
        </div>
      )}
      <div className="flex justify-end">{action}</div>
      {below !== undefined && <div className="col-start-2 col-end-[-1] min-w-0 pb-2">{below}</div>}
    </div>
  );
}
