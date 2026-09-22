import { codenameFor } from '../identity/naming';

export function clipText(value: string, max: number): string {
  if (max <= 0) return '';

  if (value.length <= max) return value;

  if (max <= 1) return value.slice(0, max);

  return `${value.slice(0, max - 1)}…`;
}

/** Blank label means a pre-codename row: show the codename its slug would get (same rule as web `agentTitle`). */
export function agentDisplayLabel(entry: { name: string; label: string }): string {
  return entry.label.trim() || codenameFor(entry.name);
}
