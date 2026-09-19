/**
 * One thing an account's agents can reach beyond their built-in tools — an
 * MCP server, a crafted tool, a skill, a machine — in the one card grammar the
 * plugins page draws every kind in: an icon well, a name, one line, a status.
 */
import type { ComponentType } from "react";

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

/** The icon well's colour, by the kind of thing the card is. */
export type PluginKind = 'server' | 'skill';

const WELL_BY_KIND = {
  server: 'bg-[#3b82f6]/15 text-[#60a5fa]',
  skill: 'bg-[#22c55e]/15 text-[#4ade80]',
} satisfies Record<PluginKind, string>;

export function PluginCard({ icon: Icon, kind, name, line, status }: {
  icon: ComponentType<{ size?: number; className?: string }>;
  kind: PluginKind;
  name: string;
  line: string;
  status: PluginStatus;
}) {
  return (
    <div className="p-card flex items-start gap-3 p-4" data-plugin={name}>
      <div className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${WELL_BY_KIND[kind]}`}>
        <Icon size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate p-row-text font-medium p-text">{name}</div>
        <p className="line-clamp-2 p-meta p-text-3">{line}</p>
        <div className="mt-1 flex items-center gap-1.5 p-meta p-text-3">
          <span className={`size-1.5 shrink-0 rounded-full ${DOT_BY_TONE[status.tone]}`} />
          <span>{status.label}</span>
        </div>
      </div>
    </div>
  );
}
