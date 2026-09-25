/** An endpoint URL is never the row's second line; the catalog description is. */
import type { ComponentType, ReactNode } from "react";

export type PluginTone = 'success' | 'warning' | 'neutral' | 'danger';

export interface PluginStatus {
  readonly label: string;
  readonly tone: PluginTone;
}

const DOT_BY_TONE = {
  success: 'p-dot-success',
  warning: 'p-dot-warning',
  neutral: 'p-dot-neutral',
  danger: 'bg-[var(--c-danger)]',
} satisfies Record<PluginTone, string>;

/** 40px matches `BrandMark`'s tile so a mixed list keeps one left edge. */
export function PluginTile({ icon: Icon }: { icon: ComponentType<{ size?: number; className?: string }> }) {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#3b82f6]/15 text-[#60a5fa]">
      <Icon size={20} />
    </span>
  );
}

export const PLUGIN_ACTION = "flex size-8 shrink-0 items-center justify-center rounded-lg p-text-3 transition-colors hover:bg-[var(--c-elevated)] hover:p-text disabled:opacity-40 disabled:hover:bg-transparent";

export const PLUGIN_PILL = "flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 p-t-status p-text-3";

export function PluginStatePill({ status }: { status: PluginStatus }) {
  return (
    <span className={PLUGIN_PILL}>
      <span className={`size-1.5 shrink-0 rounded-full ${DOT_BY_TONE[status.tone]}`} />
      {status.label}
    </span>
  );
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
