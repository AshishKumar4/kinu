/**
 * One thing an account's agents can reach beyond their built-in tools — an
 * MCP server, a preset, a skill, a machine — in the one row grammar the
 * plugins page draws every kind in: a 40px icon tile, the name, one line that
 * says what it gives an agent, and one trailing control.
 *
 * An endpoint is not that line. A person does nothing with a server URL, so
 * the row spends its second line on the catalog's own description and leaves
 * the address to the surface that edits it.
 */
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

/** The icon tile's colour, by the kind of thing the row is. */
export type PluginKind = 'server' | 'skill';

const WELL_BY_KIND = {
  server: 'bg-[#3b82f6]/15 text-[#60a5fa]',
  skill: 'bg-[#22c55e]/15 text-[#4ade80]',
} satisfies Record<PluginKind, string>;

/** The tile a row wears where the thing has no brand mark of its own. Its
 *  40px is what a brand mark on `BrandMark`'s tile also measures, so a mixed
 *  list keeps one left edge. */
export function PluginTile({ icon: Icon, kind }: {
  icon: ComponentType<{ size?: number; className?: string }>;
  kind: PluginKind;
}) {
  return (
    <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${WELL_BY_KIND[kind]}`}>
      <Icon size={20} />
    </span>
  );
}

/** The seat of an icon-only trailing control. */
export const PLUGIN_ACTION = "flex size-8 shrink-0 items-center justify-center rounded-lg p-text-3 transition-colors hover:bg-[var(--c-elevated)] hover:p-text disabled:opacity-40 disabled:hover:bg-transparent";

/** The seat of a trailing control that shows a word. */
export const PLUGIN_PILL = "flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 p-t-status p-text-3";

/** A row's state where nothing is there to click: the tone's dot and the one
 *  word beside it. */
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
  /** The row's one control, on the right: an icon button, or a state pill. */
  trailing: ReactNode;
  /** The catalog entry the row draws, where it draws one — a preset id. */
  source?: string;
  /** The one word the row's state says, for a reader that waits on it. */
  state?: string;
  /** What the row's control opens under it: a field, a failure. */
  below?: ReactNode;
}) {
  // `min-w-0` on the row: a name and a line that never wrap make the row's
  // min-content the whole string, which floors the grid track it sits in —
  // the column outgrows the list, and a phone width clips what hangs over.
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
