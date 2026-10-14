/** An endpoint URL is never the row's second line; the catalog description is. */
import type { ComponentType, ReactNode } from "react";
import { Status, type StatusTone } from "@/components/ui/Status";

export interface PluginStatus {
  readonly label: string;
  readonly tone: StatusTone;
}

/** 40px matches `BrandMark`'s tile so a mixed list keeps one left edge. */
export function PluginTile({ icon: Icon }: { icon: ComponentType<{ size?: number; className?: string }> }) {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border p-border bg-[var(--c-elevated)] p-text-3">
      <Icon size={20} />
    </span>
  );
}

export const PLUGIN_ACTION = "flex size-8 shrink-0 items-center justify-center rounded-lg p-text-3 transition-colors hover:bg-[var(--c-elevated)] hover:p-text disabled:opacity-40 disabled:hover:bg-transparent";

export const PLUGIN_PILL = "flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 p-t-status p-text-3";

export function PluginStatePill({ status }: { status: PluginStatus }) {
  return <Status tone={status.tone}>{status.label}</Status>;
}

export function PluginRow({ tile, name, description, trailing, source, state, below }: {
  tile: ReactNode;
  name: string;
  description: string;
  trailing: ReactNode;
  source?: string;
  state?: string;
  below?: ReactNode;
}) {
  // `min-w-0`: unwrapped text sets the row's min-content and floors the grid track.
  return (
    <div data-plugin={name} data-plugin-source={source} data-plugin-state={state}
      className="min-w-0 rounded-xl px-2 py-2 transition-colors p-card-hover">
      <div className="flex items-center gap-3">
        {tile}
        <div className="min-w-0 flex-1">
          <div className="truncate p-row-text font-medium p-text">{name}</div>
          <div className="truncate p-meta p-text-3">{description}</div>
        </div>
        {trailing}
      </div>
      {below}
    </div>
  );
}
