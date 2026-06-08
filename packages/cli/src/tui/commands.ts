export type TuiMode = 'local' | 'cloud';

export interface TuiCommand {
  name: string;
  description: string;
  usage?: string;
  modes: readonly TuiMode[];
}

export const LOCAL_COMMANDS: readonly TuiCommand[] = [
  { name: '/help', description: 'Show command help', modes: ['local'] },
  { name: '/status', description: 'Show agent state and stats', modes: ['local'] },
  { name: '/tools', description: 'List available tools', modes: ['local'] },
  { name: '/model', description: 'Open model picker or set a model', usage: '/model [spec]', modes: ['local'] },
  { name: '/models', description: 'List configured model providers', modes: ['local'] },
  { name: '/memory', description: 'Show memory', modes: ['local'] },
  { name: '/tree', description: 'Show MCTS tree summary', modes: ['local'] },
  { name: '/resume', description: 'Resume a recorded CLI session', usage: '/resume [number/id]', modes: ['local'] },
  { name: '/sessions', description: 'List recorded CLI sessions', modes: ['local'] },
  { name: '/jobs', description: 'List background jobs', modes: ['local'] },
  { name: '/stop', description: 'Stop the active turn', modes: ['local'] },
  { name: '/approval', description: 'Show or set shell approval mode', usage: '/approval strict|allow_all|deny_all', modes: ['local'] },
  { name: '/always', description: 'Manage always-active skills', usage: '/always <name...|none>', modes: ['local'] },
  { name: '/exit', description: 'Exit chat', modes: ['local'] },
];

export const CLOUD_COMMANDS: readonly TuiCommand[] = [
  { name: '/help', description: 'Show command help', modes: ['cloud'] },
  { name: '/status', description: 'Show agent state and stats', modes: ['cloud'] },
  { name: '/tools', description: 'List available tools', modes: ['cloud'] },
  { name: '/model', description: 'Open model picker or set a model', usage: '/model [spec]', modes: ['cloud'] },
  { name: '/memory', description: 'Show memory', modes: ['cloud'] },
  { name: '/mcts', description: 'Show MCTS node count', modes: ['cloud'] },
  { name: '/tree', description: 'Show MCTS node count', modes: ['cloud'] },
  { name: '/resume', description: 'Resume a recorded CLI session', usage: '/resume [number/id]', modes: ['cloud'] },
  { name: '/sessions', description: 'List recorded CLI sessions', modes: ['cloud'] },
  { name: '/jobs', description: 'List background jobs', modes: ['cloud'] },
  { name: '/stop', description: 'Stop cloud work', modes: ['cloud'] },
  { name: '/exit', description: 'Exit chat', modes: ['cloud'] },
];

export function commandsForMode(mode: TuiMode): readonly TuiCommand[] {
  return mode === 'cloud' ? CLOUD_COMMANDS : LOCAL_COMMANDS;
}

export function commandHelp(mode: TuiMode): string {
  const lines = ['Commands'];
  for (const command of commandsForMode(mode)) {
    const usage = command.usage ?? command.name;
    lines.push(`  ${usage.padEnd(26)} ${command.description}`);
  }
  return lines.join('\n');
}

export function filterCommands(mode: TuiMode, draft: string): TuiCommand[] {
  const token = draft.trimStart();
  if (!token.startsWith('/')) return [];
  const query = token.slice(1).split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  return commandsForMode(mode)
    .filter((command) => command.name.slice(1).toLowerCase().startsWith(query))
    .slice(0, 8);
}

export function resolveCommandDraft(mode: TuiMode, draft: string): string {
  const trimmed = draft.trim();
  if (!trimmed.startsWith('/') || /\s/.test(trimmed)) return trimmed;
  const exact = commandsForMode(mode).find((command) => command.name === trimmed);
  if (exact) return trimmed;
  const matches = filterCommands(mode, trimmed);
  return matches.length === 1 ? matches[0]!.name : trimmed;
}
