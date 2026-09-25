/** Slash commands shared by the TUI and classic REPL; outcomes are presentation-neutral. */

import { fmtUsd, limitLines, MAIN_ACCOUNT, specWithoutAccount, usageTotal } from '@kinu.run/core';
import { ADVISOR_SEVERITIES, DEFAULT_ROLE_ID, REASONING_EFFORTS, REFINEMENT_DECISIONS, offeredReasoningEfforts, formatPlanWithLineNumbers, planTitle, type PlanReview, type StagedSkillView, type RefinementRequestView, type RefinementRoute, isAdvisorSeverity, isReasoningEffort, summarizeRestorePlan, takeEvidence, type AlternateTakeSet, type BranchStatusEvent, type EvolutionConfigView, type FileCheckpointEntry, type ReasoningEffort, type TakePickOutcome } from '@kinu.run/core';
import type { AgentChangelogView, AgentClient, AgentClientStatus, AgentRefinementView } from './agent-client';
import type { InstructionSourceRow } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { loadActiveProfile, updateDefaultAccount } from './default-model';
import { readAllAccountUsage } from './account-usage';
import { plural, renderAccountSpendLines, renderSearchTreeLines } from './display';

export interface SlashCommandInfo {
  name: string;
  description: string;
  usage?: string;
  /** Only offered when the client exposes this capability surface. */
  requires?: 'localControls' | 'consents' | 'checkpoints' | 'rename' | 'plans';
}

interface SlashContext {
  readonly client: AgentClient;
  /** Lowercased; what an unknown outcome names. */
  readonly command: string;
  /** Joined and trimmed. */
  readonly arg: string;
  /** As typed. */
  readonly rest: readonly string[];
}

interface SlashCommand extends SlashCommandInfo {
  readonly run: (context: SlashContext) => Promise<SlashOutcome> | SlashOutcome;
  /** Names that reach this handler without a palette row of their own. */
  readonly aliases?: readonly string[];
  /** Dispatchable and never offered: no palette row, no help line. */
  readonly hidden?: true;
}

const ACCOUNTS_USAGE = '/accounts [use <provider> <account|default>] [default <provider> <account>]';

const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: '/help', description: 'List commands and keys', run: helpCommand },
  { name: '/status', description: 'Show this agent\'s mission, model and counts', run: statusCommand },
  { name: '/tools', description: 'List the tools this agent can use', run: toolsCommand },
  { name: '/model', description: 'Show or set this workspace\'s model', usage: '/model [spec]', run: modelCommand },
  { name: '/effort', description: 'Show or set this workspace\'s reasoning effort', usage: '/effort [level]', run: effortCommand },
  { name: '/stats', description: 'Show each provider account\'s limits and what is left, then usage and API-equivalent cost', usage: '/stats [refresh]', run: statsCommand },
  { name: '/accounts', description: 'Show each provider\'s accounts; choose this workspace\'s or the default', usage: ACCOUNTS_USAGE, run: accountsCommand },
  { name: '/role', description: 'Show or choose this agent\'s role', usage: '/role [id]', run: roleCommand },
  { name: '/rename', description: 'Rename this agent. Kinu never renames over a name you chose', usage: '/rename <name>', requires: 'rename', run: renameCommand },
  { name: '/settings', description: 'Open interactive settings', run: settingsCommand },
  { name: '/theme', description: 'Choose the TUI theme', run: themeCommand },
  { name: '/models', description: 'List configured model providers', requires: 'localControls', run: modelsCommand },
  { name: '/memory', description: 'Show the agent\'s memory', run: memoryCommand },
  { name: '/changelog', description: 'Review what the agent changed about itself; revert one by number', usage: '/changelog [revert <n>]', run: changelogCommand },
  { name: '/refine', description: 'Review fixes staged from corrected turns; approve or reject each', usage: '/refine [now|show <n> <edit>|approve <n> <edit> <digest>|reject <n> <edit> <digest>]', run: refineCommand },
  { name: '/takes', description: 'Compare the latest alternate takes; pick one by number', usage: '/takes [n]', run: takesCommand },
  { name: '/tree', description: 'Show the MCTS search tree', aliases: ['/mcts'], run: treeCommand },
  { name: '/jobs', description: 'List background jobs', run: jobsCommand },
  { name: '/connect', description: 'Connect this computer so the agent can run commands on it', requires: 'consents', run: connectCommand },
  { name: '/stop', description: 'Stop the running turn', run: stopCommand },
  { name: '/queue', description: 'Send a message after the running turn ends', usage: '/queue <text>', run: queueCommand },
  { name: '/branch', description: 'Try another direction alongside the running turn', usage: '/branch <text>', run: branchCommand },
  { name: '/plan', description: 'Have the agent draft a plan, then approve it or send it back', usage: '/plan [<text>|show|approve [notes]|changes <feedback>]', requires: 'plans', run: planCommand },
  { name: '/fork', description: 'Walk back: restart the conversation just before an earlier message', usage: '/fork [number]', run: forkCommand },
  { name: '/undo', description: 'Restore files to how they were n turns back, then offer to walk back the chat', usage: '/undo [n]', requires: 'checkpoints', run: undoCommand },
  { name: '/approval', description: 'Show or set when shell commands need your approval', usage: '/approval strict|allow_all|deny_all', requires: 'localControls', run: approvalCommand },
  { name: '/instructions', description: 'Approve which AGENTS.md and skill files the agent follows', usage: '/instructions [page <cursor>|read <page> <n>|approve <page> <n> <digest>|revoke <page> <n>]', requires: 'localControls', run: instructionsCommand },
  { name: '/always', description: 'Choose skills that are always active', usage: '/always <name...|none>', requires: 'localControls', run: alwaysCommand },
  { name: '/advisor', description: 'Turn the advisor on or off, or set what it reports. On, it adds one model call per turn', usage: '/advisor [on|off|severity <nit|concern|blocker>]', run: advisorCommand },
  { name: '/exit', description: 'Leave the chat', aliases: ['/quit'], run: exitCommand },
  { name: '/cancel', description: 'Close the open overlay', hidden: true, run: cancelCommand },
];

export function commandsForClient(
  client: Pick<AgentClient, 'localControls' | 'consents' | 'checkpoints' | 'rename' | 'plans'>,
): SlashCommandInfo[] {
  return SLASH_COMMANDS.filter((command) => {
    if (command.hidden) return false;

    if (!command.requires) return true;
    const capability = client[command.requires];

    return capability !== null && capability !== undefined;
  });
}

function commandHelp(
  client: Pick<AgentClient, 'localControls' | 'consents' | 'checkpoints' | 'rename' | 'plans'>,
): string {
  const lines = ['Commands'];

  for (const command of commandsForClient(client)) {
    const usage = command.usage ?? command.name;
    lines.push(`  ${usage.padEnd(26)} ${command.description}`);
  }

  return lines.join('\n');
}

/** A path discovery declined says so. */
function instructionState(row: InstructionSourceRow): string {
  if (row.reason !== undefined) return `not readable: ${row.reason}`;

  switch (row.decision) {
    case 'grandfathered': return 'carried over';
    case 'approved': return 'approved';
    case 'revoked': return 'refused';
    case 'none': return 'not decided';
  }
}

/** Lower sorts first; null drops the command. */
function matchRank(query: string, name: string, description: string): number | null {
  if (query === '') return 3;

  if (name === query) return 0;

  if (name.startsWith(query)) return 1;

  if (description.includes(query)) return 2;

  return fuzzySubsequence(query, name) ? 3 : null;
}

export function filterCommands(commands: readonly SlashCommandInfo[], draft: string): SlashCommandInfo[] {
  const token = draft.trimStart();

  if (!token.startsWith('/')) return [];
  const query = token.slice(1).split(/\s+/, 1)[0]?.toLowerCase() ?? '';

  return commands
    .map((command, index) => {
      const name = command.name.slice(1).toLowerCase();
      const description = command.description.toLowerCase();

      return { command, index, rank: matchRank(query, name, description) };
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

export function resolveCommandDraft(commands: readonly SlashCommandInfo[], draft: string): string {
  const trimmed = draft.trim();

  if (!trimmed.startsWith('/') || /\s/.test(trimmed)) return trimmed;
  const exact = commands.find((command) => command.name === trimmed);

  if (exact) return trimmed;
  const matches = filterCommands(commands, trimmed);

  return matches.length === 1 ? matches[0].name : trimmed;
}

export type SlashOutcome =
  | { kind: 'text'; text: string }
  | { kind: 'status'; status: AgentClientStatus }
  | { kind: 'changelog'; view: AgentChangelogView }
  | { kind: 'takes'; set: AlternateTakeSet }
  | { kind: 'exit' }
  | { kind: 'model-picker' }
  | { kind: 'settings' }
  | { kind: 'theme' }
  | { kind: 'model-set'; spec: string }
  | { kind: 'effort-set'; effort: ReasoningEffort }
  | { kind: 'role-set'; role: string }
  | { kind: 'device-connect' }
  /** Surface-owned queue. */
  | { kind: 'queue'; text?: string }
  /** Parallel branch of the running turn; a normal send when idle. */
  | { kind: 'branch'; text?: string }
  /** Plan turn ending in a review this command decides. */
  | { kind: 'plan'; text?: string }
  /** Surfaces own the candidate list and the fork() call. */
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

function helpCommand({ client }: SlashContext): SlashOutcome {
  return { kind: 'text', text: commandHelp(client) };
}

async function statusCommand({ client }: SlashContext): Promise<SlashOutcome> {
  return { kind: 'status', status: await client.status() };
}

async function toolsCommand({ client }: SlashContext): Promise<SlashOutcome> {
  const tools = await client.describeTools();
  const lines = ['Built-in:', ...tools.builtIn.map(({ name, description }) => `  ${name}: ${description}`)];

  if (tools.crafted.length > 0) {
    lines.push('', 'Crafted:', ...tools.crafted.map(({ name, description }) => `  ${name}: ${description.slice(0, 50)}`));
  }

  return { kind: 'text', text: lines.join('\n') };
}

async function modelCommand({ client, arg }: SlashContext): Promise<SlashOutcome> {
  if (!arg) return { kind: 'model-picker' };
  const result = await client.setModel(arg);

  return { kind: 'model-set', spec: result.spec };
}

async function statsCommand({ client, arg }: SlashContext): Promise<SlashOutcome> {
  const [usage, spend] = await Promise.all([readAllAccountUsage({ refresh: arg === 'refresh' }), client.workspaceSpend()]);
  const tokens = usageTotal(spend.total.usage);
  const usd = spend.total.usd === undefined ? 'unpriced' : fmtUsd(spend.total.usd);
  const here = `This workspace: ${tokens === undefined ? 'unmeasured' : `${tokens.toLocaleString()} tokens`}, ${usd}, ${plural(spend.total.calls, 'call')}`;
  const unread = usage.unread.length === 0 ? [] : [`Not counted, could not be read: ${usage.unread.join(', ')}`];

  return {
    kind: 'text',
    text: [
      ...limitLines(usage.limits ?? [], usage.limitsUnread ?? [], Date.now()),
      `Across your ${plural(usage.workspaces, 'workspace')}`, ...renderAccountSpendLines(usage.accounts, Date.now()),
      ...unread, here,
    ].join('\n'),
  };
}

async function accountsCommand({ client, rest }: SlashContext): Promise<SlashOutcome> {
  const [verb, provider, account] = rest.map((word) => word.trim().toLowerCase());

  if (verb === 'use' && provider && account) {
    const own = await client.setProviderAccount(provider, account === 'default' ? null : account);
    const chosen = own[provider];

    return { kind: 'text', text: chosen === undefined ? `This workspace runs ${provider} on its default account.` : `This workspace runs ${provider} on ${chosen}.` };
  }

  if (verb === 'default' && provider && account) {
    await updateDefaultAccount(provider, account);

    return { kind: 'text', text: `${provider} runs on ${account} in every workspace that has not chosen its own.` };
  }

  if (verb !== undefined) return { kind: 'text', text: `Usage: ${ACCOUNTS_USAGE}` };
  const [menu, own, profile] = await Promise.all([client.listModels(), client.getProviderAccounts(), loadActiveProfile()]);
  const held = menu.accounts ?? {};
  const providers = [...new Set([...Object.keys(held), ...Object.keys(own)])].sort();

  if (providers.length === 0) return { kind: 'text', text: 'No provider holds an account yet. Connect one with kinu provider connect <provider>.' };

  const lines = providers.map((id) => {
    const fallback = profile.catalog.accounts?.[id] ?? MAIN_ACCOUNT;
    const names = (held[id] ?? []).map((name) => (name === fallback ? `${name} (default)` : name));
    const here = own[id] === undefined ? '' : ` · this workspace: ${own[id]}`;

    return `  ${id}: ${names.join(', ') || 'none connected'}${here}`;
  });

  return { kind: 'text', text: ['Accounts', ...lines, `Choose: ${ACCOUNTS_USAGE}`].join('\n') };
}

async function roleCommand({ client, arg }: SlashContext): Promise<SlashOutcome> {
  if (!arg) {
    const status = await client.status();

    return { kind: 'text', text: `Role: ${status.roleId ?? DEFAULT_ROLE_ID}` };
  }

  const result = await client.setRole(arg);

  return { kind: 'role-set', role: result.role };
}

async function renameCommand({ client, arg }: SlashContext): Promise<SlashOutcome> {
  if (!client.rename) return { kind: 'text', text: 'You cannot rename this agent from this client.' };

  if (!arg) return { kind: 'text', text: 'Usage: /rename <name>' };
  const renamed = await client.rename(arg);

  return { kind: 'text', text: `Renamed to ${renamed.displayName}.` };
}

function settingsCommand(): SlashOutcome {
  return { kind: 'settings' };
}

function themeCommand(): SlashOutcome {
  return { kind: 'theme' };
}

async function modelsCommand({ client, command }: SlashContext): Promise<SlashOutcome> {
  if (!client.localControls) return { kind: 'unknown', command };
  const providers = await client.localControls.listModelProviders();

  if (providers.length === 0) {
    return { kind: 'text', text: 'This session has no local provider registry.' };
  }

  const lines = ['Providers:'];

  for (const provider of providers) {
    lines.push(`  ${provider.id}: ${provider.available ? 'available' : provider.unavailableReason ?? 'unavailable'}`);
  }

  const menu = await client.listModels();

  if (menu.models.length > 0) {
    lines.push('', 'Models:');

    for (const model of menu.models.slice(0, 40)) lines.push(`  ${model.spec}  ${model.label}`);

    if (menu.models.length > 40) lines.push(`  … ${menu.models.length - 40} more`);
  }

  for (const failure of menu.failures) {
    lines.push(`  ! ${failure.label ?? failure.provider} could not be listed: ${failure.reason}`);
  }

  return { kind: 'text', text: lines.join('\n') };
}

async function memoryCommand({ client }: SlashContext): Promise<SlashOutcome> {
  const content = await client.readMemory();

  if (!content) return { kind: 'text', text: 'Memory is empty.' };

  const shown = content.length > 1500
    ? `${content.slice(0, 1500)}\n… [+${content.length - 1500} chars: read memory/MEMORY.md for the rest]`
    : content;

  return { kind: 'text', text: `Memory:\n${shown}` };
}

async function changelogCommand({ client, rest }: SlashContext): Promise<SlashOutcome> {
  if (rest[0] === 'revert') {
    const n = Number.parseInt(rest[1] ?? '', 10);

    if (!Number.isInteger(n) || n < 1) {
      return { kind: 'text', text: 'Usage: /changelog revert <n>. Take n from the /changelog listing.' };
    }

    // Re-fetch so the index resolves against the ordering the listing showed.
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

async function refineCommand({ client, rest }: SlashContext): Promise<SlashOutcome> {
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

async function takesCommand({ client, arg }: SlashContext): Promise<SlashOutcome> {
  const set = await client.latestTakes();

  if (!set || set.candidates.length < 2) {
    return { kind: 'text', text: 'No alternate takes yet. They appear after a swarm search with near-tied approaches, or after a /branch redirect settles.' };
  }

  if (!arg) return { kind: 'takes', set };
  const n = Number.parseInt(arg, 10);
  const candidate = Number.isInteger(n) ? set.candidates[n - 1] : undefined;

  if (!candidate) {
    return { kind: 'text', text: `No take "${arg}". /takes lists ${set.candidates.length}.` };
  }

  return { kind: 'text', text: describeTakePick(await client.pickTake(set.id, candidate.nodeId), n) };
}

async function treeCommand({ client }: SlashContext): Promise<SlashOutcome> {
  const nodes = await client.searchNodes();

  if (nodes.length === 0) {
    return { kind: 'text', text: 'No MCTS nodes yet. Ask something that needs a search, or run kinu evolve <name> from a shell.' };
  }

  return { kind: 'text', text: `MCTS Tree (${nodes.length} nodes):\n${renderSearchTreeLines(nodes).join('\n')}` };
}

async function jobsCommand({ client }: SlashContext): Promise<SlashOutcome> {
  const jobs = await client.listJobs(20);

  return {
    kind: 'text',
    text: jobs.length
      ? jobs.map((job) => `${job.id}  ${job.kind}  ${job.status}`).join('\n')
      : 'No background jobs.',
  };
}

function connectCommand({ client, command }: SlashContext): SlashOutcome {
  if (!client.consents) return { kind: 'unknown', command };

  return { kind: 'device-connect' };
}

function stopCommand({ client }: SlashContext): SlashOutcome {
  const dropped = client.stop();

  return {
    kind: 'text',
    text: dropped.length > 0
      ? `Stop requested for the active turn. Undelivered steered input:\n${dropped.map((t) => `  ${t}`).join('\n')}`
      : 'Stop requested for the active turn.',
  };
}

function queueCommand({ arg }: SlashContext): SlashOutcome {
  return { kind: 'queue', text: arg || undefined };
}

function branchCommand({ arg }: SlashContext): SlashOutcome {
  return { kind: 'branch', text: arg || undefined };
}

async function planCommand({ client, command, arg, rest }: SlashContext): Promise<SlashOutcome> {
  const plans = client.plans;

  if (!plans) return { kind: 'unknown', command };
  const [sub, ...args] = rest.filter((token) => token);

  if (sub === undefined || sub === 'show') return { kind: 'text', text: renderPlanReview(await plans.active()) };

  if (sub === 'approve' || sub === 'changes') {
    const active = await plans.active();

    if (!active) return { kind: 'text', text: 'No plan is waiting for you. Draft one with /plan <what to plan>.' };
    const feedback = args.join(' ').trim();

    if (sub === 'changes' && !feedback) {
      return { kind: 'text', text: 'Usage: /plan changes <feedback>. Say what has to change; the agent revises against it.' };
    }

    const decided = await plans.decide(
      active.id, active.revision,
      sub === 'approve' ? 'approve' : 'request_changes',
      feedback || undefined,
    );

    if (!decided.ok) return { kind: 'text', text: `The plan was not decided: ${decided.error}` };

    return {
      kind: 'text',
      text: sub === 'approve'
        ? `Approved plan ${decided.plan.id} revision ${String(decided.plan.revision)}. The agent is implementing it now.`
        : `Sent plan ${decided.plan.id} revision ${String(decided.plan.revision)} back for changes. The agent is revising it now.`,
    };
  }

  return { kind: 'plan', text: arg || undefined };
}

function forkCommand({ arg }: SlashContext): SlashOutcome {
  return { kind: 'fork', ref: arg || undefined };
}

function undoCommand({ client, command, arg }: SlashContext): SlashOutcome {
  if (!client.checkpoints) return { kind: 'unknown', command };

  return { kind: 'undo', ref: arg || undefined };
}

function approvalCommand({ client, command, arg }: SlashContext): SlashOutcome {
  if (!client.localControls) return { kind: 'unknown', command };

  if (!arg) return { kind: 'text', text: `Shell approval: ${client.localControls.getShellApprovalMode()}` };

  if (arg === 'strict' || arg === 'allow_all' || arg === 'deny_all') {
    return { kind: 'text', text: `Shell approval: ${client.localControls.setShellApprovalMode(arg)}` };
  }

  return { kind: 'text', text: 'Usage: /approval strict | allow_all | deny_all' };
}

async function instructionsCommand({ client, command, rest }: SlashContext): Promise<SlashOutcome> {
  if (!client.localControls) return { kind: 'unknown', command };
  const [sub, pageToken, indexToken, rowToken, reviewedDigest] = rest.filter((token) => token);

  const pageCursor = (token: string | undefined): { after: string } | null | 'invalid' => {
    if (token === undefined || token === 'root') return null;

    // Page anchors contain NUL, so they travel as base64url; the alphabet check is the whole malformed-input policy.
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
          const state = instructionState(row);
          const kind = row.kind === 'skill' ? 'skill' : 'AGENTS.md';

          return `  ${String(index + 1)}. [${state}] ${row.path} (${kind}, ${String(row.bytes)} bytes): ${actionUsage(pageId, index + 1, row.path)}`;
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

function alwaysCommand({ client, command, rest }: SlashContext): SlashOutcome {
  if (!client.localControls) return { kind: 'unknown', command };
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

async function advisorCommand({ client, rest }: SlashContext): Promise<SlashOutcome> {
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

function exitCommand(): SlashOutcome {
  return { kind: 'exit' };
}

function cancelCommand(): SlashOutcome {
  return { kind: 'cancel' };
}

const DISPATCH = new Map<string, SlashCommand>(
  SLASH_COMMANDS.flatMap((command): [string, SlashCommand][] =>
    [command.name, ...command.aliases ?? []].map((name) => [name, command])),
);

export async function executeSlashCommand(client: AgentClient, input: string): Promise<SlashOutcome> {
  const [rawCmd, ...rest] = input.split(/\s+/);
  const command = rawCmd.toLowerCase();
  const entry = DISPATCH.get(command);

  if (!entry) return { kind: 'unknown', command };

  return entry.run({ client, command, arg: rest.join(' ').trim(), rest });
}

async function effortCommand({ client, arg }: SlashContext): Promise<SlashOutcome> {
  if (!arg) {
    const [stored, spec, tier] = await Promise.all([
      client.getReasoningEffort(),
      client.getModelSpec(),
      loadActiveProfile().then((profile) => profile.catalog.tiers.default),
    ]);

    const current = stored ?? tier.reasoningEffort ?? 'medium';
    const model = spec ?? tier.model;
    // Levels come from the model's catalog entry (#9); unreadable falls back to the whole vocabulary.
    let levels: string;

    try {
      const listed = specWithoutAccount(model);
      const declared = (await client.listModels()).models.find((entry) => entry.spec === listed)?.reasoningEfforts;
      levels = declared === undefined
        ? `${REASONING_EFFORTS.join(', ')} (the catalog does not say which ${model} accepts)`
        : offeredReasoningEfforts(declared, current).join(', ') || 'none; the model takes no effort setting';
    } catch (cause) {
      levels = `${REASONING_EFFORTS.join(', ')} (catalog unavailable: ${renderThrownChain({ cause })})`;
    }

    return {
      kind: 'text',
      text: `Reasoning effort: ${current}${stored === null ? ' (the default tier\'s)' : ''}\nLevels for ${model}: ${levels}\nSet this workspace's with /effort <level>.`,
    };
  }

  if (!isReasoningEffort(arg)) {
    return { kind: 'text', text: `Usage: /effort <${REASONING_EFFORTS.join('|')}>` };
  }

  const result = await client.setReasoningEffort(arg);

  return { kind: 'effort-set', effort: result.effort };
}

interface UndoResult {
  text: string;
  /** The surface then offers the conversation walk-back. */
  restored: boolean;
}

/** Newest first; a turn may snapshot several dirs. */
function groupCheckpointsByTurn(entries: ReadonlyArray<FileCheckpointEntry>): FileCheckpointEntry[][] {
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

/** Restore the checkpoint before the nth-most-recent turn (default last), then offer walk-back. */
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
        + 'a file on this machine.',
      restored: false,
    };
  }

  const n = ref ? Number.parseInt(ref, 10) : 1;

  if (!Number.isInteger(n) || n < 1 || n > turns.length) {
    const lines = [`Usage: /undo [n], where n is turns back (1 to ${turns.length}):`];

    for (const [i, group] of turns.slice(0, 10).entries()) {
      const at = new Date(group[0].at).toLocaleString();
      lines.push(`  ${i + 1}. ${at}  ${group.map((e) => e.dir).join(', ')}`);
    }

    return { text: lines.join('\n'), restored: false };
  }

  // The window chooses; the store acts. `list(200)` may hold only some of a turn's per-directory checkpoints,
  // so re-read the chosen turn by id to restore all of it.
  const chosen = turns[n - 1];
  const chosenTurnId = chosen[0].turnId;

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

export function renderTakesText(set: AlternateTakeSet): string {
  const lines = [`Alternate takes for: ${set.task.replace(/\s+/g, ' ').slice(0, 100)}`];

  for (const [i, candidate] of set.candidates.entries()) {
    const marker = candidate.nodeId === (set.chosenNodeId ?? set.winnerNodeId) ? '★' : ' ';
    lines.push(`  ${i + 1}. ${marker} [${takeEvidence(candidate)}]`);
    lines.push(`       ${candidate.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  }

  lines.push('Pick with /takes <n>. Your pick becomes a preference signal.');

  return lines.join('\n');
}

/** Unbounded on purpose: this is the approval surface. */
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

type LocatedRefinementEdit =
  | { readonly ok: true; readonly id: string; readonly index: number;
      readonly requestRef: string; readonly editRef: string }
  | { readonly ok: false; readonly error: string };

/** By listing index, against a re-fetched listing. */
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

function renderRefinementRoute(route: RefinementRoute, index: number): string {
  const where = route.owner === '' ? 'no owning authority' : route.owner;

  // Offered only while the decision is still the owner's.
  const decide = route.disposition === 'pending_owner_approval'
    ? '  ← /refine show to read it, then approve|reject'
    : '';

  return `      ${index + 1}. ${route.kind} → ${route.target || '(none)'} `
    + `[${route.disposition}] · ${where}${decide}`
    + (route.reason === undefined ? '' : `\n         ${route.reason}`);
}

function renderRefinementRequest(request: RefinementRequestView): string {
  const lines = [
    `Refinement ${request.id}: ${request.stage} (${request.scope} scope, ${request.trigger})`,
    `  reviewed ${request.turnIds.length} graded turn${request.turnIds.length === 1 ? '' : 's'}`
      + (request.detail === '' ? '' : `\n  ${request.detail}`),
  ];

  for (const [index, route] of request.routes.entries()) lines.push(renderRefinementRoute(route, index));

  if (request.routes.length > 0) {
    lines.push('', 'Nothing pending is live yet: /changelog shows each proposal with its evidence and revert.');
  }

  return lines.join('\n');
}

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

  for (const [index, request] of view.requests.entries()) {
    const when = new Date(request.createdAt).toISOString().slice(0, 16).replace('T', ' ');
    lines.push(`${String(index + 1).padStart(3)}. ${request.stage} · ${when} · ${request.trigger}`);
    lines.push(`      ${request.detail || '(no detail yet)'}`);

    for (const [routeIndex, route] of request.routes.entries()) lines.push(renderRefinementRoute(route, routeIndex));
  }

  return lines.join('\n');
}

export function isBranchStatusEvent(event: { type: string }): event is BranchStatusEvent {
  return event.type === 'branch_status';
}

/** Shared so a `plan_updated` broadcast and `/plan show` read identically. */
export function renderPlanReview(plan: PlanReview | null): string {
  if (!plan) return 'No plan yet. /plan <what to plan> drafts one for review.';

  const states: Record<PlanReview['status'], string> = {
    pending: 'waiting for you: /plan approve [notes] or /plan changes <feedback>',
    changes_requested: 'sent back for changes; the agent is revising it',
    approved: 'approved',
    superseded: 'superseded by a newer revision',
  };

  return [
    `${planTitle(plan.content)}: ${plan.id} revision ${String(plan.revision)} (${states[plan.status]})`,
    '',
    formatPlanWithLineNumbers(plan.content),
  ].join('\n');
}

export function describeBranchStatus(event: BranchStatusEvent): string {
  const task = event.task.replace(/\s+/g, ' ').slice(0, 80);

  switch (event.status) {
    case 'running':
      return `⎇ branch started: "${task}". The running turn carries on.`;
    case 'settled':
      return '⎇ branch finished. /takes compares the answers so you can pick one.';
    case 'error':
      return `⎇ branch discarded: ${event.message}`;
  }
}

export function describeTakePick(result: TakePickOutcome, n: number): string {
  if (!result.changedAnswer) {
    return `Take ${n} confirmed. The answered approach stays as an explicit preference.`;
  }

  return `Take ${n} picked. Preference recorded, convergence re-pointed` +
    (result.continuationQueued ? ', and the agent will continue with this approach.' : '.');
}

/** Absent shows no row. */
function autoEvolveText(autoEvolve: boolean | undefined): string | undefined {
  if (autoEvolve === undefined) return undefined;

  return autoEvolve ? 'auto' : 'manual';
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
    row('Evolve:', autoEvolveText(status.autoEvolve)),
  ].filter((line): line is string => line !== null);
}
