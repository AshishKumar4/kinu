/**
 * The volatile half of the per-turn context split.
 *
 * `buildSystemPromptSync` is a byte-stable prefix: its bytes change only on
 * real agent events (soul edit, model switch, skill/tool surface change,
 * executor registration, AGENTS.md edit), so provider prefix caches survive
 * across turns. Everything that legitimately changes turn-to-turn — the
 * recent-facts tail, live executor availability, the one-turn device change
 * notice, skill activation reasons — rides here instead: ONE context message
 * appended at the END of the turn's messages, where any changed byte costs a
 * few tail tokens instead of re-prefilling the whole conversation. The end
 * position doubles as recitation — current state sits where attention is
 * strongest.
 *
 * Both backends assemble this through the same functions so the seam cannot
 * drift: CF in `beforeTurn` (TurnConfig.messages), CLI in `processTurn`.
 */

import type { ModelMessage } from 'ai';
import { executorIsSelectable, type PromptExecutorInfo } from './surface.js';
import type { ActiveSkillSet, ActivationReason } from '../skills/types.js';

export interface VolatileTurnContext {
  /** Rendered recent-facts block (renderFactsBlock output). */
  factsBlock?: string;
  /** Bounded MEMORY.md tail (newest lessons/reflections). Per-turn-read live
   *  state, exactly like facts: every corroborated lesson / reflection /
   *  take-pick correction appends to MEMORY.md, so a stable-prefix placement
   *  would bust the cache on each write. */
  memoryTail?: string;
  /** Live executor lifecycle at turn start — rendered as status labels only;
   *  the executor doctrine itself lives in the stable prefix. */
  executors?: readonly PromptExecutorInfo[];
  /** One-turn device change notice (deviceChangeNotice output). */
  deviceNotice?: string | null;
  /** Skills resolved active for this turn. Bodies render in the stable
   *  prefix; the per-turn activation reasons (keyword matches vary with the
   *  user message) render here. */
  activeSkills?: ActiveSkillSet;
}

export const VOLATILE_CONTEXT_HEADER =
  '[Turn context — live state maintained by the Proteus runtime, not written by the user.]';

/** Live availability label for one executor. Volatile by nature (flips on
 *  device connect/disconnect and sandbox activation), so it renders in the
 *  per-turn context message — never in the cacheable system prefix. */
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

export function renderVolatileContext(ctx: VolatileTurnContext): string | null {
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
  return [VOLATILE_CONTEXT_HEADER, ...sections].join('\n\n');
}

/** Append the volatile context as one trailing user message. Returns a new
 *  array — callers pass it to the model for THIS turn only and never persist
 *  the appended message into durable history. */
export function appendVolatileContextMessage(
  messages: ReadonlyArray<ModelMessage>,
  ctx: VolatileTurnContext,
): ModelMessage[] {
  const text = renderVolatileContext(ctx);
  return text ? [...messages, { role: 'user', content: text }] : [...messages];
}

/** FNV-1a 64-bit hash of the assembled system prompt — the byte-stability
 *  invariant as telemetry. Backends log it per turn; it should change only
 *  on real agent events (soul/skill/craft/device/model), never between two
 *  vanilla consecutive turns. */
export function hashSystemPrompt(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}
