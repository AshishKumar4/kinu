/**
 * Step-boundary tool-output pruning — the intra-turn context budget.
 *
 * Turn-assembly compaction sees only the durable history; NOTHING bounded the
 * context ACROSS the steps of one agentic turn, so a long tool-heavy turn
 * re-pays its own growing tool traffic on every request (production-proven:
 * workspace-1a4e20's revival turn billed 1.5M uncached input tokens across 33
 * steps). This module runs inside the shared per-step pipeline
 * (composePrepareStep — both backends): once the estimated step context
 * crosses a budget derived from the model's context window, OLD tool-result
 * outputs shrink to a head snippet + an explicit truncation marker, while the
 * newest results keep a token budget untouched (better-compact's
 * RECENT_TOOL_RESULT_BUDGET philosophy — the model still sees what it just
 * read).
 *
 * Hard invariants:
 *  - messages are NEVER removed or reordered (step-injection indices, ledger
 *    positions, and tool-call/result pairing all depend on the count) — only
 *    tool-result part CONTENT shrinks, in place;
 *  - deterministic and byte-stable: the truncated form is a pure function of
 *    the part's content, and the protected set only ever moves forward as new
 *    results arrive, so a part that was truncated at step N re-truncates
 *    IDENTICALLY at step N+1 and later steps' prompt prefixes stay
 *    cache-stable;
 *  - idempotent: an already-truncated output is under the size threshold and
 *    is never re-truncated.
 */

import type { AssistantModelMessage, ModelMessage, ToolModelMessage, ToolResultPart } from 'ai';
import { renderThrownChain } from '../obs/index';

/**
 * The window one request occupies, and how much of it the answer may take.
 *
 * `modelOutputLimit` is the per-call configured output cap when the caller set
 * one — the same number the provider is sent (llm.ts) — and otherwise the
 * resolved model's catalog maximum (ModelCatalogSession.modelOutputLimit). It
 * is a SHARE of `contextWindow`, not capacity beside it: a chat model's window
 * holds the instruction and the answer together.
 */
export interface ModelWindow {
  readonly contextWindow: number;
  readonly modelOutputLimit: number;
}

/**
 * Tokens held back for the answer.
 *
 * The reservation is the answer's own declared maximum, bounded by half the
 * window. Half is not a tuned share: the instruction and the answer are the
 * only two claimants on one window, and with nothing favouring either, half is
 * the largest reservation that still guarantees the instruction equal room.
 *
 * The bound is load-bearing, not defensive. A published maximum can BE the
 * whole window — models.dev reports 262144/262144 for
 * moonshotai/kimi-k2.7-code and 500000/500000 for xai/grok-4.6 — and
 * subtracting one of those verbatim admits no input at all, which in this
 * module means `limit <= 0` and the pruning pass switching itself off. Maxima
 * below half are facts and are reserved in full: 128000 of 1000000 for
 * anthropic/claude-opus-4-7, 384000 of 1000000 for deepseek/deepseek-v4-pro.
 */
export function outputReserveTokens(limits: ModelWindow): number {
  const window = Math.max(0, Math.floor(limits.contextWindow));
  const answer = Math.max(0, Math.floor(limits.modelOutputLimit));
  return Math.min(answer, Math.floor(window / 2));
}

/**
 * How many tokens one step's request may occupy. This pass shrinks tool outputs
 * toward it, and it is the ONE allocation every other producer of request-bound
 * weight divides.
 *
 * Exported because tool DEFINITIONS are the part of a step's request this
 * module cannot see: they are not messages, they ride every step of the turn,
 * and for MCP a third party writes them. The admission that bounds a remote
 * catalog (cf-backend/src/user/mcp.ts) subtracts the actor's own tool surface
 * from THIS number rather than taking a second share of the window, so one
 * allocation exists and moving it moves both.
 */
export function stepContextLimit(limits: ModelWindow): number {
  return Math.max(0, Math.floor(limits.contextWindow)) - outputReserveTokens(limits);
}

/** Newest tool results kept untouched, by estimated token cost — mirrors the
 *  compaction ladder's RECENT_TOOL_RESULT_BUDGET_TOKENS. */
export const STEP_RECENT_TOOL_BUDGET_TOKENS = 40_000;

/** Head snippet kept from a pruned output. */
const PRUNED_OUTPUT_HEAD_CHARS = 2_000;

export interface StepPruneBudget extends ModelWindow {
  /**
   * Tokens the caller will add to `messages` AFTER this pass, and which the
   * request therefore carries even though they are not in the array being
   * measured.
   *
   * Today that is the dynamic-context ledger: the pipeline prunes before it
   * weaves (frozen block positions are coordinates in the pruned array —
   * prepare-step.ts step 3), so without this the pass prices a request smaller
   * than the one that gets sent and under-prunes by the ledger's whole size,
   * which on a long mission turn is the largest single thing it cannot see.
   */
  reservedTokens?: number;
}

type AssistantPart = Exclude<AssistantModelMessage['content'], string>[number];
type ToolPart = ToolModelMessage['content'][number];

/**
 * Shrink old tool-result outputs when the step context is over budget.
 * Returns a new array with replaced parts (untouched messages keep their
 * object identity), or `undefined` when under budget or nothing shrinkable.
 */
export function pruneStepToolOutputs(
  messages: readonly ModelMessage[],
  budget: StepPruneBudget,
): ModelMessage[] | undefined {
  const limit = stepContextLimit(budget);
  if (limit <= 0) return undefined;

  let total = budget.reservedTokens ?? 0;
  for (const message of messages) total += estimateMessageTokens(message);
  if (total <= limit) return undefined;

  const protectedResults = collectProtectedResults(messages);
  let changed = false;
  const next = messages.map((message) => {
    const rebuilt = pruneMessage(message, protectedResults);
    if (rebuilt !== message) changed = true;
    return rebuilt;
  });
  return changed ? next : undefined;
}

/** The newest tool-result parts whose cumulative estimated cost fits the
 *  recent-tool budget — these stay untouched so the model keeps verbatim
 *  access to what it just read. Reference identities, collected newest-first. */
function collectProtectedResults(messages: readonly ModelMessage[]): Set<ToolResultPart> {
  const protectedResults = new Set<ToolResultPart>();
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const part of toolResultPartsOf(messages[i]).reverse()) {
      const cost = Math.max(1, Math.round(serializedOutputLength(part) / 4));
      if (used >= STEP_RECENT_TOOL_BUDGET_TOKENS) return protectedResults;
      if (protectedResults.size > 0 && used + cost > STEP_RECENT_TOOL_BUDGET_TOKENS) return protectedResults;
      protectedResults.add(part);
      used += cost;
    }
  }
  return protectedResults;
}

function toolResultPartsOf(message: ModelMessage): ToolResultPart[] {
  if (message.role === 'tool') {
    return message.content.filter((part): part is ToolResultPart => part.type === 'tool-result');
  }
  if (message.role === 'assistant' && Array.isArray(message.content)) {
    // Provider-executed results ride inline in assistant content.
    return message.content.filter((part): part is ToolResultPart => part.type === 'tool-result');
  }
  return [];
}

function pruneMessage(message: ModelMessage, protectedResults: ReadonlySet<ToolResultPart>): ModelMessage {
  if (message.role === 'tool') {
    let changed = false;
    const content = message.content.map((part): ToolPart => {
      if (part.type !== 'tool-result' || protectedResults.has(part)) return part;
      const truncated = truncateResultPart(part);
      if (truncated !== part) changed = true;
      return truncated;
    });
    return changed ? { ...message, content } : message;
  }
  if (message.role === 'assistant' && Array.isArray(message.content)) {
    let changed = false;
    const content = message.content.map((part): AssistantPart => {
      if (part.type !== 'tool-result' || protectedResults.has(part)) return part;
      const truncated = truncateResultPart(part);
      if (truncated !== part) changed = true;
      return truncated;
    });
    return changed ? { ...message, content } : message;
  }
  return message;
}

/** Deterministic per-part truncation: head snippet + marker, error-ness
 *  preserved through the output type. Under-threshold parts (including
 *  already-truncated ones) pass through untouched — idempotence. */
function truncateResultPart(part: ToolResultPart): ToolResultPart {
  const serialized = serializeOutput(part);
  if (serialized === null) return part;
  const marker = `…[truncated: full output was ${serialized.length} chars — re-run the tool if needed]`;
  if (serialized.length <= PRUNED_OUTPUT_HEAD_CHARS + marker.length) return part;
  const value = serialized.slice(0, PRUNED_OUTPUT_HEAD_CHARS) + marker;
  const isError = part.output.type === 'error-text' || part.output.type === 'error-json';
  return { ...part, output: isError ? { type: 'error-text', value } : { type: 'text', value } };
}

/** The output's serialized form — what truncation slices and what the
 *  estimate prices. Null for shapes with nothing to shrink. */
function serializeOutput(part: ToolResultPart): string | null {
  const output = part.output;
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value;
    case 'json':
    case 'error-json':
      return safeStringify(output.value);
    case 'content':
      return safeStringify(output.value);
    case 'execution-denied':
      return null;
  }
}

function serializedOutputLength(part: ToolResultPart): number {
  return serializeOutput(part)?.length ?? 0;
}

/** Chars/4 over what the request serializes — the same estimation scale the
 *  compaction engine uses. Media parts are priced flat (providers charge by
 *  dimensions, not payload bytes). */
const ESTIMATED_MEDIA_CHARS = 4_800;

function estimateMessageTokens(message: ModelMessage): number {
  let chars = 0;
  if (!Array.isArray(message.content)) {
    chars = message.content.length;
  } else {
    for (const part of message.content) {
      switch (part.type) {
        case 'text':
        case 'reasoning':
          chars += part.text.length;
          break;
        case 'tool-call':
          chars += part.toolName.length + jsonLength(part.input);
          break;
        case 'tool-result':
          chars += serializedOutputLength(part);
          break;
        case 'image':
        case 'file':
          chars += ESTIMATED_MEDIA_CHARS;
          break;
        default:
          chars += jsonLength(part);
      }
    }
  }
  return Math.max(0, Math.round(chars / 4));
}

function safeStringify<Value>(value: Value): string {
  try {
    return JSON.stringify(value, binaryReplacer) ?? '';
  } catch (error) {
    return `unserializable step part: ${renderThrownChain({ cause: error })}`;
  }
}

function jsonLength<Value>(value: Value): number {
  return safeStringify(value).length;
}

/** Binary payloads flatten to a size placeholder — never serialize megabytes
 *  of bytes just to measure them. */
function binaryReplacer<Value>(_key: string, value: Value): Value | string {
  if (value instanceof Uint8Array) return `[binary ${value.byteLength} bytes]`;
  if (value instanceof ArrayBuffer) return `[binary ${value.byteLength} bytes]`;
  return value;
}
