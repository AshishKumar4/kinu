/**
 * The volatile half of the context split: `buildSystemPromptSync` is a byte-stable prefix that changes only on
 * agent events; the rest rides in messages.
 *
 * Dynamic context (DynamicContextLedger): each step renders live state into a `<dynamic_context>` block, added only
 * when it changed: before the turn's input at its first step, at the tail after. A change is a delta (lists by row,
 * after a full block, which states the grammar) unless a full block is no longer or the deltas pass KEYFRAME_SHARE.
 * Blocks freeze where born (moving one invalidates every later cache breakpoint); only `dropSuperseded`, under
 * measured pressure, removes any. Stored in the working context, they are re-woven while the provider's cache holds
 * them and collapse into one block once it does not. Nothing clock-derived may render.
 *
 * The unapproved workspace files ride the same ledger as their own message, apart from the block, which asserts
 * runtime provenance: sent where first needed, again only when they change, collapsed with the blocks.
 */

import type { ModelMessage } from 'ai';
import { fnv1a64 } from '../utils/fnv1a';
import { isDeepStrictEqual } from 'node:util';
import {
  DYNAMIC_CONTEXT_DELIMITER, DYNAMIC_CONTEXT_OPEN_TAG, WORKSPACE_INSTRUCTIONS_TAG, sealDelimiters,
} from '../utils/prompt-sections';
import { executorIsSelectable, type PromptExecutorInfo } from './surface';
import { type TurnReason, type WorkMode } from '../types/turn';
import { EXECUTOR_CAPABILITIES } from '../execution/types';
import {
  connectedDevices, describeGpuNodes, effectiveDeviceMode, sandboxCause,
  type DeviceFleetEntry,
} from '../execution/device-status';
import { deviceMountSegment } from '../execution/device-tunnel-executor';
import { EXECUTOR_MOUNTS } from '../vfs/mounts';
import type { ActiveSkillSet } from '../skills/types';
import { describeActivationReason } from '../skills/render';
import { compareSkillNames } from '../skills/discover';
import type { ActiveRoster, DynamicApproval, MissingCapability } from '../types/dynamic-context';
import { renderCraftedToolsDeclaration, type CraftedDeclaration } from '../tools/sandbox-contract';

export type { DynamicApproval, MissingCapability } from '../types/dynamic-context';

/** One row of the background-job registry (jobs/store.ts). */
export interface DynamicJob {
  readonly id: string;
  readonly kind: string;
  readonly label: string | null;
}

/** One agent_tasks row (tools/task-store.ts), flattened: a subtask follows its parent and names it. */
export interface DynamicTask {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly parentId: string | null;
}

/** A spawned subordinate or a running search. */
export interface DynamicDelegate {
  readonly kind: 'subordinate' | 'swarm node';
  readonly name: string;
  readonly phase: string;
  readonly task?: string | null;
}

/** Callers order lists; the renderer caps them. */
export interface DynamicContext {
  /** Absent where a caller has no turn to name. */
  turn?: TurnReason;
  mode?: { readonly workMode: WorkMode; readonly planSubmission: boolean };
  /** Active skills and why each is on; their bodies render in the stable prefix. */
  skills?: readonly { readonly name: string; readonly reason: string }[];
  /** Empty renders a "none yet" line: the model checks `workspace.listTools()` before building. */
  craftedTools?: readonly CraftedDeclaration[];
  factsBlock?: string;
  memoryTail?: string;
  /** Re-read per step; facts and the memory tail freeze at turn assembly. */
  recoveries?: readonly string[];
  /** Status labels only; executor doctrine lives in the stable prefix. */
  executors?: readonly PromptExecutorInfo[];
  /** Every machine by name, never "the device"; absent where a backend has no fleet. */
  devices?: readonly DeviceFleetEntry[];
  jobs?: ActiveRoster<DynamicJob>;
  /** Open items only; settled ones are read back via `tasks({action:'list'})`. */
  tasks?: ActiveRoster<DynamicTask>;
  delegates?: ActiveRoster<DynamicDelegate>;
  /** Oldest first: the longest-blocked matters most. */
  approvals?: ActiveRoster<DynamicApproval>;
  /** Configured capabilities missing from this turn's surface, so the model can explain their absence. */
  missingCapabilities?: readonly MissingCapability[];
}

/** The search roster as delegates, in the surface's words (`agents({action:'swarm'})`, nodes), never `fork` or
 *  "head", which the model cannot invoke. */
export function searchDelegates(
  runs: ReadonlyArray<{ rootId: string; rationale: string; running: number; total: number }>,
): DynamicDelegate[] {
  return runs.map((run) => ({
    kind: 'swarm node',
    name: run.rootId,
    phase: `${run.running} of ${run.total} nodes running`,
    task: run.rationale || null,
  }));
}

/** Flat because the cap counts rows, which is what rides the request. */
function flattenTaskList(
  tasks: ReadonlyArray<{
    id: string; title: string; status: string;
    subtasks: ReadonlyArray<{ id: string; title: string; status: string }>;
  }>,
): DynamicTask[] {
  return tasks.flatMap((task) => [
    { id: task.id, title: task.title, status: task.status, parentId: null },
    ...task.subtasks.map((sub) => ({
      id: sub.id, title: sub.title, status: sub.status, parentId: task.id,
    })),
  ]);
}

export interface DynamicContextSources {
  readonly turn?: TurnReason;
  readonly mode?: DynamicContext['mode'];
  readonly activeSkills?: ActiveSkillSet;
  readonly craftedTools?: readonly CraftedDeclaration[];
  readonly factsBlock: string | undefined;
  /** Read once per turn (the plane's only await); callers close over it. */
  readonly memoryTail: string | undefined;
  /** Synchronous per-step read, so a mid-turn finding shows on the next step. */
  readonly recoveryFindings: readonly string[];
  readonly executors: readonly PromptExecutorInfo[];
  readonly devices?: readonly DeviceFleetEntry[];
  readonly runningJobs: ActiveRoster<{ id: string; kind: string; label: string | null }>;
  /** TaskListStore.listOpen(): filters open items before its transport bound. */
  readonly openTasks: ActiveRoster<{
    id: string; title: string; status: string;
    subtasks: ReadonlyArray<{ id: string; title: string; status: string }>;
  }>;
  readonly liveHeadRuns: ActiveRoster<{ rootId: string; rationale: string; running: number; total: number }>;
  /** This backend's own hires, listed ahead of the search roster. Absent renders nothing. */
  readonly subordinateDelegates?: readonly DynamicDelegate[];
  readonly approvals?: ActiveRoster<DynamicApproval>;
   readonly missingCapabilities: readonly MissingCapability[];
}

/** Both backends' live state for one step: this alone decides which planes exist; an absent one renders nothing. */
export function agentDynamicContext(sources: DynamicContextSources): DynamicContext {
  const subordinateDelegates = sources.subordinateDelegates ?? [];
  const headDelegates = searchDelegates(sources.liveHeadRuns.items);

  const context: DynamicContext = {
    turn: sources.turn,
    mode: sources.mode,
    craftedTools: sources.craftedTools,
    // Re-listed per step: availability flips mid-turn.
    executors: sources.executors,
    jobs: {
      items: sources.runningJobs.items.map((job) => ({ id: job.id, kind: job.kind, label: job.label })),
      total: sources.runningJobs.total,
    },
    tasks: {
      items: flattenTaskList(sources.openTasks.items),
      // The store counts flattened open rows, the unit the cap spends.
      total: sources.openTasks.total,
    },
    delegates: {
      items: [...subordinateDelegates, ...headDelegates],
      total: subordinateDelegates.length + sources.liveHeadRuns.total,
    },
  };

  if (sources.devices !== undefined && sources.devices.length > 0) context.devices = sources.devices;

  if (sources.activeSkills !== undefined && sources.activeSkills.active.length > 0) {
    const reasons = new Map(sources.activeSkills.reasons.map((r) => [r.name, r.reason]));

    context.skills = sources.activeSkills.active.map((skill) => skill.name).sort(compareSkillNames)
      .map((name) => ({ name, reason: describeActivationReason(reasons.get(name)) }));
  }

  if (sources.approvals && sources.approvals.total > 0) context.approvals = sources.approvals;

  if (sources.factsBlock) context.factsBlock = sources.factsBlock;

  if (sources.memoryTail) context.memoryTail = sources.memoryTail;

  if (sources.recoveryFindings.length > 0) context.recoveries = sources.recoveryFindings;

  if (sources.missingCapabilities.length > 0) {
    context.missingCapabilities = sources.missingCapabilities;
  }

  return context;
}

const CHANGED_ROWS = '(changed rows)';

const REMOVED_ROW = 'removed:';

const APPENDED = '(appended)';

export const DYNAMIC_CONTEXT_HEADER =
  'Kinu runtime state, not conversation or user text. A full block replaces prior state; a delta changes only what it names.\n'
  + `A delta section replaces its section. Under "${CHANGED_ROWS}", a row replaces the row with its id or is added at the end,\n`
  + `and "${REMOVED_ROW} <id>" drops one; a task's, job's or delegate's id is its first word, any other row's its whole text.\n`
  + `"${APPENDED}" adds lines to its section's end. Execution deltas update named runtimes. Cleared means empty.`;

const DYNAMIC_DELTA_HEADER = 'Kinu runtime state update, not conversation or user text.';

function renderTurnReason(turn: TurnReason): string {
  if (turn.provenance === 'chat') return 'Chat: this turn answers the conversation\'s newest message.';

  if (turn.provenance === 'signal') return `Signal: the harness delivered this turn's message (${turn.event}).`;

  return `Background resume: a background job finished${turn.job === null ? '' : ` (${turn.job})`} and nobody typed `
    + 'anything. Fetch its result first, synthesize it, then continue or close the work you backgrounded.';
}

/** Volatile, so rendered in the dynamic-context block, never the cacheable prefix. */
export function executorAvailabilityLabel(exec: PromptExecutorInfo): string {
  if (exec.name === 'device') return exec.active || exec.status === 'active' ? 'connected' : 'available';

  if (exec.active || exec.status === 'active') return 'active';

  if (exec.status === 'idle' || exec.configured) return 'ready on demand';

  return 'available';
}

/** Declared limits as `(cpus=1 mem=2G)`: in a cgroup `nproc` reports host cores, and `-j` is sized by this. */
function executorLimitsSuffix(exec: PromptExecutorInfo): string {
  const parts: string[] = [];
  const cpus = exec.resourceLimits?.cpus;
  const memBytes = exec.resourceLimits?.memBytes;

  if (cpus !== undefined) parts.push(`cpus=${cpus}`);

  if (memBytes !== undefined) parts.push(`mem=${formatBytes(memBytes)}`);

  return parts.length > 0 ? ` (${parts.join(' ')})` : '';
}

/** Declared capabilities, which `shell`'s description points at, in canonical order: a Set-order flip cannot
 *  re-fingerprint the block. */
function executorCapabilitySuffix(exec: PromptExecutorInfo): string {
  const declared = new Set(exec.capabilities ?? []);
  const ordered = EXECUTOR_CAPABILITIES.filter((capability) => declared.has(capability));

  return ordered.length > 0 ? `, runs: ${ordered.join(', ')}` : '';
}

/** Mount point in the agent's file plane (vfs/mounts.ts), only on selectable (live) rows. */
function executorMountSuffix(exec: PromptExecutorInfo): string {
	// Widened read view: a name outside the table has no mount.
	const byName: Record<string, string | undefined> = EXECUTOR_MOUNTS;
	const mount = byName[exec.name];

	return mount ? `, files at ${mount}` : '';
}

/** Shared by the row marker and the legend so they cannot drift apart. */
const NOT_MEASURED_LABEL = 'not measured here';

function renderExecutorStatus(exec: PromptExecutorInfo): string {
  return `- ${exec.name}: ${executorAvailabilityLabel(exec)}${executorMountSuffix(exec)}${executorLimitsSuffix(exec)}`
    + `${executorCapabilitySuffix(exec)}${executorUnmeasuredSuffix(exec)}${executorSandboxSuffix(exec)}`;
}

function renderExecutionLegend(executors: readonly PromptExecutorInfo[]): string[] {
  const hasUnknown = executors.some((exec) => EXECUTOR_CAPABILITIES
    .some((capability) => exec.unmeasuredCapabilities?.includes(capability)));

  return hasUnknown
    ? [`("${NOT_MEASURED_LABEL}" means nobody asked that environment. It may well work, so try it before ruling it out.)`]
    : [];
}

/** Unknowns never read as measured absences (a GPU is beyond what PATH shows). Canonical union order. */
function executorUnmeasuredSuffix(exec: PromptExecutorInfo): string {
  const unmeasured = new Set(exec.unmeasuredCapabilities ?? []);
  const ordered = EXECUTOR_CAPABILITIES.filter((capability) => unmeasured.has(capability));

  return ordered.length > 0 ? `, ${NOT_MEASURED_LABEL}: ${ordered.join(', ')}` : '';
}

/** At most one decimal, never rounded up: a cap must not read as more than it is. */
function formatBytes(bytes: number): string {
  for (const [unit, scale] of [['G', 1024 ** 3], ['M', 1024 ** 2], ['K', 1024]] as const) {
    if (bytes >= scale) return `${trimZero(Math.floor((bytes / scale) * 10) / 10)}${unit}`;
  }

  return `${bytes}B`;
}

function trimZero(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** What a command on the user's machine gets (sandboxing, persistent directory):
 * three states, three sentences, so the model need not guess. */
function executorSandboxSuffix(exec: PromptExecutorInfo): string {
  const sandbox = exec.sandbox;

  if (sandbox === undefined) return '';

  switch (effectiveDeviceMode(sandbox)) {
    case 'sandboxed': {
      const writable = sandbox.roots.length > 0 ? `, writable: ${sandbox.roots.join(', ')}` : '';

      return `, sandboxed full bash, GPU: ${describeGpuNodes(sandbox.gpu)}`
        + `, agent home ${sandbox.agentHome ?? 'not reported'}${writable}`
        + '. No sudo, apt, dnf or brew: install into the agent home (uv, python -m venv, npm -g, bun, cargo, micromamba)';
    }

    case 'raw':
      return ', sandbox off for this device: commands run as the owner, with full access to the machine';
    case 'files_only':
      return `, device cannot sandbox: ${sandboxCause(sandbox)}`
        + ', files only, no shell. Reading and writing files still works';
  }
}

/** Live devices add mount, grant, run mode and toolchain; nothing clock- or order-derived (`probedAt`). */
function renderDeviceLine(device: DeviceFleetEntry, fleet: readonly DeviceFleetEntry[]): string {
  const platform = device.os ? ` (${device.os})` : '';

  if (!device.connected) {
    return `- ${device.name}${platform}: registered, offline. The user can reconnect it with \`kinu connect\``;
  }

  const mount = `/pc/${deviceMountSegment(device, fleet)}`;
  const parts = [`- ${device.name}${platform}: connected, files at ${mount}`];

  if (device.granted === true) parts.push('this workspace holds its grant');
  else if (device.granted === false) parts.push('no grant yet for this workspace: the first call asks once');

  if (device.sandbox !== undefined) parts.push(executorSandboxSuffix({ name: 'device', sandbox: device.sandbox }).replace(/^, /, ''));
  // The hub refreshes aged answers; no clock is consulted in a render.
  const present = device.toolchain?.present ?? [];
  const runs = EXECUTOR_CAPABILITIES.filter((capability) => present.includes(capability));

  if (runs.length > 0) parts.push(`runs: ${runs.join(', ')}`);

  return parts.join(', ');
}

/** The block rides every request: rosters state a head and an honest tail count. */
const MAX_JOBS = 8;

/** Rows, not tasks. Larger than other caps: a plan cut off early stops being a plan. */
const MAX_TASK_ROWS = 15;

const MAX_DELEGATES = 8;

const MAX_APPROVALS = 5;

const MAX_MISSING_CAPABILITIES = 8;

const MAX_RECOVERIES = 5;

/** Two bounded arg echoes per finding; the one-line budget would cut the useful half. */
const RECOVERY_ENTRY_CHARS = 480;

const ENTRY_CHARS = 120;

function clip(text: string, max = ENTRY_CHARS): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();

  return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine;
}

interface SectionRow {
  readonly id: string;
  readonly line: string;
}

interface RenderedSection {
  readonly text: string;
  readonly rows?: readonly SectionRow[];
  readonly log?: string;
}

/** A row's id as the header states it: in a `keyed` list the first word, else the whole row. */
function rowOf(line: string, keyed: boolean): SectionRow {
  const text = line.replace(/^\s*- /u, '');

  return { id: keyed ? text.split(' ', 1)[0] ?? text : text, line };
}

/** Elision is counted from the roster's true total, never the returned page. Null when empty. */
function rosterSection<T>(
  title: string,
  roster: ActiveRoster<T>,
  listing: { readonly cap: number; readonly keyed: boolean },
  line: (item: T) => string,
): RenderedSection | null {
  if (roster.total === 0) return null;
  const lines = roster.items.slice(0, listing.cap).map(line);
  const elided = roster.total - lines.length;

  if (elided > 0) lines.push(`- …and ${elided} more, not shown`);

  return { text: [title, ...lines].join('\n'), rows: lines.map((row) => rowOf(row, listing.keyed)) };
}

function textSection(title: string, body: string): RenderedSection {
  return { text: `${title}\n${body}`, rows: body.split('\n').map((line) => rowOf(line, false)) };
}

/** An absent plane renders nothing, never "(none)". */
const EMPTY_ROSTER: ActiveRoster<never> = { items: [], total: 0 };

const DYNAMIC_SECTION_TITLES = {
  turn: '## Why this turn runs',
  mode: '## Work mode',
  skills: '## Active skills (why each is on)',
  craftedTools: '## Crafted tools available through eval',
  factsBlock: '## World model (facts you remembered)',
  memoryTail: '## Memory (newest MEMORY.md lessons and reflections)',
  recoveries: '## Proven by execution (environment evidence: calls that kept failing until a changed call ran clean)',
  executors: '## Execution status',
  devices: '## Your user\'s machines (the `device` runtime)',
  tasks: '## Your task list: what is still open (you keep this with the `tasks` tool)',
  jobs: '## Background work still running (collect it before you finish)',
  delegates: '## Delegates working for you',
  approvals: '## Waiting on the user (not on you)',
  missingCapabilities: '## Configured but not available this turn (plan without these, and say so if asked)',
} satisfies Record<keyof DynamicContext, string>;

/** For a reported empty set; an unreported (`undefined`) set stays silent. */
const NO_CRAFTED_TOOLS_YET =
  'No crafted tools exist in this workspace yet. `workspace.listTools()` returns an empty list; `workspace.createTool` adds the first.';

function renderDynamicSections(ctx: DynamicContext): Map<keyof DynamicContext, RenderedSection> {
  const sections = new Map<keyof DynamicContext, RenderedSection>();

  const add = (key: keyof DynamicContext, section: RenderedSection | null): void => {
    if (section !== null) sections.set(key, section);
  };

  if (ctx.turn) add('turn', { text: `${DYNAMIC_SECTION_TITLES.turn}\n${renderTurnReason(ctx.turn)}` });

  if (ctx.mode) add('mode', { text: renderWorkMode(ctx.mode) });

  add('skills', rosterSection(
    DYNAMIC_SECTION_TITLES.skills, { items: ctx.skills ?? [], total: (ctx.skills ?? []).length },
    { cap: Infinity, keyed: false },
    (skill) => `- ${skill.name}: ${skill.reason}`,
  ));

  if (ctx.craftedTools !== undefined) {
    add('craftedTools', { text: `${DYNAMIC_SECTION_TITLES.craftedTools}\n${ctx.craftedTools.length > 0
      ? renderCraftedToolsDeclaration(ctx.craftedTools)
      : NO_CRAFTED_TOOLS_YET}` });
  }

  const facts = ctx.factsBlock?.trim();

  if (facts) add('factsBlock', textSection(DYNAMIC_SECTION_TITLES.factsBlock, facts));

  const memoryTail = ctx.memoryTail?.trim();

  if (memoryTail) add('memoryTail', { text: `${DYNAMIC_SECTION_TITLES.memoryTail}\n${memoryTail}`, log: memoryTail });

  add('recoveries', rosterSection(
    DYNAMIC_SECTION_TITLES.recoveries,
    { items: ctx.recoveries ?? [], total: (ctx.recoveries ?? []).length }, { cap: MAX_RECOVERIES, keyed: false },
    (finding) => `- ${clip(finding, RECOVERY_ENTRY_CHARS)}`,
  ));

  const executors = (ctx.executors ?? []).filter(executorIsSelectable);

  if (executors.length > 0) {
    add('executors', { text: [
      DYNAMIC_SECTION_TITLES.executors,
      'Live availability for the runtimes described in the system prompt, and what each one declares it can run:',
      ...executors.map(renderExecutorStatus),
      ...renderExecutionLegend(executors),
    ].join('\n') });
  }

  const fleet = ctx.devices ?? [];

  if (fleet.length > 0) {
    const live = connectedDevices(fleet);

    // One live machine needs no name; several do, in the same words the refusal uses.
    const doctrine = live.length > 1
      ? 'Several machines are connected: name the machine each `shell { runtime: "<nickname>" }` call is for. The runtime refuses a call that names none.'
      : 'One machine is connected: `shell { runtime: "<nickname>" }` reaches it, and `shell { runtime: "device" }` reaches the sole machine.';

    add('devices', { text: [
      DYNAMIC_SECTION_TITLES.devices,
      doctrine,
      'A machine\'s first use in this workspace asks the user for consent: that prompt is expected, not an error.',
      ...fleet.map((device) => renderDeviceLine(device, fleet)),
    ].join('\n') });
  }

  add('tasks', rosterSection(
    DYNAMIC_SECTION_TITLES.tasks,
    ctx.tasks ?? EMPTY_ROSTER, { cap: MAX_TASK_ROWS, keyed: true },
    (task) => `${task.parentId ? '  ' : ''}- ${task.id} [${task.status}] ${clip(task.title)}`,
  ));

  add('jobs', rosterSection(
    DYNAMIC_SECTION_TITLES.jobs,
    ctx.jobs ?? EMPTY_ROSTER, { cap: MAX_JOBS, keyed: true },
    (job) => `- ${job.id} (${job.kind})${job.label ? `: ${clip(job.label)}` : ''}`,
  ));

  add('delegates', rosterSection(
    DYNAMIC_SECTION_TITLES.delegates,
    ctx.delegates ?? EMPTY_ROSTER, { cap: MAX_DELEGATES, keyed: true },
    (d) => `- ${d.name} (${d.kind}), ${clip(d.phase, 40)}${d.task ? `: ${clip(d.task)}` : ''}`,
  ));

  add('approvals', rosterSection(
    DYNAMIC_SECTION_TITLES.approvals,
    ctx.approvals ?? EMPTY_ROSTER, { cap: MAX_APPROVALS, keyed: false },
    (a) => `- ${clip(a.kind, 40)}: ${clip(a.detail)}`,
  ));

  add('missingCapabilities', rosterSection(
    DYNAMIC_SECTION_TITLES.missingCapabilities,
    { items: ctx.missingCapabilities ?? [], total: (ctx.missingCapabilities ?? []).length }, { cap: MAX_MISSING_CAPABILITIES, keyed: false },
    (m) => `- ${clip(m.source, 60)}: ${clip(m.reason)}`,
  ));

  return sections;
}

function dynamicBody(sections: readonly string[], header = DYNAMIC_CONTEXT_HEADER): string | null {
  if (sections.length === 0) return null;

  return sealDelimiters(
    [header, ...sections].join('\n\n'),
    DYNAMIC_CONTEXT_DELIMITER, 'dynamic_context',
  );
}

function dynamicBlock(body: string, established: { readonly kind: 'full' } | { readonly kind: 'delta'; readonly state: string }): string {
  const state = established.kind === 'delta' ? ` state="${established.state}"` : '';

  return `${DYNAMIC_CONTEXT_OPEN_TAG} fingerprint="${fnv1a64(body)}" kind="${established.kind}"${state}>\n${body}\n</dynamic_context>`;
}

function fullBody(sections: ReadonlyMap<keyof DynamicContext, RenderedSection>): string | null {
  return dynamicBody([...sections.values()].map((section) => section.text));
}

export function renderDynamicContextBlock(ctx: DynamicContext): string | null {
  const body = fullBody(renderDynamicSections(ctx));

  return body === null ? null : dynamicBlock(body, { kind: 'full' });
}

function executorDetails(exec: PromptExecutorInfo) {
  const { active: _active, status: _status, available: _available, configured: _configured,
    capabilities, unmeasuredCapabilities, ...details } = exec;

  return { ...details, capabilities: [...new Set(capabilities ?? [])].sort(),
    unmeasuredCapabilities: [...new Set(unmeasuredCapabilities ?? [])].sort() };
}

function executionDelta(before: readonly PromptExecutorInfo[], after: readonly PromptExecutorInfo[]): string {
  const previous = new Map(before.filter(executorIsSelectable).map((exec) => [exec.name, exec]));
  const current = new Map(after.filter(executorIsSelectable).map((exec) => [exec.name, exec]));
  const changes: string[] = [DYNAMIC_SECTION_TITLES.executors];
  const changedExecutors: PromptExecutorInfo[] = [];

  for (const [name, exec] of current) {
    const old = previous.get(name);

    if (old && renderExecutorStatus(old) === renderExecutorStatus(exec)) continue;
    changes.push(old && isDeepStrictEqual(executorDetails(old), executorDetails(exec))
      ? `- ${name} status went from \`${executorAvailabilityLabel(old)}\` to \`${executorAvailabilityLabel(exec)}\`.`
      : renderExecutorStatus(exec));
    changedExecutors.push(exec);
  }

  for (const name of previous.keys()) {
    if (!current.has(name)) changes.push(`- ${name}: removed from execution status.`);
  }

  return [...changes, ...renderExecutionLegend(changedExecutors)].join('\n');
}

interface ToldSections {
  readonly sections: ReadonlyMap<keyof DynamicContext, RenderedSection>;
  readonly executors: readonly PromptExecutorInfo[];
}

/** Null unless a reader folds it back to `after`: ids unique, kept rows first in their old order. */
function rowDelta(title: string, before: readonly SectionRow[], after: readonly SectionRow[]): string | null {
  const previous = new Map(before.map((row) => [row.id, row.line]));
  const current = new Set(after.map((row) => row.id));

  if (previous.size !== before.length || current.size !== after.length) return null;
  const kept = before.filter((row) => current.has(row.id));

  if (kept.some((row, index) => after[index]?.id !== row.id)) return null;
  const lines = after.filter((row) => previous.get(row.id) !== row.line).map((row) => row.line);

  for (const id of previous.keys()) {
    if (!current.has(id)) lines.push(`- ${REMOVED_ROW} ${id}`);
  }

  return [`${title} ${CHANGED_ROWS}`, ...lines].join('\n');
}

/** The lines `after` adds past `before`; null otherwise, as when a window slides. */
function appendedText(before: string, after: string): string | null {
  return after.startsWith(`${before}\n`) ? after.slice(before.length + 1) : null;
}

function sectionDelta(key: keyof DynamicContext, before: RenderedSection, after: RenderedSection): string {
  const title = DYNAMIC_SECTION_TITLES[key];
  let partial: string | null = null;

  if (before.rows !== undefined && after.rows !== undefined) partial = rowDelta(title, before.rows, after.rows);

  if (before.log !== undefined && after.log !== undefined) {
    const appended = appendedText(before.log, after.log);

    partial = appended === null ? null : `${title} ${APPENDED}\n${appended}`;
  }

  return partial !== null && partial.length < after.text.length ? partial : after.text;
}

function deltaSections(previous: ToldSections, current: ToldSections): string[] {
  const changed: string[] = [];

  for (const [key, section] of current.sections) {
    const before = previous.sections.get(key);

    if (before?.text === section.text) continue;

    if (before === undefined) changed.push(section.text);
    else changed.push(key === 'executors' ? executionDelta(previous.executors, current.executors) : sectionDelta(key, before, section));
  }

  for (const key of previous.sections.keys()) {
    if (!current.sections.has(key)) changed.push(`${DYNAMIC_SECTION_TITLES[key]}\nCleared: no current entries.`);
  }

  return changed;
}

function renderWorkMode(mode: NonNullable<DynamicContext['mode']>): string {
  return `${DYNAMIC_SECTION_TITLES.mode}\nMode: ${mode.workMode}; submit_plan: ${mode.planSubmission ? 'available' : 'unavailable'}.`;
}

/** The turn's input: its last message when a person or a parent wrote it, else the end. Only the last, as an
 *  earlier user message can be a parent's conversation a hire inherited, whose prefix stays intact. */
export function turnInputStart(messages: ReadonlyArray<ModelMessage>): number {
  return messages.at(-1)?.role === 'user' ? messages.length - 1 : messages.length;
}

/** The un-woven index of the turn's input; blocks born at its first step ride before it. */
export interface TurnInput {
  readonly at: number;
  readonly firstStep: boolean;
}

interface LedgerBlock {
  /** Un-woven position at birth, kept forever; a slot since taken by a tool result renders after it. */
  readonly index: number;
  readonly text: string;
  readonly kind: 'full' | 'delta' | 'instructions';
  /** Chars/4 cost, priced once at birth for the step pruner and `dropSuperseded`. */
  readonly tokens: number;
  readonly message: ModelMessage;
}

/** Past consecutive `tool` messages, where a frozen index can land on a later turn: nothing may sit between a
 *  call and its results (`AI_MissingToolResultsError`), and `settleUnpairedToolCalls` runs only at assembly. */
function insertionPoint(history: ReadonlyArray<ModelMessage>, index: number): number {
  let at = index;

  while (history[at]?.role === 'tool') at += 1;

  return at;
}

/** Rides right before `before`, else right after `after`. */
export interface StoredDynamicBlock {
  readonly text: string;
  readonly before: ModelMessage | null;
  readonly after: ModelMessage | null;
}

/** Stored before its request leaves, before `before` (null: at the end); `replaces` every stored block. */
export interface DynamicBlockBirth {
  readonly text: string;
  readonly before: ModelMessage | null;
  readonly replaces: boolean;
}

/** Deltas since the newest full block, in its chars, past which a change is stated whole: the longest chain
 *  measured, as glm-5.3 read the task list back 10/10 at every share up to 20 row deltas (6.5 full blocks). */
const KEYFRAME_SHARE = 6;

const BLOCK_TAG = new RegExp(`^${DYNAMIC_CONTEXT_OPEN_TAG} fingerprint="([^"]*)" kind="(full|delta)"(?: state="([^"]*)")?>`, 'u');

function blockTag(text: string): { readonly kind: 'full' | 'delta'; readonly state: string } | null {
  const match = BLOCK_TAG.exec(text);

  if (match === null) return null;
  const [, fingerprint = '', kind, state = ''] = match;

  return kind === 'full' ? { kind, state: fingerprint } : { kind: 'delta', state };
}

/** The copy that goes out once no unapproved file is left, so the earlier ones read as withdrawn. */
const INSTRUCTIONS_WITHDRAWN = `<${WORKSPACE_INSTRUCTIONS_TAG}>\nNo unapproved workspace files remain: the copies above no longer apply.\n</${WORKSPACE_INSTRUCTIONS_TAG}>`;

function blockKind(text: string): LedgerBlock['kind'] {
  return text.startsWith(`<${WORKSPACE_INSTRUCTIONS_TAG}>`) ? 'instructions' : blockTag(text)?.kind ?? 'full';
}

/** `history` excludes the blocks and the instruction copies, so positions are durable history's. `reset()` when
 *  the durable stream is rewritten (compaction) or the provider's cache expired. */
export class DynamicContextLedger {
  private blocks: LedgerBlock[] = [];
  /** The state the model holds (a delta's `state`); sections once rendered here. */
  private told: { readonly state: string; readonly sections: ToldSections | null } | null = null;
  /** The unapproved instructions the newest copy carries. */
  private toldInstructions: string | null = null;
  private stored: readonly StoredDynamicBlock[] | null = null;
  private loaded: boolean;
  private unresolved: { readonly block: LedgerBlock; readonly replaces: boolean }[] = [];
  private births: DynamicBlockBirth[] = [];

  constructor(private readonly durable = false) {
    this.loaded = !durable;
  }

  get size(): number {
    return this.blocks.length;
  }

  /** Chars/4 overhead of frozen blocks, reserved by the step pruner (pruning runs before the weave). */
  get overheadTokens(): number {
    let tokens = 0;

    for (const block of this.blocks) tokens += block.tokens;

    for (const block of this.stored ?? []) tokens += Math.round(block.text.length / 4);

    return tokens;
  }

  adopt(blocks: readonly StoredDynamicBlock[]): void {
    if (this.loaded) return;
    this.loaded = true;
    this.stored = blocks;
  }

  unload(): void {
    this.reset();
    this.loaded = !this.durable;
  }

  takeBirths(): readonly DynamicBlockBirth[] {
    const births = this.births;
    this.births = [];

    return births;
  }

  /** One full block and the instructions copy at the newest position replace the rest, breaking the prefix cache:
   *  only for a caller over the ladder's trigger. Returns tokens freed (chars/4). */
  dropSuperseded(): number {
    const newest = this.blocks.at(-1);
    const sections = this.told?.sections ?? null;

    if (newest === undefined || sections === null) return 0;
    const body = fullBody(sections.sections);
    const survivors = [this.toldInstructions, body === null ? null : dynamicBlock(body, { kind: 'full' })].filter((text) => text !== null);

    if (this.blocks.length <= survivors.length) return 0;
    const before = this.overheadTokens;
    this.blocks = [];

    for (const text of survivors) this.blocks.push(this.born(newest.index, text, this.blocks.length === 0));

    return before - this.overheadTokens;
  }

  /** `instructions`: the turn's unapproved instruction files as one message, null for none, undefined when the caller
   *  keeps none. A copy is born where it is first needed and again only when it changes. */
  weave(history: ReadonlyArray<ModelMessage>, state: DynamicContext, input?: TurnInput, instructions?: string | null): ModelMessage[] {
    if (this.stored !== null) this.restore(this.stored, history);

    let previousIndex = -1;

    for (const block of this.blocks) {
      // A rewritten history invalidates frozen positions, reset or not.
      if (block.index > history.length || block.index < previousIndex) {
        this.reset();
        break;
      }

      previousIndex = block.index;
    }

    const current = Object.freeze(structuredClone(state));
    const rendered: ToldSections = { sections: renderDynamicSections(current), executors: current.executors ?? [] };
    const body = fullBody(rendered.sections);
    const established = fnv1a64(body ?? '');
    const birth = input?.firstStep === true ? Math.min(input.at, history.length) : turnInputStart(history);

    // Before the state block born with it, which keeps the turn's reasons nearest its input.
    if (instructions !== undefined && instructions !== this.toldInstructions) {
      const copy = instructions ?? INSTRUCTIONS_WITHDRAWN;
      this.blocks.push(this.born(birth, copy, this.blocks.length === 0));
      this.toldInstructions = instructions;
    }

    if (established !== (this.told?.state ?? fnv1a64(''))) {
      const text = this.statement(rendered, body, established);

      if (text !== null) this.blocks.push(this.born(birth, text, this.blocks.length === 0));
    }

    this.told = { state: established, sections: rendered };

    for (const { block, replaces } of this.unresolved) this.births.push({ text: block.text, before: history[block.index] ?? null, replaces });
    this.unresolved = [];

    const woven: ModelMessage[] = [];
    let cursor = 0;

    for (const block of this.blocks) {
      const at = insertionPoint(history, Math.max(block.index, cursor));
      woven.push(...history.slice(cursor, at), block.message);
      cursor = at;
    }

    woven.push(...history.slice(cursor));

    return woven;
  }

  reset(): void {
    this.blocks = [];
    this.told = null;
    this.toldInstructions = null;
    this.stored = null;
    this.unresolved = [];
    this.births = [];
    this.loaded = true;
  }

  private restore(stored: readonly StoredDynamicBlock[], history: ReadonlyArray<ModelMessage>): void {
    this.blocks = this.place(stored, history);
    const state = this.blocks.filter((block) => block.kind !== 'instructions').at(-1);
    const copy = this.blocks.filter((block) => block.kind === 'instructions').at(-1);
    this.told = state === undefined ? null : { state: blockTag(state.text)?.state ?? '', sections: null };
    this.toldInstructions = copy === undefined || copy.text === INSTRUCTIONS_WITHDRAWN ? null : copy.text;
    this.stored = null;
  }

  private statement(rendered: ToldSections, body: string | null, established: string): string | null {
    const full = body === null ? null : dynamicBlock(body, { kind: 'full' });
    const states = this.blocks.filter((block) => block.kind !== 'instructions');
    const known = states.length === 0 ? null : this.told?.sections ?? null;
    const changes = known === null ? null : dynamicBody(deltaSections(known, rendered), DYNAMIC_DELTA_HEADER);

    if (changes === null) return full;
    const delta = dynamicBlock(changes, { kind: 'delta', state: established });

    if (full === null) return delta;

    // Appended: a warm cache keeps every byte before it.
    const since = states.map((block) => block.kind).lastIndexOf('full');
    const pending = states.slice(since + 1).reduce((chars, block) => chars + block.text.length, 0);

    return full.length <= delta.length || pending + delta.length > KEYFRAME_SHARE * full.length ? full : delta;
  }

  /** A neighbour a fold took places none. */
  private place(stored: readonly StoredDynamicBlock[], history: ReadonlyArray<ModelMessage>): LedgerBlock[] {
    const blocks: LedgerBlock[] = [];

    for (const block of stored) {
      const neighbour = block.before ?? block.after;
      const found = neighbour === null ? 0 : history.indexOf(neighbour);

      if (found < 0) return [];
      blocks.push(this.block(block.before === null && neighbour !== null ? found + 1 : found, block.text));
    }

    return blocks;
  }

  private born(index: number, text: string, replaces: boolean): LedgerBlock {
    const block = this.block(index, text);

    if (this.durable) this.unresolved.push({ block, replaces });

    return block;
  }

  private block(index: number, text: string): LedgerBlock {
    return Object.freeze({
      index, text, kind: blockKind(text), tokens: Math.round(text.length / 4),
      message: Object.freeze({ role: 'user', content: text }),
    });
  }
}

/** `first` is the session's opening turn, with nothing to compare against. */
export interface SystemPromptObservation {
  readonly hash: string;
  readonly status: 'first' | 'stable' | 'changed';
}

/** `changed` should mean an agent event (soul, model, skill/tool surface); anything
 * else is a cache-busting bug this catches. */
export function observeSystemPromptHash(
  previous: string | null,
  system: string,
): SystemPromptObservation {
  const hash = fnv1a64(system);

  if (previous === null) return { hash, status: 'first' };

  return { hash, status: previous === hash ? 'stable' : 'changed' };
}
