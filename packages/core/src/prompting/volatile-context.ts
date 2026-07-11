/**
 * The volatile half of the per-turn context split.
 *
 * `buildSystemPromptSync` is a byte-stable prefix: its bytes change only on
 * real agent events (soul edit, model switch, skill/tool surface change,
 * executor registration, AGENTS.md edit), so provider prefix caches survive
 * across turns. Everything that legitimately changes turn-to-turn rides in
 * the messages array instead, split by nature:
 *
 * SYSTEM STATE (facts world model, MEMORY.md tail, live executor
 * availability) — the EphemeralContextLedger. Each turn the current state is
 * rendered and fingerprinted; a new block is appended at the conversation
 * tail ONLY when the fingerprint differs from the newest block's. Every
 * block freezes at the durable-history position where it was born and never
 * moves or disappears while the activation lives — moving or removing a
 * mid-array message would invalidate every provider cache breakpoint after
 * it. The ledger is in-memory only, never persisted: a cold start (DO reset,
 * new CLI session) begins empty, so the next turn carries exactly one fresh
 * block.
 *
 * TURN-LOCAL state (skill activation reasons — they vary with THIS user
 * message's keywords — and the one-turn device change notice) — one trailing
 * user message for this turn only, appended after the ledger weave and never
 * fingerprinted (folding it in would defeat block stability).
 *
 * Both backends assemble through the same functions so the seam cannot
 * drift: CF in `beforeTurn` (TurnConfig.messages), CLI via runChat.
 */

import type { ModelMessage } from 'ai';
import { executorIsSelectable, type PromptExecutorInfo } from './surface.js';
import type { ActiveSkillSet, ActivationReason } from '../skills/types.js';

/** The fingerprint-stable "latest state of the system" — changes only on
 *  real events (fact learned, lesson recorded, executor lifecycle flip). */
export interface SystemStateContext {
  /** Rendered recent-facts block (renderFactsBlock output). */
  factsBlock?: string;
  /** Bounded MEMORY.md tail (newest lessons/reflections). */
  memoryTail?: string;
  /** Live executor lifecycle — rendered as status labels only; the executor
   *  doctrine itself lives in the stable prefix. */
  executors?: readonly PromptExecutorInfo[];
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

export const EPHEMERAL_CONTEXT_HEADER =
  '[Ephemeral context — latest system state, maintained by the Proteus runtime, not written by the user. ' +
  'The newest ephemeral context block supersedes all earlier ones.]';

export const TURN_CONTEXT_HEADER =
  '[Turn context — live state maintained by the Proteus runtime, not written by the user.]';

/** Live availability label for one executor. Volatile by nature (flips on
 *  device connect/disconnect and sandbox activation), so it renders in the
 *  ephemeral system-state block — never in the cacheable system prefix. */
export function executorAvailabilityLabel(exec: PromptExecutorInfo): string {
  if (exec.name === 'laptop') return exec.active || exec.status === 'active' ? 'connected' : 'available';
  if (exec.active || exec.status === 'active') return 'active';
  if (exec.status === 'idle' || exec.configured) return 'ready on demand';
  return 'available';
}

function describeActivationReason(r: ActivationReason): string {
  switch (r.kind) {
    case 'explicit':      return `explicit /${r.matched_token}`;
    case 'keyword':       return `keyword "${r.matched_keyword}"`;
    case 'always_active': return `pinned via ${r.via}`;
  }
}

/** The ledger-fed system-state block (or null when there is nothing to say). */
export function renderSystemStateBlock(ctx: SystemStateContext): string | null {
  const sections: string[] = [];

  const facts = ctx.factsBlock?.trim();
  if (facts) sections.push(`## World model (facts you remembered)\n${facts}`);

  const memoryTail = ctx.memoryTail?.trim();
  if (memoryTail) sections.push(`## Memory (newest MEMORY.md lessons and reflections)\n${memoryTail}`);

  const executors = (ctx.executors ?? []).filter(executorIsSelectable);
  if (executors.length > 0) {
    sections.push([
      '## Execution status',
      'Live availability for the runtimes described in the system prompt:',
      ...executors.map((exec) => `- ${exec.name}: ${executorAvailabilityLabel(exec)}`),
    ].join('\n'));
  }

  if (sections.length === 0) return null;
  return [EPHEMERAL_CONTEXT_HEADER, ...sections].join('\n\n');
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
 *  appended AFTER the extension transformContext seam and the ledger weave,
 *  so a compaction plugin never sees turn-local state. */
export function turnLocalContextMessage(ctx: TurnLocalContext): ModelMessage | null {
  const text = renderTurnLocalContext(ctx);
  return text ? { role: 'user', content: text } : null;
}

interface LedgerBlock {
  /** Durable-history length when the block was born — it renders after this
   *  many durable messages, forever (the cache-stability contract). */
  index: number;
  fingerprint: string;
  message: ModelMessage;
}

/**
 * Per-activation ledger of ephemeral system-state blocks.
 *
 * `weave` is the whole interface: hand it the (transformed) durable history
 * and the current system state each turn. It appends a fresh block at the
 * tail only when the state fingerprint differs from the newest block's, and
 * returns the history with every frozen block woven in at its original
 * position — an unchanged state adds nothing, so the already-frozen block
 * keeps conveying current state from inside the cached prefix.
 *
 * In-memory only, never persisted: construct one per activation. Call
 * `reset()` whenever the durable stream is rewritten (compaction) — the
 * frozen positions are meaningless against the new stream, and the next
 * weave starts over with one fresh block at the tail.
 */
export class EphemeralContextLedger {
  private blocks: LedgerBlock[] = [];

  get size(): number {
    return this.blocks.length;
  }

  weave(history: ReadonlyArray<ModelMessage>, state: SystemStateContext): ModelMessage[] {
    const text = renderSystemStateBlock(state);
    // A null render appends nothing; frozen blocks stay regardless (removing
    // a mid-array message would break the provider prefix cache).
    if (text !== null) {
      const fingerprint = fnv1a64(text);
      const newest = this.blocks[this.blocks.length - 1];
      if (newest?.fingerprint !== fingerprint) {
        this.blocks.push({ index: history.length, fingerprint, message: { role: 'user', content: text } });
      }
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

/** FNV-1a 64-bit text hash — the shared fingerprint behind both
 *  cache-stability invariants: the system-prompt byte-stability telemetry
 *  (backends log it per turn; it should change only on real agent events)
 *  and the ledger's append gate. */
export function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}
