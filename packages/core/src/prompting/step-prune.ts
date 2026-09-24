/**
 * Step-boundary tool-output pruning: the intra-turn context budget, run in
 * composePrepareStep. Over budget, old tool-result outputs shrink to a head
 * snippet plus a truncation marker; recent results stay verbatim.
 *
 * Invariants:
 *  - messages are never removed or reordered (injection indices, ledger
 *    positions and call/result pairing depend on it); only result content shrinks;
 *  - deterministic and idempotent: truncation is a pure function of content, and
 *    truncated output is under the threshold;
 *  - batched: the SDK rebuilds each step from the original history, so the
 *    boundary is quantized to {@link stepPruneBatchTokens} to hold still between
 *    batches and keep requests cache-extensions of one another.
 */

import type { AssistantModelMessage, ModelMessage, ToolModelMessage, ToolResultPart } from 'ai';
import { renderThrownChain } from '../obs/index';
import { StableCopies } from './stable-copies';

/**
 * `modelOutputLimit` is the catalog maximum only (no caller sets an output cap),
 * a share of `contextWindow`. `null` means unreported, which reserves nothing.
 */
export interface ModelWindow {
  readonly contextWindow: number;
  readonly modelOutputLimit: number | null;
}

/** `windowMeasured: false` marks a static-table stand-in. Budgets may spend it;
 * the refusal in orchestrator/turn-context.ts may not. */
export interface ResolvedModelWindow extends ModelWindow {
  readonly windowMeasured: boolean;
}

/**
 * Tokens held back for the answer: its reported maximum, bounded by half the
 * window (a published maximum can equal the whole window and admit no input).
 * An unreported maximum reserves nothing; the provider bounds the answer anyway.
 */
export function outputReserveTokens(limits: ModelWindow): number {
  if (limits.modelOutputLimit === null) return 0;
  const window = Math.max(0, Math.floor(limits.contextWindow));
  const answer = Math.max(0, Math.floor(limits.modelOutputLimit));

  return Math.min(answer, Math.floor(window / 2));
}

/**
 * Tokens one step's request may occupy: the one allocation every request-bound
 * producer divides. Exported so MCP catalog admission (`tools/mcp-surface.ts`)
 * subtracts from it instead of taking a second share.
 */
export function stepContextLimit(limits: ModelWindow): number {
  return Math.max(0, Math.floor(limits.contextWindow)) - outputReserveTokens(limits);
}

/** A quarter of the allocation per pass (a fixed count is a no-op on 1M and clears 32k); never zero. */
function stepPruneBatchTokens(limits: ModelWindow): number {
  return Math.max(1, Math.floor(stepContextLimit(limits) / 4));
}

const PRUNED_OUTPUT_HEAD_CHARS = 2_000;

export interface StepPruneBudget extends ModelWindow {
  /** Tokens added after this pass (the dynamic-context ledger weaves after pruning); without it the pass under-prunes. */
  reservedTokens?: number;
}

type AssistantPart = Exclude<AssistantModelMessage['content'], string>[number];

type ToolPart = ToolModelMessage['content'][number];

/**
 * Shrink old tool-result outputs when the step context is over budget. Returns
 * a new array (untouched messages keep identity), or `undefined`. The freed
 * amount is the overage rounded up to a whole {@link stepPruneBatchTokens}, so
 * the boundary stays put until the next batch line.
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

/** Oldest-first until `target` is met; the newest result is never a candidate. */
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

/** The copy's key: which parts `doomed` cuts; null for none. */
function cutOf(content: readonly (AssistantPart | ToolPart)[], doomed: ReadonlySet<ToolResultPart>): string | null {
  const cut = content.map((part) => part.type === 'tool-result' && doomed.has(part) ? '1' : '0').join('');

  return cut.includes('1') ? cut : null;
}

function prunedContent<Part extends AssistantPart | ToolPart>(
  content: readonly Part[], doomed: ReadonlySet<ToolResultPart>,
): (Part | ToolResultPart)[] {
  return content.map((part): Part | ToolResultPart => part.type === 'tool-result' && doomed.has(part) ? truncateResultPart(part) : part);
}

const pruned = new StableCopies();

function pruneMessage(message: ModelMessage, doomed: ReadonlySet<ToolResultPart>): ModelMessage {
  if (message.role === 'tool') {
    const { content } = message;
    const cut = cutOf(content, doomed);

    return cut === null ? message : pruned.of(message, cut, () => ({ ...message, content: prunedContent(content, doomed) }));
  }

  if (message.role === 'assistant' && Array.isArray(message.content)) {
    const content = message.content;
    const cut = cutOf(content, doomed);

    return cut === null ? message : pruned.of(message, cut, () => ({ ...message, content: prunedContent(content, doomed) }));
  }

  return message;
}

/** Head snippet + marker, error-ness preserved; under-threshold parts pass through (idempotence). */
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

function serializeOutput(part: ToolResultPart): string | null {
  const output = part.output;

  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value;
    case 'json':
    case 'error-json':
      return safeStringify({ value: output.value });
    case 'content':
      return safeStringify({ value: output.value });
    case 'execution-denied':
      return null;
  }
}

function serializedOutputLength(part: ToolResultPart): number {
  return serializeOutput(part)?.length ?? 0;
}

/** Chars/4, the compaction engine's scale. Media is priced flat (providers charge by dimensions). */
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
          chars += part.toolName.length + jsonLength({ value: part.input });
          break;
        case 'tool-result':
          chars += serializedOutputLength(part);
          break;
        case 'image':
        case 'file':
          chars += ESTIMATED_MEDIA_CHARS;
          break;

        case 'tool-approval-request':
        case 'tool-approval-response':
        default:
          chars += jsonLength({ value: part });
      }
    }
  }

  return Math.max(0, Math.round(chars / 4));
}

function safeStringify(input: { value: unknown }): string {
  try {
    return JSON.stringify(input.value, binaryReplacer) ?? '';
  } catch (error) {
    return `unserializable step part: ${renderThrownChain({ cause: error })}`;
  }
}

function jsonLength(input: { value: unknown }): number {
  return safeStringify(input).length;
}

/** Binary payloads flatten to a size placeholder rather than serializing to measure. */
function binaryReplacer<Value>(_key: string, value: Value): Value | string {
  if (value instanceof Uint8Array) return `[binary ${value.byteLength} bytes]`;

  if (value instanceof ArrayBuffer) return `[binary ${value.byteLength} bytes]`;

  return value;
}
