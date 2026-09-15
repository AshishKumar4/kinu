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

export function PluginCard({ icon: Icon, name, line, status }: {
  icon: ComponentType<{ size?: number; className?: string }>;
  name: string;
  line: string;
  status: PluginStatus;
}) {
  return (
    <div className="p-card flex items-start gap-3 p-4" data-plugin={name}>
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg p-fill p-text-3">
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
