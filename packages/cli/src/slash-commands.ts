/**
 * Slash-command core shared by the TUI chat app and the classic REPL. Commands
 * execute against the AgentClient contract and return a presentation-neutral
 * outcome; each surface maps outcomes to its own rendering (system message vs
 * stdout, picker overlay vs printed list).
 */

import { ADVISOR_SEVERITIES, DEFAULT_ROLE_ID, isAdvisorSeverity, isReasoningEffort, summarizeRestorePlan, takeEvidence, type AlternateTakeSet, type BranchStatusEvent, type EvolutionConfigView, type FileCheckpointEntry, type ReasoningEffort, type TakePickOutcome } from '@kinu.run/core';
import type { AgentChangelogView, AgentClient, AgentClientStatus, AgentSearchNode } from './agent-client';
import { loadActiveProfile, updateDefaultTier } from './profiles';

export interface SlashCommandInfo {
  name: string;
  description: string;
  usage?: string;
  /** Only offered when the client exposes this capability surface. */
  requires?: 'localControls' | 'consents' | 'checkpoints' | 'rename';
}

export const SLASH_COMMANDS: readonly SlashCommandInfo[] = [
  { name: '/help', description: 'Show command help' },
  { name: '/status', description: 'Show agent state and stats' },
  { name: '/tools', description: 'List available tools' },
  { name: '/model', description: 'Open the account default-tier model picker or set it', usage: '/model [spec]' },
  { name: '/effort', description: 'Show or set default-tier reasoning effort', usage: '/effort [low|medium|high]' },
  { name: '/role', description: 'Show or select this agent role', usage: '/role [id]' },
  { name: '/rename', description: 'Rename this agent; a name you choose is never auto-replaced', usage: '/rename <name>', requires: 'rename' },
  { name: '/settings', description: 'Open interactive settings' },
  { name: '/models', description: 'List configured model providers', requires: 'localControls' },
  { name: '/memory', description: 'Show memory' },
  { name: '/changelog', description: 'Review self-changes; revert by index', usage: '/changelog [revert <n>]' },
  { name: '/takes', description: 'Compare the last alternate takes; pick by number', usage: '/takes [n]' },
  { name: '/tree', description: 'Show MCTS search tree' },
  { name: '/jobs', description: 'List background jobs' },
  { name: '/connect', description: 'Connect this PC for agent device access', requires: 'consents' },
  { name: '/stop', description: 'Stop the active turn' },
  { name: '/queue', description: 'Queue a message to send after the current turn', usage: '/queue <text>' },
  { name: '/branch', description: 'Run a redirect as a parallel branch of the running turn', usage: '/branch <text>' },
  { name: '/fork', description: 'Walk back: fork the conversation before an earlier message', usage: '/fork [number]' },
  { name: '/undo', description: 'Restore files to before a turn (n = turns back), then offer walk-back', usage: '/undo [n]', requires: 'checkpoints' },
  { name: '/approval', description: 'Show or set shell approval mode', usage: '/approval strict|allow_all|deny_all', requires: 'localControls' },
  { name: '/always', description: 'Manage always-active skills', usage: '/always <name...|none>', requires: 'localControls' },
  { name: '/advisor', description: 'Show or set the advisor. It is off by default. Turning it on adds one model call per turn.', usage: '/advisor [on|off|severity <nit|concern|blocker>]' },
  { name: '/exit', description: 'Exit chat' },
];

export function commandsForClient(
  client: Pick<AgentClient, 'localControls' | 'consents' | 'checkpoints' | 'rename'>,
): SlashCommandInfo[] {
  return SLASH_COMMANDS.filter((command) => {
    if (!command.requires) return true;
    const capability = client[command.requires];
    return capability !== null && capability !== undefined;
  });
}

export function commandHelp(
  client: Pick<AgentClient, 'localControls' | 'consents' | 'checkpoints' | 'rename'>,
): string {
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
    .map((command, index) => {
      const name = command.name.slice(1).toLowerCase();
      const description = command.description.toLowerCase();
      const rank = query === '' ? 3
        : name === query ? 0
        : name.startsWith(query) ? 1
        : description.includes(query) ? 2
        : fuzzySubsequence(query, name) ? 3
        : null;
      return { command, index, rank };
    })
    .filter((candidate): candidate is { command: SlashCommandInfo; index: number; rank: number } =>
      candidate.rank !== null)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ command }) => command);
}

function fuzzySubsequence(query: string, target: string): boolean {
  let queryIndex = 0;
  for (const character of target) {
    if (character === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return true;
  }
  return query.length === 0;
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
  | { kind: 'settings' }
  | { kind: 'model-set'; spec: string }
  | { kind: 'effort-set'; effort: ReasoningEffort }
  | { kind: 'role-set'; role: string }
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

const ADVISOR_USAGE = `Usage: /advisor on | off | severity <${ADVISOR_SEVERITIES.join(' | ')}>`;

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
    case '/rename': {
      if (!client.rename) return { kind: 'text', text: 'This agent cannot be renamed from this client.' };
      if (!arg) return { kind: 'text', text: 'Usage: /rename <name>' };
      const renamed = await client.rename(arg);
      return { kind: 'text', text: `Renamed to ${renamed.displayName}.` };
    }
    case '/help':
      return { kind: 'text', text: commandHelp(client) };
    case '/settings':
      return { kind: 'settings' };
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
        return { kind: 'text', text: 'No alternate takes yet — they appear when an agents.swarm search with a depth converges on near-tied approaches, or when a /branch redirect settles against the live turn.' };
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
    case '/role': {
      if (!arg) {
        const status = await client.status();
        return { kind: 'text', text: `Role: ${status.roleId ?? DEFAULT_ROLE_ID}` };
      }
      const result = await client.setRole(arg);
      return { kind: 'role-set', role: result.role };
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
    case '/advisor': {
      const [sub, level, ...extra] = rest.filter((token) => token).map((token) => token.toLowerCase());
      let config: EvolutionConfigView;
      if (extra.length > 0) return { kind: 'text', text: ADVISOR_USAGE };
      if (sub === undefined) config = await client.getEvolutionConfig();
      else if (level === undefined && (sub === 'on' || sub === 'off')) config = await client.setEvolutionConfig({ advisorEnabled: sub === 'on' });
      else if (sub === 'severity' && isAdvisorSeverity(level)) config = await client.setEvolutionConfig({ advisorMinSeverity: level });
      else return { kind: 'text', text: ADVISOR_USAGE };
      return {
        kind: 'text',
        text: config.advisorEnabled
          ? `Advisor: on. The minimum severity is ${config.advisorMinSeverity}. The advisor adds one model call per turn.`
          : `Advisor: off. The minimum severity is ${config.advisorMinSeverity}. /advisor on adds one model call per turn.`,
      };
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
    default:
      return { kind: 'unknown', command: cmd };
  }
}

/**
 * `/model` and `/effort` edit the DEFAULT TIER of whichever store is
 * canonical right now: the account's catalog when signed in, the local
 * authority when not. Every unresolved tier aliases that one.
 *
 * The client is not asked to do anything. The session resolves its authority
 * per turn, so writing the envelope is what makes the next turn run under the
 * new tier — a second write through the client would be a duplicate of the
 * same setting in a second place.
 */
export async function setModelPreference(
  _client: Pick<AgentClient, 'setModel'>,
  spec: string,
): Promise<{ spec: string }> {
  const envelope = await updateDefaultTier({ model: spec });
  return { spec: envelope.catalog.tiers.default.model };
}

export async function setReasoningEffortPreference(
  _client: Pick<AgentClient, 'setReasoningEffort'>,
  effort: ReasoningEffort,
): Promise<{ effort: ReasoningEffort }> {
  const envelope = await updateDefaultTier({ reasoningEffort: effort });
  return { effort: envelope.catalog.tiers.default.reasoningEffort ?? 'medium' };
}

export async function executeEffortCommand(
  client: Pick<AgentClient, 'getReasoningEffort' | 'setReasoningEffort'>,
  arg: string,
): Promise<SlashOutcome> {
  if (!arg) {
    const current = (await loadActiveProfile()).catalog.tiers.default.reasoningEffort ?? 'medium';
    return {
      kind: 'text',
      text: `Default-tier reasoning effort: ${current}\nOptions: low, medium, high\nSet with /effort <level>.`,
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
  const { availability, entries } = await surface.list(200);
  if (!availability.available) {
    return { text: availability.reason ?? 'File checkpoints are unavailable.', restored: false };
  }
  const turns = groupCheckpointsByTurn(entries);
  if (turns.length === 0) {
    return {
      text: 'No file checkpoints yet. One is taken automatically before the first change to a file on '
        + 'YOUR machine each turn; work the agent does in its own workspace or in a sandbox is not covered.',
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

  // THE WINDOW CHOOSES; THE STORE ACTS. `list(200)` above is a browse — it ranks
  // turns so `n` can address one. Acting on that window directly would restore
  // PART of a turn and report it as whole: a turn snapshots one checkpoint per
  // directory it touched, retention is per directory, and the limit is global, so
  // a turn with dirs A, B, C can arrive with only A and B inside the window.
  // `/undo 1` then restored two of three and printed "✓ N file(s) restored".
  // Re-reading the chosen turn keyed by its id is the only way to hold all of it.
  const chosen = turns[n - 1]!;
  const chosenTurnId = chosen[0]!.turnId;
  const group = chosenTurnId === null || chosenTurnId === undefined
    ? chosen
    : (await surface.list(undefined, chosenTurnId)).entries;

  const lines: string[] = [];
  let restored = false;
  for (const entry of group) {
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
