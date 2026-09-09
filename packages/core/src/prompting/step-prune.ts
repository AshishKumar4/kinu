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
 *  - deterministic: the truncated form is a pure function of the part's
 *    content, so a part truncated at step N re-truncates to identical bytes at
 *    step N+1;
 *  - BATCHED, which is what makes those identical bytes worth anything. The
 *    SDK rebuilds every step's array from the ORIGINAL history, so this pass
 *    never sees its own previous output and the total it measures grows for
 *    the whole turn. A pass therefore has to decide the boundary afresh each
 *    step, and a boundary that moved by one result per step re-prefilled
 *    everything after it: measured against a Sonnet window (200k/64k → 136k)
 *    with 24k-char results, the pass first fired at step 22 and then fired on
 *    all 18 remaining steps, rewriting 72-77% of every request while a cache
 *    write costs ~12x a cache read. The boundary is quantized to
 *    {@link stepPruneBatchTokens} instead, so it holds still until a whole
 *    batch of new output has arrived and the requests in between are pure
 *    extensions of one another;
 *  - idempotent: an already-truncated output is under the size threshold and
 *    is never re-truncated.
 */

import type { AssistantModelMessage, ModelMessage, ToolModelMessage, ToolResultPart } from 'ai';
import { renderThrownChain } from '../obs/index';

/**
 * The window one request occupies, and how much of it the answer may take.
 *
 * `modelOutputLimit` is the resolved model's catalog maximum
 * (ModelCatalogSession.modelOutputLimit), and only ever that. No caller
 * configures a per-call output cap — a reasoning model spends its budget
 * thinking before it emits anything, so `llm.ts` sets none and a gate keeps
 * the SDK's cap option out of every production source
 * (cf-backend/tests/unit-turn-pipeline-correctness.test.ts, "no production
 * source names an output-token cap"). It is a SHARE of `contextWindow`, not
 * capacity beside it: a chat model's window holds the instruction and the
 * answer together.
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
 * catalog (`tools/mcp-surface.ts`, applied by both backends) subtracts the
 * actor's own tool surface from THIS number rather than taking a second share
 * of the window, so one allocation exists and moving it moves both.
 */
export function stepContextLimit(limits: ModelWindow): number {
  return Math.max(0, Math.floor(limits.contextWindow)) - outputReserveTokens(limits);
}

/**
 * The quantum a pass frees, and therefore how much new tool output has to
 * arrive before the next pass moves the boundary again.
 *
 * A SHARE of the allocation rather than a token count: a fixed number is a
 * no-op against a 1M window and clears the whole array on a 32k one. A
 * quarter leaves the request within one quarter of its allocation after a
 * pass — so three quarters of the window is still verbatim recent output,
 * more than the fixed 40k window this replaced ever protected — and buys a
 * quarter of the window's worth of steps before the boundary has to move.
 *
 * Never zero: a window too small to batch still frees something rather than
 * looping over a target it can never meet.
 */
export function stepPruneBatchTokens(limits: ModelWindow): number {
  return Math.max(1, Math.floor(stepContextLimit(limits) / 4));
}

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
 *
 * The amount freed is the overage rounded UP to a whole
 * {@link stepPruneBatchTokens}. That rounding is the whole point: the overage
 * grows by one tool result per step, so a pass that freed exactly the overage
 * would move the boundary — and re-prefill everything after it — on every
 * step of the turn. Rounded, the target is constant until the overage crosses
 * the next batch line, so the same results are truncated to the same bytes
 * and each request in between is a literal extension of the last.
 */
export function pruneStepToolOutputs(
  messages: readonly ModelMessage[],
  budget: StepPruneBudget,
): ModelMessage[] | undefined {
  const limit = stepContextLimit(budget);
  if (limit <= 0) return undefined;

  let total = budget.reservedTokens ?? 0;
  for (const message of messages) total += estimateMessageTokens(message);
  const over = total - limit;
  if (over <= 0) return undefined;

  const batch = stepPruneBatchTokens(budget);
  const target = Math.ceil(over / batch) * batch;
  const doomed = resultsToTruncate(messages, target);
  if (doomed.size === 0) return undefined;
  let changed = false;
  const next = messages.map((message) => {
    const rebuilt = pruneMessage(message, doomed);
    if (rebuilt !== message) changed = true;
    return rebuilt;
  });
  return changed ? next : undefined;
}

/**
 * The OLDEST tool-result parts whose truncation frees `target` tokens, by
 * reference identity.
 *
 * Oldest-first because the newest results are what the model just read, and
 * the walk stops the moment the target is met — so what stays verbatim is the
 * recent tail, without a from-the-tail window that would slide as the array
 * grows. The newest result is never a candidate: a turn must always be able
 * to see the output of the call it just made, whatever the target asks for.
 */
function resultsToTruncate(messages: readonly ModelMessage[], target: number): Set<ToolResultPart> {
  const candidates: ToolResultPart[] = [];
  for (const message of messages) candidates.push(...toolResultPartsOf(message));
  candidates.pop();
  const doomed = new Set<ToolResultPart>();
  let freed = 0;
  for (const part of candidates) {
    if (freed >= target) break;
    const before = serializedOutputLength(part);
    const truncated = truncateResultPart(part);
    if (truncated === part) continue;
    doomed.add(part);
    freed += Math.max(0, Math.round((before - serializedOutputLength(truncated)) / 4));
  }
  return doomed;
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

/** Replace exactly the parts the walk chose, in place. Everything else keeps
 *  its object identity, so an untouched message is the same reference. */
function pruneMessage(message: ModelMessage, doomed: ReadonlySet<ToolResultPart>): ModelMessage {
  if (message.role === 'tool') {
    let changed = false;
    const content = message.content.map((part): ToolPart => {
      if (part.type !== 'tool-result' || !doomed.has(part)) return part;
      const truncated = truncateResultPart(part);
      if (truncated !== part) changed = true;
      return truncated;
    });
    return changed ? { ...message, content } : message;
  }
  if (message.role === 'assistant' && Array.isArray(message.content)) {
    let changed = false;
    const content = message.content.map((part): AssistantPart => {
      if (part.type !== 'tool-result' || !doomed.has(part)) return part;
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
  if (serialized.includes('…[truncated:')) return part;
  const marker = `…[truncated: full output was ${serialized.length} chars; re-run the tool if needed]`;
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
