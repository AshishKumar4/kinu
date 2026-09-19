import { codenameFor } from '../identity/naming';

export function clipText(value: string, max: number): string {
  if (max <= 0) return '';

  if (value.length <= max) return value;

  if (max <= 1) return value.slice(0, max);

  return `${value.slice(0, max - 1)}…`;
}

/** An agent's shown name everywhere the TUI renders one. An agent is born
 *  with its slug's codename, so a blank label is a row from before codenames
 *  and shows the pair it would have been born with (the web's rule too,
 *  `agentTitle` in SubordinateTabs.tsx). */
export function agentDisplayLabel(entry: { name: string; label: string }): string {
  return entry.label.trim() || codenameFor(entry.name);
}
