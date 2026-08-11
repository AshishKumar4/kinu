/**
 * Slash-command core shared by the TUI chat app and the classic REPL. Commands
 * execute against the AgentClient contract and return a presentation-neutral
 * outcome; each surface maps outcomes to its own rendering (system message vs
 * stdout, picker overlay vs printed list).
 */

import { isReasoningEffort, summarizeRestorePlan, takeEvidence, type AlternateTakeSet, type BranchStatusEvent, type FileCheckpointEntry, type ReasoningEffort, type TakePickOutcome } from '@proteus/core';
import type { AgentChangelogView, AgentClient, AgentClientStatus, AgentSearchNode } from './agent-client.js';
import { setDefaultModel, setDefaultReasoningEffort } from './config.js';

export interface SlashCommandInfo {
  name: string;
  description: string;
  usage?: string;
  /** Only offered when the client exposes this capability surface. */
  requires?: 'localControls' | 'consents' | 'checkpoints';
}

export const SLASH_COMMANDS: readonly SlashCommandInfo[] = [
  { name: '/help', description: 'Show command help' },
  { name: '/status', description: 'Show agent state and stats' },
  { name: '/tools', description: 'List available tools' },
  { name: '/model', description: 'Open model picker or set a model', usage: '/model [spec]' },
  { name: '/effort', description: 'Show or set reasoning effort', usage: '/effort [low|medium|high]' },
  { name: '/models', description: 'List configured model providers', requires: 'localControls' },
  { name: '/memory', description: 'Show memory' },
  { name: '/changelog', description: 'Review self-changes; revert by index', usage: '/changelog [revert <n>]' },
  { name: '/takes', description: 'Compare the last alternate takes; pick by number', usage: '/takes [n]' },
  { name: '/tree', description: 'Show MCTS search tree' },
  { name: '/resume', description: 'Resume a recorded CLI session', usage: '/resume [number/id]' },
  { name: '/sessions', description: 'List recorded CLI sessions' },
  { name: '/jobs', description: 'List background jobs' },
  { name: '/connect', description: 'Connect this PC for agent device access', requires: 'consents' },
  { name: '/stop', description: 'Stop the active turn' },
  { name: '/queue', description: 'Queue a message to send after the current turn', usage: '/queue <text>' },
  { name: '/branch', description: 'Run a redirect as a parallel branch of the running turn', usage: '/branch <text>' },
  { name: '/fork', description: 'Walk back: fork the conversation before an earlier message', usage: '/fork [number]' },
  { name: '/undo', description: 'Restore files to before a turn (n = turns back), then offer walk-back', usage: '/undo [n]', requires: 'checkpoints' },
  { name: '/approval', description: 'Show or set shell approval mode', usage: '/approval strict|allow_all|deny_all', requires: 'localControls' },
  { name: '/always', description: 'Manage always-active skills', usage: '/always <name...|none>', requires: 'localControls' },
  { name: '/exit', description: 'Exit chat' },
];

export function commandsForClient(client: Pick<AgentClient, 'localControls' | 'consents' | 'checkpoints'>): SlashCommandInfo[] {
  return SLASH_COMMANDS.filter((command) =>
    !command.requires || client[command.requires] !== null);
}

export function commandHelp(client: Pick<AgentClient, 'localControls' | 'consents' | 'checkpoints'>): string {
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
  /** The Evolution Changelog digest — TUI renders an overlay, classic prints. */
  | { kind: 'changelog'; view: AgentChangelogView }
  /** Alternate Takes comparison — TUI renders an overlay, classic prints. */
  | { kind: 'takes'; set: AlternateTakeSet }
  | { kind: 'exit' }
  | { kind: 'model-picker' }
  | { kind: 'model-set'; spec: string }
  | { kind: 'effort-set'; effort: ReasoningEffort }
  | { kind: 'sessions'; mode: 'list' | 'resume'; resumeRef?: string }
  | { kind: 'device-connect' }
  /** Queue text to send after the active turn (surface-owned queue). */
  | { kind: 'queue'; text?: string }
  /** Steer-as-Branch: run the text as a parallel branch of the running turn
   *  (surface-owned — falls back to a normal send when idle). */
  | { kind: 'branch'; text?: string }
  /** Walk-back fork; ref is the picker number when given. Surfaces own the
   *  candidate list (their rendered user messages) and the fork() call. */
  | { kind: 'fork'; ref?: string }
  /** /undo [n] — surfaces run performUndo() and then offer the walk-back. */
  | { kind: 'undo'; ref?: string }
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
      if (!content) return { kind: 'text', text: 'Memory is empty.' };
      const shown = content.length > 1500
        ? `${content.slice(0, 1500)}\n… [+${content.length - 1500} chars — read memory/MEMORY.md for the rest]`
        : content;
      return { kind: 'text', text: `Memory:\n${shown}` };
    }
    case '/changelog': {
      if (rest[0] === 'revert') {
        const n = Number.parseInt(rest[1] ?? '', 10);
        if (!Number.isInteger(n) || n < 1) {
          return { kind: 'text', text: 'Usage: /changelog revert <n> — n is the index from the /changelog listing.' };
        }
        // Re-fetch so the index resolves against the same ordering the
        // listing showed; the revert itself is id-addressed.
        const view = await client.changelog();
        const entry = view.entries[n - 1];
        if (!entry) return { kind: 'text', text: `No changelog entry ${n} — /changelog lists ${view.entries.length}.` };
        if (!entry.revert) return { kind: 'text', text: `Entry ${n} is informational (${entry.kind}) — nothing to revert.` };
        const result = await client.revertChangelogEntry(entry.id);
        return {
          kind: 'text',
          text: result.ok
            ? `Reverted ${n}. ${entry.summary}\n  → ${result.detail ?? 'done'}`
            : `Revert failed: ${result.error ?? 'unknown error'}`,
        };
      }
      return { kind: 'changelog', view: await client.changelog() };
    }
    case '/takes': {
      const set = await client.latestTakes();
      if (!set || set.candidates.length < 2) {
        return { kind: 'text', text: 'No alternate takes yet — they appear when think(strategy=mcts) converges on near-tied approaches, or when a /branch redirect settles against the live turn.' };
      }
      if (!arg) return { kind: 'takes', set };
      const n = Number.parseInt(arg, 10);
      const candidate = Number.isInteger(n) ? set.candidates[n - 1] : undefined;
      if (!candidate) {
        return { kind: 'text', text: `No take "${arg}" — /takes lists ${set.candidates.length}.` };
      }
      return { kind: 'text', text: describeTakePick(await client.pickTake(set.id, candidate.nodeId), n) };
    }
    case '/model': {
      if (!arg) return { kind: 'model-picker' };
      const result = await setModelPreference(client, arg);
      return { kind: 'model-set', spec: result.spec };
    }
    case '/effort': {
      return executeEffortCommand(client, arg);
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
      const menu = await client.listModels();
      if (menu.models.length > 0) {
        lines.push('', 'Models:');
        for (const model of menu.models.slice(0, 40)) lines.push(`  ${model.spec} — ${model.label}`);
        if (menu.models.length > 40) lines.push(`  … ${menu.models.length - 40} more`);
      }
      for (const failure of menu.failures) {
        lines.push(`  ! ${failure.label ?? failure.provider} could not be listed — ${failure.reason}`);
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
    case '/connect':
      if (!client.consents) return { kind: 'unknown', command: cmd };
      return { kind: 'device-connect' };
    case '/stop': {
      const dropped = client.stop();
      return {
        kind: 'text',
        text: dropped.length > 0
          ? `Stop requested for the active turn. Undelivered steered input:\n${dropped.map((t) => `  ${t}`).join('\n')}`
          : 'Stop requested for the active turn.',
      };
    }
    case '/queue':
      return { kind: 'queue', text: arg || undefined };
    case '/branch':
      return { kind: 'branch', text: arg || undefined };
    case '/fork':
      return { kind: 'fork', ref: arg || undefined };
    case '/undo':
      if (!client.checkpoints) return { kind: 'unknown', command: cmd };
      return { kind: 'undo', ref: arg || undefined };
    case '/sessions':
      return { kind: 'sessions', mode: 'list' };
    case '/resume':
      return { kind: 'sessions', mode: 'resume', resumeRef: arg || undefined };
    default:
      return { kind: 'unknown', command: cmd };
  }
}

export async function setModelPreference(client: Pick<AgentClient, 'setModel'>, spec: string): Promise<{ spec: string }> {
  const result = await client.setModel(spec);
  setDefaultModel(result.spec);
  return result;
}

export async function setReasoningEffortPreference(
  client: Pick<AgentClient, 'setReasoningEffort'>,
  effort: ReasoningEffort,
): Promise<{ effort: ReasoningEffort }> {
  const result = await client.setReasoningEffort(effort);
  setDefaultReasoningEffort(result.effort);
  return result;
}

export async function executeEffortCommand(
  client: Pick<AgentClient, 'getReasoningEffort' | 'setReasoningEffort'>,
  arg: string,
): Promise<SlashOutcome> {
  if (!arg) {
    const stored = await client.getReasoningEffort();
    const current = stored ?? 'medium';
    return {
      kind: 'text',
      text: `Reasoning effort: ${current}${stored ? '' : ' (chat default)'}\nOptions: low, medium, high\nSet with /effort <level>.`,
    };
  }
  if (!isReasoningEffort(arg)) {
    return { kind: 'text', text: 'Usage: /effort low | medium | high' };
  }
  const result = await setReasoningEffortPreference(client, arg);
  return { kind: 'effort-set', effort: result.effort };
}

export interface UndoResult {
  /** Presentation-neutral report: the restore plan and what was applied. */
  text: string;
  /** True when files were actually restored — the surface should then offer
   *  the conversation walk-back through its existing fork mechanics. */
  restored: boolean;
}

/** Group checkpoints by turn, newest first — /undo n addresses the nth most
 *  recent turn that has a file checkpoint (a turn may snapshot several dirs). */
export function groupCheckpointsByTurn(entries: ReadonlyArray<FileCheckpointEntry>): FileCheckpointEntry[][] {
  const groups: FileCheckpointEntry[][] = [];
  const byTurn = new Map<string, FileCheckpointEntry[]>();
  for (const entry of entries) {
    const key = entry.turnId ?? `checkpoint:${entry.id}`;
    let group = byTurn.get(key);
    if (!group) {
      group = [];
      byTurn.set(key, group);
      groups.push(group);
    }
    group.push(entry);
  }
  return groups;
}

const RESTORE_GLYPH = { modify: '~', create: '+', delete: '-' } as const;

/**
 * The /undo flow shared by the TUI and the classic REPL: pick the checkpoint
 * taken before the nth-most-recent turn (default: last), show what restoring
 * changes (paths + counts), apply it, and tell the surface to offer the
 * conversation walk-back (the existing fork plumbing). Zero prompts.
 */
export async function performUndo(client: Pick<AgentClient, 'checkpoints'>, ref?: string): Promise<UndoResult> {
  const surface = client.checkpoints;
  if (!surface) return { text: 'File checkpoints are not available for this agent.', restored: false };
  const status = await surface.status();
  if (!status.available) {
    return { text: status.reason ?? 'File checkpoints are unavailable.', restored: false };
  }
  const turns = groupCheckpointsByTurn(await surface.list(200));
  if (turns.length === 0) {
    return {
      text: 'No file checkpoints yet — one is taken automatically before the first file change of each turn.',
      restored: false,
    };
  }
  const n = ref ? Number.parseInt(ref, 10) : 1;
  if (!Number.isInteger(n) || n < 1 || n > turns.length) {
    const lines = [`Usage: /undo [n] — n is turns back (1–${turns.length} available):`];
    turns.slice(0, 10).forEach((group, i) => {
      const at = new Date(group[0]!.at).toLocaleString();
      lines.push(`  ${i + 1}. ${at}  ${group.map((e) => e.dir).join(', ')}`);
    });
    return { text: lines.join('\n'), restored: false };
  }

  const lines: string[] = [];
  let restored = false;
  for (const entry of turns[n - 1]!) {
    const plan = await surface.plan(entry.dir, entry.id);
    if (plan.files.length === 0) {
      lines.push(`${entry.dir} — already matches that checkpoint, nothing to restore.`);
      continue;
    }
    const { modified, created, deleted } = summarizeRestorePlan(plan.files);
    const counts = [
      modified > 0 ? `${modified} modified` : null,
      created > 0 ? `${created} recreated` : null,
      deleted > 0 ? `${deleted} removed` : null,
    ].filter(Boolean).join(', ');
    lines.push(`Restoring ${entry.dir} to ${new Date(entry.at).toLocaleString()} (${counts}):`);
    for (const file of plan.files.slice(0, 25)) {
      lines.push(`  ${RESTORE_GLYPH[file.kind]} ${file.path}`);
    }
    if (plan.files.length > 25) lines.push(`  … ${plan.files.length - 25} more`);
    const result = await surface.restore(entry.dir, entry.id);
    restored = true;
    lines.push(`✓ ${plan.files.length} file(s) restored.${result.preRestoreId ? ` Undo this with /undo 1.` : ''}`);
  }
  return { text: lines.join('\n'), restored };
}

/** The classic-REPL takes listing (`/takes` without a pick). */
export function renderTakesText(set: AlternateTakeSet): string {
  const lines = [`Alternate takes for: ${set.task.replace(/\s+/g, ' ').slice(0, 100)}`];
  set.candidates.forEach((candidate, i) => {
    const marker = candidate.nodeId === (set.chosenNodeId ?? set.winnerNodeId) ? '★' : ' ';
    lines.push(`  ${i + 1}. ${marker} [${takeEvidence(candidate)}]`);
    lines.push(`       ${candidate.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  });
  lines.push('Pick with /takes <n> — your pick becomes a real preference signal.');
  return lines.join('\n');
}

/** Narrow a BroadcastEvent to the Steer-as-Branch progress event. */
export function isBranchStatusEvent(event: { type: string }): event is BranchStatusEvent {
  return event.type === 'branch_status';
}

/** One presentation-neutral line per branch_status broadcast — shared by the
 *  TUI and the classic REPL. */
export function describeBranchStatus(event: BranchStatusEvent): string {
  const task = event.task.replace(/\s+/g, ' ').slice(0, 80);
  switch (event.status) {
    case 'running':
      return `⎇ branching — running "${task}" in parallel (the live turn continues)`;
    case 'settled':
      return '⎇ branch settled into alternate takes — /takes to compare and pick';
    case 'error':
      return `⎇ branch discarded — ${event.message}`;
  }
}

/** What a pick did, for the surfaces' confirmation line. */
export function describeTakePick(result: TakePickOutcome, n: number): string {
  if (!result.changedAnswer) {
    return `Take ${n} confirmed — the answered approach stays, recorded as an explicit preference.`;
  }
  return `Take ${n} picked — preference recorded, convergence re-pointed` +
    (result.continuationQueued ? ', and the agent will continue with this approach.' : '.');
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
    row('Effort:', status.reasoningEffort ?? 'medium (chat default)'),
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
