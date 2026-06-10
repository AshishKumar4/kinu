/**
 * Slash-command core shared by the TUI chat app and the classic REPL. Commands
 * execute against the AgentClient contract and return a presentation-neutral
 * outcome; each surface maps outcomes to its own rendering (system message vs
 * stdout, picker overlay vs printed list).
 */

import type { AgentClient, AgentClientStatus, AgentSearchNode } from './agent-client.js';

export interface SlashCommandInfo {
  name: string;
  description: string;
  usage?: string;
  /** Only offered when the client exposes this capability surface. */
  requires?: 'localControls' | 'consents';
}

export const SLASH_COMMANDS: readonly SlashCommandInfo[] = [
  { name: '/help', description: 'Show command help' },
  { name: '/status', description: 'Show agent state and stats' },
  { name: '/tools', description: 'List available tools' },
  { name: '/model', description: 'Open model picker or set a model', usage: '/model [spec]' },
  { name: '/models', description: 'List configured model providers', requires: 'localControls' },
  { name: '/memory', description: 'Show memory' },
  { name: '/tree', description: 'Show MCTS search tree' },
  { name: '/resume', description: 'Resume a recorded CLI session', usage: '/resume [number/id]' },
  { name: '/sessions', description: 'List recorded CLI sessions' },
  { name: '/jobs', description: 'List background jobs' },
  { name: '/stop', description: 'Stop the active turn' },
  { name: '/approval', description: 'Show or set shell approval mode', usage: '/approval strict|allow_all|deny_all', requires: 'localControls' },
  { name: '/always', description: 'Manage always-active skills', usage: '/always <name...|none>', requires: 'localControls' },
  { name: '/exit', description: 'Exit chat' },
];

export function commandsForClient(client: Pick<AgentClient, 'localControls' | 'consents'>): SlashCommandInfo[] {
  return SLASH_COMMANDS.filter((command) =>
    !command.requires || client[command.requires] !== null);
}

export function commandHelp(client: Pick<AgentClient, 'localControls' | 'consents'>): string {
  const lines = ['Commands'];
  for (const command of commandsForClient(client)) {
    const usage = command.usage ?? command.name;
    lines.push(`  ${usage.padEnd(26)} ${command.description}`);
  }
  return lines.join('\n');
}

export function filterCommands(commands: readonly SlashCommandInfo[], draft: string): SlashCommandInfo[] {
  const token = draft.trimStart();
  if (!token.startsWith('/')) return [];
  const query = token.slice(1).split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  return commands
    .filter((command) => command.name.slice(1).toLowerCase().startsWith(query))
    .slice(0, 8);
}

/** Complete an unambiguous command prefix (e.g. `/sta` → `/status`). */
export function resolveCommandDraft(commands: readonly SlashCommandInfo[], draft: string): string {
  const trimmed = draft.trim();
  if (!trimmed.startsWith('/') || /\s/.test(trimmed)) return trimmed;
  const exact = commands.find((command) => command.name === trimmed);
  if (exact) return trimmed;
  const matches = filterCommands(commands, trimmed);
  return matches.length === 1 ? matches[0]!.name : trimmed;
}

export type SlashOutcome =
  | { kind: 'text'; text: string }
  | { kind: 'status'; status: AgentClientStatus }
  | { kind: 'exit' }
  | { kind: 'model-picker' }
  | { kind: 'model-set'; spec: string }
  | { kind: 'sessions'; mode: 'list' | 'resume'; resumeRef?: string }
  | { kind: 'cancel' }
  | { kind: 'unknown'; command: string };

export async function executeSlashCommand(client: AgentClient, input: string): Promise<SlashOutcome> {
  const [rawCmd, ...rest] = input.split(/\s+/);
  const cmd = rawCmd!.toLowerCase();
  const arg = rest.join(' ').trim();

  switch (cmd) {
    case '/exit':
    case '/quit':
      return { kind: 'exit' };
    case '/cancel':
      return { kind: 'cancel' };
    case '/help':
      return { kind: 'text', text: commandHelp(client) };
    case '/status':
      return { kind: 'status', status: await client.status() };
    case '/tools': {
      const tools = await client.describeTools();
      const lines = ['Built-in:', ...tools.builtIn.map(({ name, description }) => `  ${name} — ${description}`)];
      if (tools.crafted.length > 0) {
        lines.push('', 'Crafted:', ...tools.crafted.map(({ name, description }) => `  ${name} — ${description.slice(0, 50)}`));
      }
      return { kind: 'text', text: lines.join('\n') };
    }
    case '/memory': {
      const content = await client.readMemory();
      return { kind: 'text', text: content ? `Memory:\n${content.slice(0, 1500)}` : 'Memory is empty.' };
    }
    case '/model': {
      if (!arg) return { kind: 'model-picker' };
      const result = await client.setModel(arg);
      return { kind: 'model-set', spec: result.spec };
    }
    case '/models': {
      if (!client.localControls) return { kind: 'unknown', command: cmd };
      const providers = await client.localControls.listModelProviders();
      if (providers.length === 0) {
        return { kind: 'text', text: 'No local provider registry is configured for this session.' };
      }
      const lines = ['Providers:'];
      for (const provider of providers) {
        lines.push(`  ${provider.id} — ${provider.available ? 'available' : provider.unavailableReason ?? 'unavailable'}`);
      }
      const models = await client.listModels();
      if (models.length > 0) {
        lines.push('', 'Models:');
        for (const model of models.slice(0, 40)) lines.push(`  ${model.spec} — ${model.label}`);
        if (models.length > 40) lines.push(`  … ${models.length - 40} more`);
      }
      return { kind: 'text', text: lines.join('\n') };
    }
    case '/always': {
      if (!client.localControls) return { kind: 'unknown', command: cmd };
      const names = rest.filter((name) => name.trim());
      if (names.length === 0) {
        const current = client.localControls.getAlwaysActiveSkills();
        return {
          kind: 'text',
          text: current.length
            ? `Always-active skills: ${current.join(', ')}`
            : 'No always-active skills set. Usage: /always <name>… (or "none" to clear).',
        };
      }
      const next = names[0] === 'none' ? [] : names;
      client.localControls.setAlwaysActiveSkills(next);
      return { kind: 'text', text: next.length ? `Always-active skills: ${next.join(', ')}` : 'Cleared always-active skills.' };
    }
    case '/approval': {
      if (!client.localControls) return { kind: 'unknown', command: cmd };
      if (!arg) return { kind: 'text', text: `Shell approval: ${client.localControls.getShellApprovalMode()}` };
      if (arg === 'strict' || arg === 'allow_all' || arg === 'deny_all') {
        return { kind: 'text', text: `Shell approval: ${client.localControls.setShellApprovalMode(arg)}` };
      }
      return { kind: 'text', text: 'Usage: /approval strict | allow_all | deny_all' };
    }
    case '/mcts':
    case '/tree': {
      const nodes = await client.searchNodes();
      if (nodes.length === 0) {
        return { kind: 'text', text: 'No MCTS nodes yet. Use /evolve or ask complex questions.' };
      }
      return { kind: 'text', text: `MCTS Tree (${nodes.length} nodes):\n${renderSearchTree(nodes)}` };
    }
    case '/jobs': {
      const jobs = await client.listJobs(20);
      return {
        kind: 'text',
        text: jobs.length
          ? jobs.map((job) => `${job.id}  ${job.kind}  ${job.status}`).join('\n')
          : 'No background jobs.',
      };
    }
    case '/stop':
      client.stop();
      return { kind: 'text', text: 'Stop requested for the active turn.' };
    case '/sessions':
      return { kind: 'sessions', mode: 'list' };
    case '/resume':
      return { kind: 'sessions', mode: 'resume', resumeRef: arg || undefined };
    default:
      return { kind: 'unknown', command: cmd };
  }
}

export function renderSearchTree(nodes: readonly AgentSearchNode[]): string {
  return nodes.map((node) => {
    const marker = node.status === 'pruned' ? '◌' : node.status === 'terminal' ? '★' : '○';
    const prefix = '  '.repeat(node.depth) + marker;
    return `${prefix} ${node.value.toFixed(3)} n=${node.visits} ${node.action?.slice(0, 40) ?? ''}`;
  }).join('\n');
}

export function renderStatusLines(status: AgentClientStatus): string[] {
  const row = (label: string, value: string | number | undefined) =>
    value === undefined ? null : `${label.padEnd(10)} ${value}`;
  return [
    row('Name:', status.name),
    row('Mission:', status.purpose.replace(/\s+/g, ' ').slice(0, 120)),
    row('Model:', status.model ?? '(default)'),
    row('Scaffold:', status.scaffoldVersion === undefined ? undefined : `v${status.scaffoldVersion}`),
    row('Messages:', status.messageCount),
    row('MCTS:', status.searchNodeCount === undefined ? undefined : `${status.searchNodeCount} nodes`),
    row('Crafted:', status.craftedToolCount),
    row('Tasks:', status.taskCount),
    row('Tools:', status.toolCount),
    row('Memory:', status.memorySize === undefined ? undefined : `${status.memorySize} B`),
    row('Database:', status.dbSize === undefined ? undefined : `${(status.dbSize / 1024).toFixed(1)} KB`),
    row('Evolve:', status.autoEvolve === undefined ? undefined : status.autoEvolve ? 'auto' : 'manual'),
  ].filter((line): line is string => line !== null);
}
