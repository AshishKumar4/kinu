/**
 * Slash-command core shared by the TUI chat app and the classic REPL. Commands
 * execute against the AgentClient contract and return a presentation-neutral
 * outcome; each surface maps outcomes to its own rendering (system message vs
 * stdout, picker overlay vs printed list).
 */

import { ADVISOR_SEVERITIES, DEFAULT_ROLE_ID, REFINEMENT_DECISIONS, type StagedSkillView, type RefinementRequestView, type RefinementRoute, isAdvisorSeverity, isReasoningEffort, summarizeRestorePlan, takeEvidence, type AlternateTakeSet, type BranchStatusEvent, type EvolutionConfigView, type FileCheckpointEntry, type ReasoningEffort, type TakePickOutcome } from '@kinu.run/core';
import type { AgentChangelogView, AgentClient, AgentClientStatus, AgentRefinementView, AgentSearchNode } from './agent-client';
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
  { name: '/theme', description: 'Choose the TUI theme; follows the terminal by default' },
  { name: '/models', description: 'List configured model providers', requires: 'localControls' },
  { name: '/memory', description: 'Show memory' },
  { name: '/changelog', description: 'Review self-changes; revert by index', usage: '/changelog [revert <n>]' },
  { name: '/refine', description: 'Review recent corrected turns and propose the smallest fixes; read and decide what one staged', usage: '/refine [now|show <n> <edit>|approve <n> <edit> <digest>|reject <n> <edit> <digest>]' },
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
  { name: '/instructions', description: 'Approve which AGENTS.md and skill files the agent follows', usage: '/instructions [page <cursor>|read <page> <n>|approve <page> <n> <digest>|revoke <page> <n>]', requires: 'localControls' },
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
  /** The theme picker — TUI renders an overlay, classic says where themes live. */
  | { kind: 'theme' }
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
const REFINE_USAGE =
  'Usage: /refine | /refine now | /refine show <n> <edit>\n'
  + `       /refine <${REFINEMENT_DECISIONS.join('|')}> <n> <edit> <digest>\n`
  + '  n and edit are the indexes /refine prints; digest is what /refine show prints.';

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
      if (!client.rename) return { kind: 'text', text: 'You cannot rename this agent from this client.' };
      if (!arg) return { kind: 'text', text: 'Usage: /rename <name>' };
      const renamed = await client.rename(arg);
      return { kind: 'text', text: `Renamed to ${renamed.displayName}.` };
    }
    case '/help':
      return { kind: 'text', text: commandHelp(client) };
    case '/settings':
      return { kind: 'settings' };
    case '/theme':
      return { kind: 'theme' };
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
        ? `${content.slice(0, 1500)}\n… [+${content.length - 1500} chars: read memory/MEMORY.md for the rest]`
        : content;
      return { kind: 'text', text: `Memory:\n${shown}` };
    }
    case '/changelog': {
      if (rest[0] === 'revert') {
        const n = Number.parseInt(rest[1] ?? '', 10);
        if (!Number.isInteger(n) || n < 1) {
          return { kind: 'text', text: 'Usage: /changelog revert <n>. Take n from the /changelog listing.' };
        }
        // Re-fetch so the index resolves against the same ordering the
        // listing showed; the revert itself is id-addressed.
        const view = await client.changelog();
        const entry = view.entries[n - 1];
        if (!entry) return { kind: 'text', text: `No changelog entry ${n}. /changelog lists ${view.entries.length}.` };
        if (!entry.revert) return { kind: 'text', text: `Entry ${n} is informational (${entry.kind}). Nothing to revert.` };
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
    case '/refine': {
      const [sub, ...args] = rest.filter((token) => token);
      if (sub === 'now') {
        return { kind: 'text', text: renderRefinementRequest(await client.requestRefinement()) };
      }
      if (sub === 'show') {
        const located = resolveRefinementEdit(await client.refinements(), args[0], args[1]);
        if (!located.ok) return { kind: 'text', text: located.error };
        const shown = await client.showRefinement(located.id, located.index);
        return {
          kind: 'text',
          text: shown.ok ? renderStagedSkill(shown.view, located.requestRef, located.editRef) : shown.error,
        };
      }
      const decision = sub === undefined
        ? undefined
        : REFINEMENT_DECISIONS.find((candidate) => candidate === sub);
      if (decision !== undefined) {
        const [requestRef, editRef, token] = args;
        const located = resolveRefinementEdit(await client.refinements(), requestRef, editRef);
        if (!located.ok) return { kind: 'text', text: located.error };
        if (token === undefined) {
          return {
            kind: 'text',
            text: `Read it first: /refine show ${located.requestRef} ${located.editRef}\n`
              + `Then repeat the digest it prints: /refine ${decision} ${located.requestRef} ${located.editRef} <digest>\n`,
          };
        }
        const result = await client.decideRefinement({
          requestId: located.id,
          routeIndex: located.index,
          expectedDigest: token,
          decision,
        });
        return {
          kind: 'text',
          text: result.ok
            ? `${result.detail}\n\n${renderRefinementRequest(result.request)}`
            : `Could not ${decision}: ${result.error}`,
        };
      }
      if (sub !== undefined) return { kind: 'text', text: REFINE_USAGE };
      return { kind: 'text', text: renderRefinementsText(await client.refinements()) };
    }
    case '/takes': {
      const set = await client.latestTakes();
      if (!set || set.candidates.length < 2) {
        return { kind: 'text', text: 'No alternate takes yet. They appear when an agents.swarm search with a depth converges on near-tied approaches, or when a /branch redirect settles.' };
      }
      if (!arg) return { kind: 'takes', set };
      const n = Number.parseInt(arg, 10);
      const candidate = Number.isInteger(n) ? set.candidates[n - 1] : undefined;
      if (!candidate) {
        return { kind: 'text', text: `No take "${arg}". /takes lists ${set.candidates.length}.` };
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
        return { kind: 'text', text: 'This session has no local provider registry.' };
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
        lines.push(`  ! ${failure.label ?? failure.provider} could not be listed: ${failure.reason}`);
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
    case '/instructions': {
      if (!client.localControls) return { kind: 'unknown', command: cmd };
      const [sub, pageToken, indexToken, rowToken, reviewedDigest] = rest.filter((token) => token);
      const pageCursor = (token: string | undefined): { after: string } | null | 'invalid' => {
        if (token === undefined || token === 'root') return null;
        // Page anchors contain a NUL separator, so they cannot travel verbatim
        // through a shell-style command. Base64url is terminal-safe; the
        // alphabet check is the complete malformed-input policy and means no
        // decoder exception has to be caught or silently dropped.
        if (!/^[A-Za-z0-9_-]+$/.test(token)) return 'invalid';
        const after = Buffer.from(token, 'base64url').toString('utf8');
        return after.includes('\u0000') ? { after } : 'invalid';
      };
      const cursor = pageCursor(sub === 'page' ? pageToken : undefined);
      if (cursor === 'invalid') {
        return { kind: 'text', text: 'That page reference is not valid. Run /instructions again.' };
      }
      const page = await client.localControls.listInstructionApprovals(
        cursor === null ? {} : { cursor },
      );
      const rows = page.items;
      const tokenFor = (after: string | undefined): string =>
        after === undefined ? 'root' : Buffer.from(after).toString('base64url');
      const rowTokenFor = (path: string): string => Buffer.from(path).toString('base64url');
      const actionUsage = (pageId: string, index: number, path: string): string =>
        `/instructions read ${pageId} ${String(index)} ${rowTokenFor(path)}`;
      if (sub === undefined || sub === 'page') {
        if (rows.length === 0) {
          return { kind: 'text', text: 'No AGENTS.md or workspace skills found here.' };
        }
        const pageId = tokenFor(cursor?.after);
        return {
          kind: 'text',
          text: [
            'Instruction files the agent can write. The agent follows only what you approve.',
            ...rows.map((row, index) => {
              const state = row.reason !== undefined
                ? `not readable: ${row.reason}`
                : row.decision === 'grandfathered' ? 'carried over'
                  : row.decision === 'approved' ? 'approved'
                    : row.decision === 'revoked' ? 'refused' : 'not decided';
              const kind = row.kind === 'skill' ? 'skill' : 'AGENTS.md';
              return `  ${String(index + 1)}. [${state}] ${row.path} (${kind}, ${String(row.bytes)} bytes) — ${actionUsage(pageId, index + 1, row.path)}`;
            }),
            ...(page.status === 'more'
              ? [`More: /instructions page ${tokenFor(page.next.after)}`]
              : []),
          ].join('\n'),
        };
      }
      const actionCursor = pageCursor(pageToken);
      if (actionCursor === 'invalid') {
        return { kind: 'text', text: 'That page reference is not valid. Run /instructions again.' };
      }
      const actionPage = await client.localControls.listInstructionApprovals(
        actionCursor === null ? {} : { cursor: actionCursor },
      );
      const at = Number(indexToken);
      const row = Number.isInteger(at) ? actionPage.items[at - 1] : undefined;
      if (!row) {
        return { kind: 'text', text: `That instruction row is no longer on this page; list it again before acting.` };
      }
      if (rowToken === undefined || !/^[A-Za-z0-9_-]+$/.test(rowToken)) {
        return { kind: 'text', text: 'That command is missing the row token. List the page again to copy it.' };
      }
      const reviewedPath = Buffer.from(rowToken, 'base64url').toString('utf8');
      if (reviewedPath !== row.path) {
        return { kind: 'text', text: 'That instruction row changed on this page; list it again before acting.' };
      }
      if (sub === 'read') {
        const opened = await client.localControls.readInstructionApproval(row.path);
        if (!opened) {
          return { kind: 'text', text: `${row.path} could not be read${row.reason === undefined ? '' : `: ${row.reason}`}.` };
        }
        const pageId = tokenFor(actionCursor?.after);
        return {
          kind: 'text',
          text: [
            opened.path,
            `digest ${opened.digest}`,
            '',
            opened.preview,
            '',
            `Approve exactly these reviewed bytes: /instructions approve ${pageId} ${String(at)} ${rowTokenFor(opened.path)} ${opened.digest}`,
          ].join('\n'),
        };
      }
      if (sub === 'approve') {
        if (reviewedDigest === undefined) {
          return { kind: 'text', text: 'Read the file first: approving needs the digest it prints.' };
        }
        const decided = await client.localControls.approveInstruction(row.path, reviewedDigest);
        if (!decided.ok) return { kind: 'text', text: `Nothing was approved: ${decided.error}` };
        return { kind: 'text', text: `Approved ${row.path}. Editing it drops it back to reference material.` };
      }
      if (sub === 'revoke') {
        const decided = await client.localControls.revokeInstruction(row.path);
        if (!decided.ok) return { kind: 'text', text: `Nothing was revoked: ${decided.error}` };
        return { kind: 'text', text: `Revoked ${row.path}. The agent now sees it as reference material.` };
      }
      return { kind: 'text', text: 'Usage: /instructions [page <cursor>|read <page> <n>|approve <page> <n> <digest>|revoke <page> <n>]' };
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
          ? `Advisor: on. Minimum severity ${config.advisorMinSeverity}. It adds one model call per turn.`
          : `Advisor: off. Minimum severity ${config.advisorMinSeverity}. /advisor on adds one model call per turn.`,
      };
    }
    case '/mcts':
    case '/tree': {
      const nodes = await client.searchNodes();
      if (nodes.length === 0) {
        return { kind: 'text', text: 'No MCTS nodes yet. Run /evolve, or ask something that needs a search.' };
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
      text: 'No file checkpoints yet. Kinu takes one each turn, before the agent first changes '
        + 'a file on YOUR machine.',
      restored: false,
    };
  }
  const n = ref ? Number.parseInt(ref, 10) : 1;
  if (!Number.isInteger(n) || n < 1 || n > turns.length) {
    const lines = [`Usage: /undo [n], where n is turns back (1–${turns.length} available):`];
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
      lines.push(`${entry.dir} already matches that checkpoint. Nothing to restore.`);
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
  lines.push('Pick with /takes <n>. Your pick becomes a preference signal.');
  return lines.join('\n');
}

/**
 * The staged file, whole, with the digest a decision has to quote back.
 *
 * Deliberately unbounded where every other renderer here clamps: this is the
 * approval surface, and a truncated one asks for a decision about bytes the
 * decider could not see.
 */
function renderStagedSkill(view: StagedSkillView, requestRef: string, editRef: string): string {
  return [
    `Staged skill for ${view.target}`,
    `digest ${view.digest}`,
    view.intact
      ? ''
      : 'WARNING: these bytes are not the ones the refinement recorded. '
        + 'Re-run the refinement before approving.',
    '',
    view.source,
    '',
    `Approve:  /refine approve ${requestRef} ${editRef} ${view.digest}`,
    `Reject:   /refine reject ${requestRef} ${editRef} ${view.digest}`,
  ].filter((line, index) => line !== '' || index > 2).join('\n');
}

/** A `/refine <verb> <n> <m>` reference resolved against the live listing. */
type LocatedRefinementEdit =
  | { readonly ok: true; readonly id: string; readonly index: number;
      readonly requestRef: string; readonly editRef: string }
  | { readonly ok: false; readonly error: string };

/**
 * Resolve `/refine approve 1 2` against the listing the operator just read.
 *
 * By INDEX, because that is what the listing prints and what a person can type;
 * the ids are nanoids nobody retypes. Re-fetched before resolving, so the index
 * always resolves against the same ordering the decision is made from — the same
 * discipline `/changelog revert <n>` follows.
 */
function resolveRefinementEdit(
  view: AgentRefinementView,
  requestRef: string | undefined,
  editRef: string | undefined,
): LocatedRefinementEdit {
  const n = Number.parseInt(requestRef ?? '', 10);
  const edit = Number.parseInt(editRef ?? '', 10);
  if (!Number.isInteger(n) || n < 1 || !Number.isInteger(edit) || edit < 1) {
    return { ok: false, error: REFINE_USAGE };
  }
  const request = view.requests[n - 1];
  if (!request) {
    return { ok: false, error: `No refinement ${n}. /refine lists ${view.requests.length}.` };
  }
  if (!request.routes[edit - 1]) {
    return {
      ok: false,
      error: `Refinement ${n} has no edit ${edit}. It lists ${request.routes.length}.`,
    };
  }
  return {
    ok: true, id: request.id, index: edit - 1,
    requestRef: String(n), editRef: String(edit),
  };
}

/** One route line: which authority took the edit, and what state it is in. */
function renderRefinementRoute(route: RefinementRoute, index: number): string {
  const where = route.owner === '' ? 'no owning authority' : route.owner;
  // Offered only where a decision is still the owner's to make. A decided row
  // that still advertised the action would invite a click that is refused.
  const decide = route.disposition === 'pending_owner_approval'
    ? '  ← /refine show to read it, then approve|reject'
    : '';
  return `      ${index + 1}. ${route.kind} → ${route.target || '(none)'} `
    + `[${route.disposition}] · ${where}${decide}`
    + (route.reason === undefined ? '' : `\n         ${route.reason}`);
}

/** What one request became, for the surface that just opened it. */
function renderRefinementRequest(request: RefinementRequestView): string {
  const lines = [
    `Refinement ${request.id} — ${request.stage} (${request.scope} scope, ${request.trigger})`,
    `  reviewed ${request.turnIds.length} graded turn${request.turnIds.length === 1 ? '' : 's'}`
      + (request.detail === '' ? '' : `\n  ${request.detail}`),
  ];
  request.routes.forEach((route, index) => lines.push(renderRefinementRoute(route, index)));
  if (request.routes.length > 0) {
    lines.push('', 'Nothing pending is live yet: /changelog shows each proposal with its evidence and revert.');
  }
  return lines.join('\n');
}

/** The `/refine` listing: what is owed, then what has been refined. */
function renderRefinementsText(view: AgentRefinementView): string {
  const lines = [view.debt.summary];
  if (view.debt.owed) {
    lines.push('  /refine now opens one over those turns.');
  }
  if (view.requests.length === 0) {
    lines.push('', 'No refinements yet.');
    return lines.join('\n');
  }
  lines.push('', `Refinements (${view.requests.length})`);
  view.requests.forEach((request, index) => {
    const when = new Date(request.createdAt).toISOString().slice(0, 16).replace('T', ' ');
    lines.push(`${String(index + 1).padStart(3)}. ${request.stage} · ${when} · ${request.trigger}`);
    lines.push(`      ${request.detail || '(no detail yet)'}`);
    request.routes.forEach((route, index) => lines.push(renderRefinementRoute(route, index)));
  });
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
      return `⎇ branching: running "${task}" in parallel (the live turn continues)`;
    case 'settled':
      return '⎇ branch settled into alternate takes. /takes to compare and pick';
    case 'error':
      return `⎇ branch discarded: ${event.message}`;
  }
}

/** What a pick did, for the surfaces' confirmation line. */
export function describeTakePick(result: TakePickOutcome, n: number): string {
  if (!result.changedAnswer) {
    return `Take ${n} confirmed. The answered approach stays as an explicit preference.`;
  }
  return `Take ${n} picked. Preference recorded, convergence re-pointed` +
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
