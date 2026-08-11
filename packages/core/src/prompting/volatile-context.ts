/**
 * The volatile half of the context split.
 *
 * `buildSystemPromptSync` is a byte-stable prefix: its bytes change only on
 * real agent events (soul edit, model switch, skill/tool surface change,
 * executor registration, AGENTS.md edit), so provider prefix caches survive
 * across turns. Everything that legitimately changes rides in the messages
 * array instead, split by nature:
 *
 * DYNAMIC CONTEXT (facts world model, MEMORY.md tail, live executor
 * availability, running background work, the open delegate roster, decisions
 * parked on the user) — the DynamicContextLedger. At EVERY model step the
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
import { DYNAMIC_CONTEXT_OPEN_TAG } from './sections.js';
import { executorIsSelectable, type PromptExecutorInfo } from './surface.js';
import type { ActiveSkillSet, ActivationReason } from '../skills/types.js';

/** Detached work the agent started and has not collected yet — one row of the
 *  background-job registry (jobs/store.ts), never a second copy of it. */
export interface DynamicTask {
  readonly id: string;
  /** The producing tool surface — `think_heads`, `execute_tools`, … */
  readonly kind: string;
  readonly label: string | null;
}

/** An agent the agent has working for it right now: a spawned subordinate
 *  (parent roster) or a forked head run (heads journal). */
export interface DynamicDelegate {
  readonly kind: 'subordinate' | 'fork';
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
  /** Live executor lifecycle — rendered as status labels only; the executor
   *  doctrine itself lives in the stable prefix. */
  executors?: readonly PromptExecutorInfo[];
  /** Background work still running (newest first). */
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

/** The live fork roster as delegates — the ONE mapping both backends apply to
 *  `HeadJournal.listLive()`, so a fork reads the same on either. Typed
 *  structurally: how a head run is journalled is not this layer's business. */
export function forkDelegates(
  runs: ReadonlyArray<{ rootId: string; rationale: string; running: number; total: number }>,
): DynamicDelegate[] {
  return runs.map((run) => ({
    kind: 'fork',
    name: run.rootId,
    phase: `${run.running} of ${run.total} heads running`,
    task: run.rationale || null,
  }));
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
const MAX_TASKS = 8;
const MAX_DELEGATES = 8;
const MAX_APPROVALS = 5;
const MAX_MISSING_CAPABILITIES = 8;
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

  const executors = (ctx.executors ?? []).filter(executorIsSelectable);
  if (executors.length > 0) {
    sections.push([
      '## Execution status',
      'Live availability for the runtimes described in the system prompt:',
      ...executors.map((exec) =>
        `- ${exec.name}: ${executorAvailabilityLabel(exec)}${executorLimitsSuffix(exec)}`),
    ].join('\n'));
  }

  sections.push(rosterSection(
    '## Background work still running (collect it before you finish)',
    ctx.tasks ?? [], MAX_TASKS,
    (task) => `- ${task.id} (${task.kind})${task.label ? `: ${clip(task.label)}` : ''}`,
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
  const body = [DYNAMIC_CONTEXT_HEADER, ...present].join('\n\n');
  return `${DYNAMIC_CONTEXT_OPEN_TAG} fingerprint="${fnv1a64(body)}">\n${body}\n</dynamic_context>`;
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
   *  after that many messages, forever (the cache-stability contract). */
  index: number;
  /** The rendered block text, which is also the append gate: a step whose
   *  render is byte-identical to this adds nothing. */
  text: string;
  message: ModelMessage;
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
    return superseded.reduce((tokens, block) => tokens + Math.round(block.text.length / 4), 0);
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
      this.blocks.push({ index: history.length, text, message: { role: 'user', content: text } });
    }
    const woven: ModelMessage[] = [];
    let cursor = 0;
    for (const block of this.blocks) {
      woven.push(...history.slice(cursor, block.index), block.message);
      cursor = block.index;
    }
    woven.push(...history.slice(cursor));
    return woven;
  }

  reset(): void {
    this.blocks = [];
  }
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
