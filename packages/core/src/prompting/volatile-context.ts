/**
 * The volatile half of the context split.
 *
 * `buildSystemPromptSync` is a byte-stable prefix: its bytes change only on
 * real agent events (soul edit, model switch, skill/tool surface change,
 * executor registration, AGENTS.md edit), so provider prefix caches survive
 * across turns. Everything that legitimately changes rides in the messages
 * array instead, split by nature:
 *
 * DYNAMIC CONTEXT (facts world model, MEMORY.md tail, execution-recovery
 * findings, live executor availability, the agent's own open task list,
 * running background work, the open delegate roster, decisions parked on the
 * user) — the DynamicContextLedger. At EVERY model step the
 * current state is rendered into one `<dynamic_context fingerprint="…">`
 * block; a new block is appended at the tail ONLY when that render differs
 * from the newest block's. Every block freezes at the position where it was
 * born and never moves, changes or disappears while the activation lives —
 * moving or removing a mid-array message would invalidate every provider
 * cache breakpoint after it. The resulting invariant: the context the agent
 * sees keeps the maximum common prefix across the steps of an activation,
 * until the caches expire or the DO/CLI resets. The ledger is in-memory
 * only, never persisted: a cold start (DO reset, new CLI session) begins
 * empty, so the next step carries exactly one fresh block.
 *
 * The one exception is `dropSuperseded`, the compaction ladder's first rung:
 * under measured context pressure the superseded blocks — stale by definition
 * and re-derivable from live state — are the cheapest thing in the request to
 * give up, cheaper than any tool output. It runs only when the ladder was
 * about to rewrite the prefix anyway, never on the ordinary path.
 *
 * Only genuinely state-derived facts belong in the block. Nothing clock-
 * derived (elapsed times, "running for 4m") may render: it would re-fingerprint
 * every step and append a block per request.
 *
 * TURN-LOCAL state (skill activation reasons — they vary with THIS user
 * message's keywords — and the one-turn device change notice) — one trailing
 * user message for this turn only, appended at turn assembly and never
 * fingerprinted (folding it in would defeat block stability).
 *
 * Both backends assemble through the same functions so the seam cannot
 * drift: the ledger rides the shared step pipeline (prompting/prepare-step.ts),
 * the turn-local tail rides the shared turn assembly
 * (orchestrator/turn-context.ts).
 */

import type { ModelMessage } from 'ai';
import { DYNAMIC_CONTEXT_OPEN_TAG } from './sections';
import { executorIsSelectable, type PromptExecutorInfo } from './surface';
import { EXECUTOR_CAPABILITIES } from '../execution/types';
import type { ActiveSkillSet, ActivationReason } from '../skills/types';

/** Detached work the agent started and has not collected yet — one row of the
 *  background-job registry (jobs/store.ts), never a second copy of it. */
export interface DynamicJob {
  readonly id: string;
  /** The producing tool surface — `think_heads`, `execute_tools`, … */
  readonly kind: string;
  readonly label: string | null;
}

/** One item of the agent's own task list, flattened for rendering: a subtask
 *  follows its parent and names it. One row of agent_tasks (tasks/store.ts). */
export interface DynamicTask {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  /** The task this is a subtask of, or null when it is a task itself. */
  readonly parentId: string | null;
}

/** An agent the agent has working for it right now: a spawned subordinate
 *  (parent roster) or a running search (heads journal). */
export interface DynamicDelegate {
  readonly kind: 'subordinate' | 'search';
  readonly name: string;
  /** Where it is — the roster status / head-run phase, as its own store words it. */
  readonly phase: string;
  /** What it is working on, when its store knows. */
  readonly task?: string | null;
}

/** A decision parked on the user. Live so the agent stops guessing whether a
 *  gated action is stuck on it or on the human. */
export interface DynamicApproval {
  readonly id: string;
  /** What kind of decision is waiting — 'device consent', … */
  readonly kind: string;
  readonly detail: string;
}

/** The live state of the system at one model step. Every field is read from
 *  its existing source of truth at render time; this type owns no state.
 *
 *  List fields are rendered most-relevant-first and capped, with an honest
 *  count of what was elided — callers order them, the renderer bounds them. */
export interface DynamicContext {
  /** Rendered recent-facts block (renderFactsBlock output). */
  factsBlock?: string;
  /** Bounded MEMORY.md tail (newest lessons/reflections). */
  memoryTail?: string;
  /** Execution-recovery findings, newest first (evolution/recovery.ts) — what
   *  the episode has PROVEN by execution so far. Re-read per step from the
   *  lessons ledger, which is what makes this the one knowledge plane that
   *  moves DURING a long turn: facts and the memory tail are frozen at turn
   *  assembly, a finding recorded at step 40 rides every step after it. */
  recoveries?: readonly string[];
  /** Live executor lifecycle — rendered as status labels only; the executor
   *  doctrine itself lives in the stable prefix. */
  executors?: readonly PromptExecutorInfo[];
  /** Background work still running (newest first). */
  jobs?: readonly DynamicJob[];
  /** The agent's own open task list, in write order, each task followed by its
   *  open subtasks. Settled items are omitted — they are read back with
   *  `tasks({action:'list'})`, and carrying them here would grow the block for
   *  the life of the workspace. */
  tasks?: readonly DynamicTask[];
  /** Subordinates and forked head runs still open (most recent first). */
  delegates?: readonly DynamicDelegate[];
  /** Approvals/consent waiting on the user (oldest first — the one that has
   *  been blocked longest matters most). */
  approvals?: readonly DynamicApproval[];
  /** Capabilities the agent was configured to have that are NOT on this
   *  turn's surface — an MCP server that missed its startup budget, say.
   *  Without this the tools are simply absent: the model plans as if a
   *  capability it was promised does not exist and cannot explain why. */
  missingCapabilities?: readonly MissingCapability[];
}

/** One promised capability that is not reachable this turn, and why. */
export interface MissingCapability {
  /** What is missing, in the words the user configured it under. */
  readonly source: string;
  /** Why it is not here — a timeout, a crash, an auth failure. */
  readonly reason: string;
}

/** The live search roster as delegates — the ONE mapping both backends apply to
 *  `HeadJournal.listLive()`, so a search reads the same on either. Typed
 *  structurally: how a run is journalled is not this layer's business.
 *
 *  The words are the SURFACE's words, because this block is the model reading
 *  its own live state and it can only act on what the tool surface calls
 *  things. `swarm-run.ts` records every configured search into this journal, so
 *  a row here IS a search — it rendered as `(fork)`, an action the ladder no
 *  longer has, over "heads", which the prompt calls nodes. */
export function searchDelegates(
  runs: ReadonlyArray<{ rootId: string; rationale: string; running: number; total: number }>,
): DynamicDelegate[] {
  return runs.map((run) => ({
    kind: 'search',
    name: run.rootId,
    phase: `${run.running} of ${run.total} nodes running`,
    task: run.rationale || null,
  }));
}

/** The nested task list as render rows: each task, then its subtasks. Flat
 *  because the cap below counts ROWS, which is what actually rides the
 *  request — and because both backends reach it through `agentDynamicContext`,
 *  so neither can flatten it its own way. */
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

/** Where a backend reads each plane of its live state. Typed structurally —
 *  how a backend journals a head run or registers a job is not this layer's
 *  business, only that it can be asked. */
export interface DynamicContextSources {
  /** The turn's rendered recent-facts block (renderFactsForTurn output). */
  readonly factsBlock: string | undefined;
  /** The turn's MEMORY.md tail — read once per turn, behind the only await in
   *  this plane, so the caller closes over it rather than re-reading per step. */
  readonly memoryTail: string | undefined;
  /** The injectable execution-recovery findings — listRecoveryFindings over
   *  the lessons ledger, synchronous like every other per-step SQL read here,
   *  so a finding recorded mid-turn is visible on the very next step. */
  readonly recoveryFindings: readonly string[];
  readonly executors: readonly PromptExecutorInfo[];
  readonly runningJobs: ReadonlyArray<{ id: string; kind: string; label: string | null }>;
  /** The open half of the agent's task list — TaskListStore.listOpen(). */
  readonly openTasks: ReadonlyArray<{
    id: string; title: string; status: string;
    subtasks: ReadonlyArray<{ id: string; title: string; status: string }>;
  }>;
  readonly liveHeadRuns: ReadonlyArray<{ rootId: string; rationale: string; running: number; total: number }>;
  readonly missingCapabilities: readonly MissingCapability[];
}

/**
 * The agent's live state for ONE model step, assembled the same way on every
 * backend.
 *
 * Which planes exist, and when a plane is omitted rather than rendered empty,
 * is the whole content of this function — and it is exactly what drifted while
 * each backend built the object itself: a plane added on one side simply did
 * not exist for the other agent, with nothing to say so. Nothing here is
 * clock-derived; a wall-clock field would re-fingerprint the block every
 * request and append one per step.
 */
export function agentDynamicContext(sources: DynamicContextSources): DynamicContext {
  const context: DynamicContext = {
    // Re-listed per step: a sandbox provisioned or a device connected mid-turn
    // flips availability, and the whole point of the block is to say so.
    executors: sources.executors,
    jobs: sources.runningJobs.map((job) => ({ id: job.id, kind: job.kind, label: job.label })),
    tasks: flattenTaskList(sources.openTasks),
    delegates: searchDelegates(sources.liveHeadRuns),
  };
  if (sources.factsBlock) context.factsBlock = sources.factsBlock;
  if (sources.memoryTail) context.memoryTail = sources.memoryTail;
  if (sources.recoveryFindings.length > 0) context.recoveries = sources.recoveryFindings;
  if (sources.missingCapabilities.length > 0) {
    context.missingCapabilities = sources.missingCapabilities;
  }
  return context;
}

/** State that only makes sense for THIS turn's user message. */
export interface TurnLocalContext {
  /** One-turn device change notice (deviceChangeNotice output). */
  deviceNotice?: string | null;
  /** Skills resolved active for this turn. Bodies render in the stable
   *  prefix; the per-turn activation reasons (keyword matches vary with the
   *  user message) render here. */
  activeSkills?: ActiveSkillSet;
}

export const DYNAMIC_CONTEXT_HEADER =
  'Live system state, maintained by the Proteus runtime — not conversation, and not written by the user. '
  + 'A later dynamic_context block supersedes every earlier one.';

export const TURN_CONTEXT_HEADER =
  '[Turn context — live state maintained by the Proteus runtime, not written by the user.]';

/** Live availability label for one executor. Volatile by nature (flips on
 *  device connect/disconnect and sandbox activation), so it renders in the
 *  dynamic-context block — never in the cacheable system prefix. */
export function executorAvailabilityLabel(exec: PromptExecutorInfo): string {
  if (exec.name === 'laptop') return exec.active || exec.status === 'active' ? 'connected' : 'available';
  if (exec.active || exec.status === 'active') return 'active';
  if (exec.status === 'idle' || exec.configured) return 'ready on demand';
  return 'available';
}

/**
 * The measured resource ceiling of an executor's environment, as a status
 * suffix — `(cpus=1 mem=2G)`.
 *
 * Volatile like the availability label (a container is provisioned mid-session,
 * a device connects), and load-bearing rather than decorative: inside a cgroup
 * `nproc` reports the HOST's cores, so a model that sizes `-j` from it forks
 * dozens of compilers into a 2GB cap. Rendered ONLY from limits the environment
 * actually declared — an executor whose environment sets no cap says nothing
 * rather than inviting a guess.
 */
function executorLimitsSuffix(exec: PromptExecutorInfo): string {
  const parts: string[] = [];
  const cpus = exec.resourceLimits?.cpus;
  const memBytes = exec.resourceLimits?.memBytes;
  if (cpus !== undefined) parts.push(`cpus=${cpus}`);
  if (memBytes !== undefined) parts.push(`mem=${formatBytes(memBytes)}`);
  return parts.length > 0 ? ` (${parts.join(' ')})` : '';
}

/**
 * What the environment declares it can run, as a status suffix.
 *
 * The `run` tool's own description tells the model that "available binaries and
 * process features are listed in this workspace provider's capabilities"
 * (tools/inline.ts). Until this rendered, that sentence pointed at a list the
 * model was never given: the field was declared on PromptExecutorInfo,
 * populated by the router, and read by nothing — so the model guessed, and a
 * clone into an environment without the headroom for it read as a mystery.
 *
 * Rendered in the canonical union order rather than the declared Set's own
 * iteration order: the workspace set is composed from a live session's
 * enumeration, and an ordering flip that means nothing must not re-fingerprint
 * this block.
 */
function executorCapabilitySuffix(exec: PromptExecutorInfo): string {
  const declared = new Set(exec.capabilities ?? []);
  const ordered = EXECUTOR_CAPABILITIES.filter((capability) => declared.has(capability));
  return ordered.length > 0 ? ` — runs: ${ordered.join(', ')}` : '';
}

/** The row's marker and the legend's subject are the same words by
 *  construction — a legend that stops naming what it explains explains
 *  nothing. */
const NOT_MEASURED_LABEL = 'not measured here';

/**
 * What the environment could not answer for, as a second status suffix.
 *
 * An unknown dropped from the declared set reads to the model exactly like one
 * measured absent, and the two must not look alike: the user's tunnelled machine
 * may have been attached FOR its GPU, which nothing on its PATH can establish,
 * and an unprobed machine has said nothing about python rather than denying it.
 * Rendered in the canonical union order for the same reason the declared set is.
 */
function executorUnmeasuredSuffix(exec: PromptExecutorInfo): string {
  const unmeasured = new Set(exec.unmeasuredCapabilities ?? []);
  const ordered = EXECUTOR_CAPABILITIES.filter((capability) => unmeasured.has(capability));
  return ordered.length > 0 ? ` — ${NOT_MEASURED_LABEL}: ${ordered.join(', ')}` : '';
}

/** Bytes as the unit a memory cap is usually written in. One decimal at most,
 *  and never a rounded-UP figure: a cap must not read as more than it is. */
function formatBytes(bytes: number): string {
  for (const [unit, scale] of [['G', 1024 ** 3], ['M', 1024 ** 2], ['K', 1024]] as const) {
    if (bytes >= scale) return `${trimZero(Math.floor((bytes / scale) * 10) / 10)}${unit}`;
  }
  return `${bytes}B`;
}

function trimZero(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function describeActivationReason(r: ActivationReason): string {
  switch (r.kind) {
    case 'explicit':      return `explicit /${r.matched_token}`;
    case 'keyword':       return `keyword "${r.matched_keyword}"`;
    case 'always_active': return `pinned via ${r.via}`;
  }
}

/** Per-list caps. The block rides every request of every step, so each roster
 *  states its head and an honest count of the tail rather than growing without
 *  bound. */
const MAX_JOBS = 8;
/** Rows, not tasks — a task and its subtasks each cost a line. Larger than the
 *  other rosters because this one is the agent's own plan: the rest are things
 *  it can re-read on demand, and a plan cut off at its fourth step stops being
 *  a plan. Anything past this is still in `tasks({action:'list'})`. */
const MAX_TASK_ROWS = 15;
const MAX_DELEGATES = 8;
const MAX_APPROVALS = 5;
const MAX_MISSING_CAPABILITIES = 8;
/** Render cap for recovery findings — the reader (listRecoveryFindings)
 *  already bounds what arrives to the same window; this is display policy
 *  like every other roster cap here. */
const MAX_RECOVERIES = 5;
/** A finding carries two bounded arg echoes (the failing call and the one
 *  that ran clean), so the one-line recognition budget above would cut the
 *  half that makes it usable. */
const RECOVERY_ENTRY_CHARS = 480;
/** Free text from a store (job labels, delegate tasks, gated commands) is one
 *  line at most — the model needs to recognize the item, not re-read it. */
const ENTRY_CHARS = 120;

function clip(text: string, max = ENTRY_CHARS): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine;
}

/** One capped roster section: `title`, the first `cap` rendered rows, and an
 *  honest elision line when the caller had more. Null when it had none. */
function rosterSection<T>(
  title: string,
  items: readonly T[],
  cap: number,
  row: (item: T) => string,
): string | null {
  if (items.length === 0) return null;
  const lines = items.slice(0, cap).map(row);
  const elided = items.length - lines.length;
  if (elided > 0) lines.push(`- …and ${elided} more, not shown`);
  return [title, ...lines].join('\n');
}

/**
 * The ledger-fed dynamic-context block (or null when there is nothing to say).
 *
 * The `fingerprint` attribute digests the block BODY, so the model can tell at
 * a glance which of two blocks is a re-statement and which is a real change,
 * and a superseded block is visibly stale rather than silently wrong.
 */
export function renderDynamicContextBlock(ctx: DynamicContext): string | null {
  const sections: Array<string | null> = [];

  const facts = ctx.factsBlock?.trim();
  if (facts) sections.push(`## World model (facts you remembered)\n${facts}`);

  const memoryTail = ctx.memoryTail?.trim();
  if (memoryTail) sections.push(`## Memory (newest MEMORY.md lessons and reflections)\n${memoryTail}`);

  sections.push(rosterSection(
    '## Proven by execution (the runtime watched each of these calls keep failing until a CHANGED call ran clean — evidence about this environment, not a verdict on correctness)',
    ctx.recoveries ?? [], MAX_RECOVERIES,
    (finding) => `- ${clip(finding, RECOVERY_ENTRY_CHARS)}`,
  ));

  const executors = (ctx.executors ?? []).filter(executorIsSelectable);
  if (executors.length > 0) {
    const rows = executors.map((exec) =>
      `- ${exec.name}: ${executorAvailabilityLabel(exec)}${executorLimitsSuffix(exec)}`
      + `${executorCapabilitySuffix(exec)}${executorUnmeasuredSuffix(exec)}`);
    // The legend rides along only when a row actually carries an unknown, so
    // the common case pays nothing for it — and where it does appear, the model
    // needs telling that this is ignorance rather than a denial.
    const legend = rows.some((row) => row.includes(NOT_MEASURED_LABEL))
      ? [`("${NOT_MEASURED_LABEL}" is what nobody asked that environment — it may well work, `
        + 'so try it rather than ruling it out.)']
      : [];
    sections.push([
      '## Execution status',
      'Live availability for the runtimes described in the system prompt, and what each one declares it can run:',
      ...rows,
      ...legend,
    ].join('\n'));
  }

  sections.push(rosterSection(
    '## Your task list — what is still open (you keep this with the `tasks` tool)',
    ctx.tasks ?? [], MAX_TASK_ROWS,
    (task) => `${task.parentId ? '  - ' : '- '}${task.id} [${task.status}] ${clip(task.title)}`,
  ));

  sections.push(rosterSection(
    '## Background work still running (collect it before you finish)',
    ctx.jobs ?? [], MAX_JOBS,
    (job) => `- ${job.id} (${job.kind})${job.label ? `: ${clip(job.label)}` : ''}`,
  ));

  sections.push(rosterSection(
    '## Delegates working for you',
    ctx.delegates ?? [], MAX_DELEGATES,
    (d) => `- ${d.name} (${d.kind}) — ${clip(d.phase, 40)}${d.task ? `: ${clip(d.task)}` : ''}`,
  ));

  sections.push(rosterSection(
    '## Waiting on the user (not on you)',
    ctx.approvals ?? [], MAX_APPROVALS,
    (a) => `- ${clip(a.kind, 40)}: ${clip(a.detail)}`,
  ));

  sections.push(rosterSection(
    '## Configured but NOT available this turn — plan without these, and say so if asked',
    ctx.missingCapabilities ?? [], MAX_MISSING_CAPABILITIES,
    (m) => `- ${clip(m.source, 60)}: ${clip(m.reason)}`,
  ));

  const present = sections.filter((section): section is string => section !== null);
  if (present.length === 0) return null;
  const body = sealDelimiters([DYNAMIC_CONTEXT_HEADER, ...present].join('\n\n'));
  return `${DYNAMIC_CONTEXT_OPEN_TAG} fingerprint="${fnv1a64(body)}">\n${body}\n</dynamic_context>`;
}

/** The block's own delimiter, wherever it appears inside the block's body. */
const DELIMITER_IN_BODY = /<(\/?)dynamic_context/g;

/**
 * Neutralize the block's own delimiter inside its body.
 *
 * Every free-text plane in this block is authored by the model or by content
 * the model read: task titles, background-job labels sliced off a tool input,
 * search rationales, the gated command an approval is waiting on, and the
 * recovery ledger's verbatim echo of a previous call's ARGUMENTS. None of it is
 * escaped, deliberately — the model has to read markdown, paths and code
 * exactly as written, and an escaped body would be a worse lie than an
 * unescaped one.
 *
 * So the one thing that must not survive into the body is the delimiter itself.
 * A task titled `</dynamic_context>` would otherwise close the live-state
 * ledger and let whatever followed open a forged one — and this block is
 * precisely where the model reads which searches are running and which approvals
 * are the human's, so a forgeable boundary here is a forgeable claim about the
 * state of the system. Applied at the single point that wraps the body, so a
 * plane added later cannot forget it.
 */
function sealDelimiters(body: string): string {
  return body.replace(DELIMITER_IN_BODY, '&lt;$1dynamic_context');
}

/** The per-turn tail block (or null when there is nothing to say). */
export function renderTurnLocalContext(ctx: TurnLocalContext): string | null {
  const sections: string[] = [];

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

/** The turn-local context as one user message (or null). Callers hand it to
 *  the model for THIS turn only — never persisted into durable history, and
 *  appended AFTER the extension transformContext seam, so a compaction plugin
 *  never sees turn-local state. */
export function turnLocalContextMessage(ctx: TurnLocalContext): ModelMessage | null {
  const text = renderTurnLocalContext(ctx);
  return text ? { role: 'user', content: text } : null;
}

interface LedgerBlock {
  /** Message count of the un-woven array when the block was born — it renders
   *  after that many messages, forever (the cache-stability contract), except
   *  where that slot has since become a tool result ({@link insertionPoint}). */
  index: number;
  /** The rendered block text, which is also the append gate: a step whose
   *  render is byte-identical to this adds nothing. */
  text: string;
  /** What this block costs the request, on the compaction ladder's chars/4
   *  scale. Priced ONCE, here at birth: the step pruner reads the ledger's
   *  total on every model step and `dropSuperseded` reads a slice of it, so
   *  neither has to re-derive the scale, and there is one place that applies
   *  it. */
  tokens: number;
  message: ModelMessage;
}

/**
 * The first position at or after `index` at which a message may legally be
 * inserted — `index` itself in every case but one.
 *
 * A `tool` message answers the assistant message before it, and the AI SDK
 * refuses to build a prompt with anything in between: it throws
 * `AI_MissingToolResultsError` client-side, before a byte reaches the provider
 * (see prompting/interrupted-tool-calls.ts). A frozen block's index is a
 * coordinate in the array of the turn it was born in, so the slot it names can
 * since have grown into the middle of such a pair — the CLI's turn-start steer
 * puts the first block at index 2, and on the next turn index 2 is the tool
 * result answering the assistant message at index 1. Every consecutive `tool`
 * message is stepped over, not just one: a turn can answer several calls in
 * separate messages, and landing between two of those breaks the prompt exactly
 * as landing before the first one does.
 *
 * `settleUnpairedToolCalls` cannot cover this. It runs at turn assembly, the
 * weave runs per step afterwards, and a synthetic result here would claim a
 * call was interrupted when its real result is sitting one message away.
 */
function insertionPoint(history: ReadonlyArray<ModelMessage>, index: number): number {
  let at = index;
  while (history[at]?.role === 'tool') at += 1;
  return at;
}

/**
 * Per-activation ledger of dynamic-context blocks.
 *
 * `weave` is the whole interface, and the shared step pipeline calls it once
 * per model step: hand it the step's (un-woven) message array and the state
 * read at that instant. It appends a fresh block at the tail only when the
 * render differs from the newest block's, and returns the array with every
 * frozen block woven back in at its original position — an unchanged state
 * adds nothing, so the already-frozen block keeps conveying current state
 * from inside the cached prefix, and a changed one supersedes it at the tip
 * without disturbing a single byte before it.
 *
 * `history` must always be the array WITHOUT this ledger's blocks (the AI SDK
 * rebuilds every step from the original messages plus response messages, so a
 * woven array is never fed back in).
 *
 * In-memory only, never persisted: construct one per activation. Call
 * `reset()` whenever the durable stream is rewritten (compaction) — the
 * frozen positions are meaningless against the new stream, and the next
 * weave starts over with one fresh block at the tail.
 */
export class DynamicContextLedger {
  private blocks: LedgerBlock[] = [];

  get size(): number {
    return this.blocks.length;
  }

  /**
   * What the frozen blocks add to the next request, on the same chars/4 scale
   * the compaction ladder prices with.
   *
   * The step pruner reserves it: the pipeline prunes before it weaves, so this
   * is the part of the request the pruner would otherwise measure as absent —
   * and it is the part that GROWS, a block per state change for the life of
   * the activation. A step that appends a new block is still one block short
   * until the next step freezes it, which is the residual an ordering that
   * renders once per step can leave; the unbounded term is what this closes.
   */
  get overheadTokens(): number {
    let tokens = 0;
    for (const block of this.blocks) tokens += block.tokens;
    return tokens;
  }

  /**
   * Drop every superseded block, keeping the newest — the compaction ladder's
   * first rung, and the ONLY thing that ever removes a frozen block.
   *
   * A superseded block is stale by definition (the header tells the model so)
   * and fully re-derivable from live state, which makes it the cheapest thing
   * in the request to give up: cheaper than any tool output, and far cheaper
   * than a summary. The newest block stays because it is not history — it is
   * the live state the model reads.
   *
   * Removing a mid-array message is exactly what `weave` refuses to do, because
   * it breaks the provider's prefix cache. So this is a pressure-relief act and
   * nothing else: only a caller that has already measured the context over the
   * ladder's trigger may call it. Nothing else in the system ever bounds this
   * plane — a ladder stage cannot see it (blocks are woven per step and never
   * reach durable history) and a replayed compaction plan prices the prefix
   * with the overhead it recorded when it was built — so without this the
   * superseded blocks accumulate for the life of the activation.
   *
   * Returns the tokens freed, on the ladder's chars/4 scale, so the caller can
   * subtract them from the pressure it measured and let the rest of the ladder
   * stand down if this rung was enough.
   */
  dropSuperseded(): number {
    if (this.blocks.length <= 1) return 0;
    const superseded = this.blocks.slice(0, -1);
    this.blocks = this.blocks.slice(-1);
    let freed = 0;
    for (const block of superseded) freed += block.tokens;
    return freed;
  }

  weave(history: ReadonlyArray<ModelMessage>, state: DynamicContext): ModelMessage[] {
    let previousIndex = -1;
    for (const block of this.blocks) {
      // History rewrites invalidate frozen positions even when their caller forgot to reset the ledger.
      if (block.index > history.length || block.index < previousIndex) {
        this.reset();
        break;
      }
      previousIndex = block.index;
    }
    const text = renderDynamicContextBlock(state);
    // A null render appends nothing; frozen blocks stay regardless (removing
    // a mid-array message would break the provider prefix cache).
    if (text !== null && this.blocks[this.blocks.length - 1]?.text !== text) {
      this.blocks.push({
        index: history.length,
        text,
        tokens: Math.round(text.length / 4),
        message: { role: 'user', content: text },
      });
    }
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
  }
}

/** What this turn's system prompt did to the cacheable prefix. `first` is the
 *  session's opening turn, which has nothing to compare against. */
export interface SystemPromptObservation {
  readonly hash: string;
  readonly status: 'first' | 'stable' | 'changed';
}

/**
 * Fingerprint a turn's system prompt against the previous turn's.
 *
 * The prefix is supposed to be byte-stable across turns — that is what lets a
 * provider cache survive one — so `changed` is a claim about the agent, not
 * about the request: a soul edit, a model switch, a skill or tool surface
 * change. Anything else changing it is a cache-busting bug, and this is the
 * measurement that catches it. Backends differ only in where they report the
 * result, never in how it is derived.
 */
export function observeSystemPromptHash(
  previous: string | null,
  system: string,
): SystemPromptObservation {
  const hash = fnv1a64(system);
  return { hash, status: previous === null ? 'first' : previous === hash ? 'stable' : 'changed' };
}

/** FNV-1a 64-bit text hash — the shared fingerprint behind the cache-stability
 *  telemetry (system-prompt byte stability, the dynamic_context block's own
 *  attribute) AND the compaction engine's content-hash keys, which run over
 *  the FULL durable history every turn. Implemented
 *  with 16-bit limb multiplies instead of BigInt (~30x faster on megabyte
 *  inputs; the compaction plane made per-char BigInt a per-turn tax) —
 *  digests are byte-identical to the previous BigInt implementation.
 *  The FNV prime 0x100000001b3 = 2^40 + 0x1b3: each limb multiplies by
 *  0x1b3 (435), and the 2^40 term shifts limbs 0/1 into limbs 2/3 by
 *  8 bits. XOR input is the UTF-16 code unit (≤ 0xffff → low limb only). */
export function fnv1a64(text: string): string {
  // Offset basis 0xcbf29ce484222325 split into 16-bit limbs, low → high.
  let v0 = 0x2325, v1 = 0x8422, v2 = 0x9ce4, v3 = 0xcbf2;
  for (let i = 0; i < text.length; i++) {
    v0 ^= text.charCodeAt(i);
    let t0 = v0 * 0x1b3;
    let t1 = v1 * 0x1b3;
    let t2 = v2 * 0x1b3 + ((v0 << 8) & 0xffffff);
    let t3 = v3 * 0x1b3 + ((v1 << 8) & 0xffffff);
    t1 += t0 >>> 16;
    t2 += t1 >>> 16;
    t3 += t2 >>> 16;
    v0 = t0 & 0xffff;
    v1 = t1 & 0xffff;
    v2 = t2 & 0xffff;
    v3 = t3 & 0xffff;
  }
  return (
    v3.toString(16).padStart(4, '0') +
    v2.toString(16).padStart(4, '0') +
    v1.toString(16).padStart(4, '0') +
    v0.toString(16).padStart(4, '0')
  );
}

/** FNV-1a 64-bit over raw bytes — the attachment sanitizer's content address.
 *  Same limb math as {@link fnv1a64}, XORing the byte instead of the UTF-16
 *  code unit, so identical payload bytes hash identically no matter which
 *  carrier (data URL, base64 string, Uint8Array) delivered them. Kept as its
 *  own loop rather than a shared per-element callback: both hashes are
 *  hot paths over megabyte inputs. */
export function fnv1a64Bytes(data: Uint8Array): string {
  let v0 = 0x2325, v1 = 0x8422, v2 = 0x9ce4, v3 = 0xcbf2;
  for (let i = 0; i < data.length; i++) {
    v0 ^= data[i]!;
    const t0 = v0 * 0x1b3;
    let t1 = v1 * 0x1b3;
    let t2 = v2 * 0x1b3 + ((v0 << 8) & 0xffffff);
    let t3 = v3 * 0x1b3 + ((v1 << 8) & 0xffffff);
    t1 += t0 >>> 16;
    t2 += t1 >>> 16;
    t3 += t2 >>> 16;
    v0 = t0 & 0xffff;
    v1 = t1 & 0xffff;
    v2 = t2 & 0xffff;
    v3 = t3 & 0xffff;
  }
  return (
    v3.toString(16).padStart(4, '0') +
    v2.toString(16).padStart(4, '0') +
    v1.toString(16).padStart(4, '0') +
    v0.toString(16).padStart(4, '0')
  );
}
