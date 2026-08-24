export function clipText(value: string, max: number): string {
  if (max <= 0) return '';
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return `${value.slice(0, max - 1)}…`;
}

/** What an agent with no name yet is called everywhere the TUI renders one.
 *  Blank means created-but-untitled: a one-click agent names itself from its
 *  first message, and until then every surface says this instead of ''. */
const NEW_AGENT_LABEL = 'New agent';

export function agentDisplayLabel(label: string): string {
  return label.trim() === '' ? NEW_AGENT_LABEL : label;
}
