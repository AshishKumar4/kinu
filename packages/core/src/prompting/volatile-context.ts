/**
 * The volatile half of the context split. `buildSystemPromptSync` is a
 * byte-stable prefix that changes only on real agent events; everything else
 * rides in messages.
 *
 * Dynamic context (DynamicContextLedger): each model step renders live state
 * into one `<dynamic_context fingerprint="…">` block, added only when it differs
 * from the newest block: before the turn's input at a turn's first step, at the
 * tail after that. Blocks freeze where born (moving a mid-array message
 * invalidates every later cache breakpoint); only `dropSuperseded`, under
 * measured pressure, removes any. In-memory only. Nothing clock-derived may
 * render: it would append a block per request.
 *
 * Turn-local state (skill activation reasons, device notice, provenance) is one
 * user message right before the turn's input, for this turn only, never
 * fingerprinted. The request stays the last user-role content the model reads:
 * news after it reads as the turn itself.
 */

import type { ModelMessage } from 'ai';
import { fnv1a64 } from '../utils/fnv1a';
import { isDeepStrictEqual } from 'node:util';
import {
  DYNAMIC_CONTEXT_DELIMITER, DYNAMIC_CONTEXT_OPEN_TAG, sealDelimiters,
} from './sections';
import { executorIsSelectable, type PromptExecutorInfo } from './surface';
import { type TurnProvenance, type WorkMode } from '../types/turn';
import { EXECUTOR_CAPABILITIES } from '../execution/types';
import {
  connectedDevices, describeGpuNodes, effectiveDeviceMode, sandboxCause,
  type DeviceFleetEntry,
} from '../execution/device-status';
import { deviceMountSegment } from '../execution/device-tunnel-executor';
import { EXECUTOR_MOUNTS } from '../vfs/mounts';
import type { ActiveSkillSet } from '../skills/types';
import { describeActivationReason } from '../skills/render';
import type { DynamicApproval, MissingCapability } from '../types/dynamic-context';
import { renderCraftedToolsDeclaration, type CraftedDeclaration } from '../tools/sandbox-contract';

export type { DynamicApproval, MissingCapability } from '../types/dynamic-context';

/** One row of the background-job registry (jobs/store.ts). */
export interface DynamicJob {
  readonly id: string;
  readonly kind: string;
  readonly label: string | null;
}

/** One agent_tasks row (tasks/store.ts), flattened: a subtask follows its parent and names it. */
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

/** Items passing the store's open filter plus the true count; the renderer states any elision from `total`. */
export interface ActiveRoster<T> {
  readonly items: readonly T[];
  readonly total: number;
}

/** Live state at one model step, read from existing sources; owns no state.
 *  Lists arrive ordered by the caller and are capped by the renderer. */
export interface DynamicContext {
  mode?: { readonly workMode: WorkMode; readonly planSubmission: boolean };
  /** An empty list still renders one "none yet" line: the doctrine has the model check
     *  `workspace.listTools()` before building, and silence left that unanswered. */
  craftedTools?: readonly CraftedDeclaration[];
  factsBlock?: string;
  memoryTail?: string;
  /** Re-read per step, so a finding recorded mid-turn rides every later step
     *  (facts and the memory tail are frozen at turn assembly). */
  recoveries?: readonly string[];
  /** Status labels only; executor doctrine lives in the stable prefix. */
  executors?: readonly PromptExecutorInfo[];
  /** Every registered machine by name, so the model never reads a single "the device".
     *  Absent where a backend has no fleet. */
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

/** The live search roster as delegates, shared by both backends. Uses the surface's words
 *  (`agents({action:'swarm'})`, nodes); never `fork` or "head", which the model cannot invoke. */
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
  readonly mode?: DynamicContext['mode'];
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

/**
 * The agent's live state for one model step, shared by both backends. This
 * function alone decides which planes exist; an absent plane renders nothing
 * (never "(none)"), so a backend that cannot read one passes it absent.
 * Nothing clock-derived.
 */
export function agentDynamicContext(sources: DynamicContextSources): DynamicContext {
  const subordinateDelegates = sources.subordinateDelegates ?? [];
  const headDelegates = searchDelegates(sources.liveHeadRuns.items);

  const context: DynamicContext = {
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

  if (sources.approvals && sources.approvals.total > 0) context.approvals = sources.approvals;

  if (sources.factsBlock) context.factsBlock = sources.factsBlock;

  if (sources.memoryTail) context.memoryTail = sources.memoryTail;

  if (sources.recoveryFindings.length > 0) context.recoveries = sources.recoveryFindings;

  if (sources.missingCapabilities.length > 0) {
    context.missingCapabilities = sources.missingCapabilities;
  }

  return context;
}

export interface TurnLocalContext {
  deviceNotice?: string | null;
  /** Bodies render in the stable prefix; the per-turn activation reasons render here. */
  activeSkills?: ActiveSkillSet;
  /** An overlay, not a bar, so it stays out of the system prompt: it flips whenever a
     *  background job lands. `chat` renders nothing. */
  provenance?: TurnProvenance;
}

export const DYNAMIC_CONTEXT_HEADER =
  'Kinu runtime state, not conversation or user text. Full blocks replace prior state.\n'
  + 'Delta sections replace named sections; omitted sections stay. Execution deltas update named runtimes. Cleared means empty.';

export const TURN_CONTEXT_HEADER =
  '[Turn context: live state maintained by the Kinu runtime, not written by the user.]';

/** Turn-local, not in OPERATING_GUIDANCE: a conditional bullet in the prefix rewrote
 * the whole cached prefix on every wake/chat transition. */
const BACKGROUND_RESUME_NOTICE =
  '## Why this turn is running\n'
  + 'A background job finished; the user did not type anything. Fetch the referenced job result '
  + 'first, synthesize it, then continue or close the original work.';

/** Volatile, so rendered in the dynamic-context block, never the cacheable prefix. */
export function executorAvailabilityLabel(exec: PromptExecutorInfo): string {
  if (exec.name === 'device') return exec.active || exec.status === 'active' ? 'connected' : 'available';

  if (exec.active || exec.status === 'active') return 'active';

  if (exec.status === 'idle' || exec.configured) return 'ready on demand';

  return 'available';
}

/** Declared resource ceiling as `(cpus=1 mem=2G)`. Inside a cgroup `nproc` reports host
 * cores, so the model needs this to size `-j`. Rendered only from declared limits. */
function executorLimitsSuffix(exec: PromptExecutorInfo): string {
  const parts: string[] = [];
  const cpus = exec.resourceLimits?.cpus;
  const memBytes = exec.resourceLimits?.memBytes;

  if (cpus !== undefined) parts.push(`cpus=${cpus}`);

  if (memBytes !== undefined) parts.push(`mem=${formatBytes(memBytes)}`);

  return parts.length > 0 ? ` (${parts.join(' ')})` : '';
}

/** Declared capabilities, which the `shell` description points the model at. Rendered in
 * canonical union order so a meaningless Set-order flip cannot re-fingerprint the block. */
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

/** Unknowns must not read like measured absences (a machine may be attached for its GPU,
 * which PATH cannot establish). Canonical union order. */
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

/** Live devices add mount, grant, run mode and toolchain. Nothing clock- or
 * order-derived (`probedAt` never renders); the mount segment is the file plane's own routing. */
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

/** Per-list caps: the block rides every request, so rosters state a head and an honest tail count. */
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

/** Elision is counted from the roster's true total, never the returned page. Null when empty. */
function rosterSection<T>(
  title: string,
  roster: ActiveRoster<T>,
  cap: number,
  row: (item: T) => string,
): string | null {
  if (roster.total === 0) return null;
  const lines = roster.items.slice(0, cap).map(row);
  const elided = roster.total - lines.length;

  if (elided > 0) lines.push(`- …and ${elided} more, not shown`);

  return [title, ...lines].join('\n');
}

/** An absent plane renders nothing, never "(none)". */
const EMPTY_ROSTER: ActiveRoster<never> = { items: [], total: 0 };

const DYNAMIC_SECTION_TITLES = {
  mode: '## Work mode',
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

/** `fingerprint` digests the block body, so re-statements and stale blocks are visible. */
function renderDynamicSections(ctx: DynamicContext): Map<keyof DynamicContext, string> {
  const sections = new Map<keyof DynamicContext, string>();

  const add = (key: keyof DynamicContext, section: string | null): void => {
    if (section !== null) sections.set(key, section);
  };

  if (ctx.mode) add('mode', renderWorkMode(ctx.mode));

  if (ctx.craftedTools !== undefined) {
    add('craftedTools', `${DYNAMIC_SECTION_TITLES.craftedTools}\n${ctx.craftedTools.length > 0
      ? renderCraftedToolsDeclaration(ctx.craftedTools)
      : NO_CRAFTED_TOOLS_YET}`);
  }

  const facts = ctx.factsBlock?.trim();

  if (facts) add('factsBlock', `${DYNAMIC_SECTION_TITLES.factsBlock}\n${facts}`);

  const memoryTail = ctx.memoryTail?.trim();

  if (memoryTail) add('memoryTail', `${DYNAMIC_SECTION_TITLES.memoryTail}\n${memoryTail}`);

  add('recoveries', rosterSection(
    DYNAMIC_SECTION_TITLES.recoveries,
    { items: ctx.recoveries ?? [], total: (ctx.recoveries ?? []).length }, MAX_RECOVERIES,
    (finding) => `- ${clip(finding, RECOVERY_ENTRY_CHARS)}`,
  ));

  const executors = (ctx.executors ?? []).filter(executorIsSelectable);

  if (executors.length > 0) {
    add('executors', [
      DYNAMIC_SECTION_TITLES.executors,
      'Live availability for the runtimes described in the system prompt, and what each one declares it can run:',
      ...executors.map(renderExecutorStatus),
      ...renderExecutionLegend(executors),
    ].join('\n'));
  }

  const fleet = ctx.devices ?? [];

  if (fleet.length > 0) {
    const live = connectedDevices(fleet);

    // One live machine needs no name; several do, in the same words the refusal uses.
    const doctrine = live.length > 1
      ? 'Several machines are connected: name the machine each `shell { runtime: "<nickname>" }` call is for. The runtime refuses a call that names none.'
      : 'One machine is connected: `shell { runtime: "<nickname>" }` reaches it, and `shell { runtime: "device" }` reaches the sole machine.';

    add('devices', [
      DYNAMIC_SECTION_TITLES.devices,
      doctrine,
      ...fleet.map((device) => renderDeviceLine(device, fleet)),
    ].join('\n'));
  }

  add('tasks', rosterSection(
    DYNAMIC_SECTION_TITLES.tasks,
    ctx.tasks ?? EMPTY_ROSTER, MAX_TASK_ROWS,
    (task) => `${task.parentId ? '  - ' : '- '}${task.id} [${task.status}] ${clip(task.title)}`,
  ));

  add('jobs', rosterSection(
    DYNAMIC_SECTION_TITLES.jobs,
    ctx.jobs ?? EMPTY_ROSTER, MAX_JOBS,
    (job) => `- ${job.id} (${job.kind})${job.label ? `: ${clip(job.label)}` : ''}`,
  ));

  add('delegates', rosterSection(
    DYNAMIC_SECTION_TITLES.delegates,
    ctx.delegates ?? EMPTY_ROSTER, MAX_DELEGATES,
    (d) => `- ${d.name} (${d.kind}), ${clip(d.phase, 40)}${d.task ? `: ${clip(d.task)}` : ''}`,
  ));

  add('approvals', rosterSection(
    DYNAMIC_SECTION_TITLES.approvals,
    ctx.approvals ?? EMPTY_ROSTER, MAX_APPROVALS,
    (a) => `- ${clip(a.kind, 40)}: ${clip(a.detail)}`,
  ));

  add('missingCapabilities', rosterSection(
    DYNAMIC_SECTION_TITLES.missingCapabilities,
    { items: ctx.missingCapabilities ?? [], total: (ctx.missingCapabilities ?? []).length }, MAX_MISSING_CAPABILITIES,
    (m) => `- ${clip(m.source, 60)}: ${clip(m.reason)}`,
  ));

  return sections;
}

function dynamicBlock(sections: readonly string[], kind: 'full' | 'delta' = 'full'): string | null {
  if (sections.length === 0) return null;

  const body = sealDelimiters(
    [DYNAMIC_CONTEXT_HEADER, ...sections].join('\n\n'),
    DYNAMIC_CONTEXT_DELIMITER, 'dynamic_context',
  );

  return `${DYNAMIC_CONTEXT_OPEN_TAG} fingerprint="${fnv1a64(body)}" kind="${kind}">\n${body}\n</dynamic_context>`;
}

export function renderDynamicContextBlock(ctx: DynamicContext): string | null {
  return dynamicBlock([...renderDynamicSections(ctx).values()]);
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

function dynamicDelta(previousState: Readonly<DynamicContext>, currentState: Readonly<DynamicContext>): string | null {
  const previous = renderDynamicSections(previousState);
  const current = renderDynamicSections(currentState);
  const changed: string[] = [];

  for (const [key, section] of current) {
    const before = previous.get(key);

    if (before === section) continue;
    changed.push(key === 'executors' && before !== undefined
      ? executionDelta(previousState.executors ?? [], currentState.executors ?? []) : section);
  }

  for (const key of previous.keys()) {
    if (!current.has(key)) changed.push(`${DYNAMIC_SECTION_TITLES[key]}\nCleared: no current entries.`);
  }

  return dynamicBlock(changed, 'delta');
}

function renderWorkMode(mode: NonNullable<DynamicContext['mode']>): string {
  return `${DYNAMIC_SECTION_TITLES.mode}\nMode: ${mode.workMode}; submit_plan: ${mode.planSubmission ? 'available' : 'unavailable'}.`;
}

export function renderTurnLocalContext(ctx: TurnLocalContext): string | null {
  const sections: string[] = [];

  // First: it frames why the turn exists.
  if (ctx.provenance === 'background_resume') sections.push(BACKGROUND_RESUME_NOTICE);

  const reasons = ctx.activeSkills?.reasons ?? [];

  if (reasons.length > 0) {
    sections.push([
      '## Skills activated this turn',
      ...reasons.map((r) => `- ${r.name} (${describeActivationReason(r.reason)})`),
    ].join('\n'));
  }

  const notice = ctx.deviceNotice?.trim();

  if (notice) sections.push(notice);

  if (sections.length === 0) return null;

  return [TURN_CONTEXT_HEADER, ...sections].join('\n\n');
}

/** For this turn only: never persisted, and placed after the transformContext seam so compaction plugins never
 *  see it, right before the turn's input ({@link turnInputStart}). */
export function turnLocalContextMessage(ctx: TurnLocalContext): ModelMessage | null {
  const text = renderTurnLocalContext(ctx);

  return text ? { role: 'user', content: text } : null;
}

/** Where the turn's input sits: its last message when a person or a parent wrote it, else the end. Only the last:
 *  a user message before it can be a parent's conversation a hired child inherited, whose prefix stays intact. */
export function turnInputStart(messages: ReadonlyArray<ModelMessage>): number {
  return messages.at(-1)?.role === 'user' ? messages.length - 1 : messages.length;
}

/** The turn-local messages and the un-woven index of the turn's input, which they ride right before. */
export interface TurnLocalPlacement {
  readonly at: number;
  readonly messages: readonly ModelMessage[];
  readonly firstStep?: boolean | undefined;
}

export function placeTurnLocal(messages: ReadonlyArray<ModelMessage>, placement: TurnLocalPlacement): ModelMessage[] {
  const at = Math.min(placement.at, messages.length);

  return [...messages.slice(0, at), ...placement.messages, ...messages.slice(at)];
}

interface LedgerBlock {
  /** Un-woven position at birth: before the turn's input at a turn's first step, the tail after that. The block
     *  renders there forever, except where that slot has since become a tool result ({@link insertionPoint}). */
  readonly index: number;
  readonly text: string;
  /** Chars/4 cost, priced once at birth for the step pruner and `dropSuperseded`. */
  readonly tokens: number;
  readonly message: ModelMessage;
}

/**
 * First legal insertion position at or after `index`: steps over consecutive
 * `tool` messages, since nothing may sit between a call and its results
 * (`AI_MissingToolResultsError`). A frozen index can land inside such a pair on
 * a later turn. `settleUnpairedToolCalls` cannot cover this: it runs at assembly.
 */
function insertionPoint(history: ReadonlyArray<ModelMessage>, index: number): number {
  let at = index;

  while (history[at]?.role === 'tool') at += 1;

  return at;
}

/**
 * Per-activation ledger of dynamic-context blocks. `weave` adds a block only
 * when the render changed and re-inserts every frozen block at its position.
 * `history` must never include this ledger's blocks or the turn-local messages,
 * so positions stay those of durable history. Call `reset()` whenever the
 * durable stream is rewritten (compaction).
 */
export class DynamicContextLedger {
  private blocks: LedgerBlock[] = [];
  private currentState: Readonly<DynamicContext> | null = null;

  get size(): number {
    return this.blocks.length;
  }

  /** Chars/4 overhead of frozen blocks, reserved by the step pruner (pruning runs before the weave). */
  get overheadTokens(): number {
    let tokens = 0;

    for (const block of this.blocks) tokens += block.tokens;

    return tokens;
  }

  /**
   * Collapse the base and its deltas into one fresh full block at the newest
   * position; the only removal of frozen blocks. Breaks the prefix cache, so only
   * a caller already over the ladder's trigger may call it. Returns tokens freed
   * (chars/4).
   */
  dropSuperseded(): number {
    if (this.blocks.length <= 1) return 0;
    const newest = this.blocks.at(-1);

    if (newest === undefined || this.currentState === null) return 0;
    const before = this.overheadTokens;
    const full = renderDynamicContextBlock(this.currentState);
    this.blocks = full === null ? [] : [this.block(newest.index, full)];

    return before - this.overheadTokens;
  }

  /** `turnLocal` rides right before the turn's input, after any block born there. */
  weave(history: ReadonlyArray<ModelMessage>, state: DynamicContext, turnLocal?: TurnLocalPlacement): ModelMessage[] {
    let previousIndex = -1;

    for (const block of this.blocks) {
      // History rewrites invalidate frozen positions even when their caller forgot to reset the ledger.
      if (block.index > history.length || block.index < previousIndex) {
        this.reset();
        break;
      }

      previousIndex = block.index;
    }

    const current = Object.freeze(structuredClone(state));
    const previous = this.currentState;
    const full = renderDynamicContextBlock(current);
    const previousFull = previous === null ? null : renderDynamicContextBlock(previous);

    if (full !== previousFull) {
      const text = this.blocks.length === 0 ? full : dynamicDelta(previous ?? {}, current);
      const birth = turnLocal?.firstStep === true ? Math.min(turnLocal.at, history.length) : turnInputStart(history);

      if (text !== null) this.blocks.push(this.block(birth, text));
    }

    this.currentState = current;

    const woven: ModelMessage[] = [];
    const placeAt = turnLocal === undefined ? -1 : Math.min(turnLocal.at, history.length);
    let cursor = 0;
    let lead = 0;

    for (const block of this.blocks) {
      const at = insertionPoint(history, Math.max(block.index, cursor));
      woven.push(...history.slice(cursor, at), block.message);
      cursor = at;

      if (at <= placeAt) lead += 1;
    }

    woven.push(...history.slice(cursor));

    if (turnLocal !== undefined) woven.splice(placeAt + lead, 0, ...turnLocal.messages);

    return woven;
  }

  reset(): void {
    this.blocks = [];
    this.currentState = null;
  }

  private block(index: number, text: string): LedgerBlock {
    return Object.freeze({ index, text, tokens: Math.round(text.length / 4), message: Object.freeze({ role: 'user', content: text }) });
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
