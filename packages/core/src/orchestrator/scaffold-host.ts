/**
 * The scaffold's host bridges — how an evolved scaffold reaches the model, the
 * agent's tool surface, and its own conversation from inside the codemode
 * sandbox. One implementation for both backends (each previously carried its
 * own copy):
 *
 *   createScaffoldLLMStream   host.llmStream — tool NAMES cross the sandbox
 *                             boundary; the host resolves them against the
 *                             live surface and runs a genuine multi-step loop.
 *   createScaffoldCallTool    host.callTool — dispatch into the live surface
 *                             by name; a throw becomes `{ error }` (the shape
 *                             buildHostProvider guarantees).
 *   createScaffoldHistory     host.history — a read-only, budgeted view of the
 *                             conversation the scaffold is the inference loop
 *                             for. Until this existed a scaffold received one
 *                             string (`task`) and a prepared default stream: it
 *                             could not see, let alone navigate, the context it
 *                             was supposed to be managing.
 */

import { safeValidateTypes } from '@ai-sdk/provider-utils';
import { streamText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { evidenceWindow } from '../prompts/evidence-window';
import type { ModelCallSpend } from '../events/model-call';
import { normalizeUsage } from '../usage';
import { decodeJsonValue } from '../utils/json';
import type {
  ScaffoldHistoryEntry,
  ScaffoldHistoryPage,
  ScaffoldHistoryQuery,
  ScaffoldHistoryReader,
  ScaffoldRunOptions,
} from '../scaffold/executor';

export type {
  ScaffoldHistoryEntry,
  ScaffoldHistoryPage,
  ScaffoldHistoryQuery,
  ScaffoldHistoryReader,
} from '../scaffold/executor';

export interface ScaffoldBridgeOpts {
  model: LanguageModel;
  /** The live tool surface, resolved per call so mid-turn rebuilds land. */
  tools: () => ToolSet;
  /** Step budget when the scaffold names none (cf: 50; cli: resolveMaxSteps). */
  defaultMaxSteps: number;
  /** Provider options for the scaffold's calls (cf spreads
   *  effortFor('scaffold_mutation')). `{}` when the backend adds none — safe
   *  to spread unconditionally. */
  streamOptions?: Pick<Parameters<typeof streamText>[0], 'providerOptions'>;
  /** Where this loop reports what it cost, and as whose spend — `scaffold` for a
   *  live or candidate scaffold driving its own inference. One field, both
   *  halves, like every other seam that hands its result to more than one kind of
   *  caller. It runs up to `defaultMaxSteps` model calls per invocation and none
   *  of them is a turn step, so before this it was the largest producer the panel
   *  could not see. Absent means a scaffold's spend is attributed to nothing. */
  spend?: ModelCallSpend;
}

export function createScaffoldLLMStream(opts: ScaffoldBridgeOpts): ScaffoldRunOptions['llmStream'] {
  return async function* (call) {
    const all = opts.tools();
    const toolSet: ToolSet = (call.tools && call.tools.length > 0)
      ? Object.fromEntries(call.tools.filter((n) => all[n]).map((n) => [n, all[n]]))
      : all;
    const result = streamText({
      model: opts.model,
      system: call.system,
      messages: call.messages,
      tools: toolSet,
      stopWhen: stepCountIs(call.maxSteps ?? opts.defaultMaxSteps),
      ...opts.streamOptions,
    });
    for await (const chunk of result.textStream) yield chunk;
    // After the drain, because that is when usage exists — and `totalUsage`
    // rather than `usage`, because this is a genuine multi-step loop and the
    // last step's report would omit every step before it. A caller that
    // abandons the generator mid-loop reports nothing, which is honest: this
    // seam never learns what an unfinished stream cost.
    const spend = opts.spend;
    if (spend) {
      spend.report({
        source: spend.source,
        usage: normalizeUsage(await result.totalUsage),
        modelId: (await result.response).modelId,
      });
    }
  };
}

/** Messages per page when the scaffold names no limit, and the ceiling it
 *  cannot exceed. A scaffold that wants the whole conversation pages for it,
 *  which is the point — navigation, not ingestion. */
export const SCAFFOLD_HISTORY_DEFAULT_LIMIT = 20;
export const SCAFFOLD_HISTORY_MAX_LIMIT = 100;
/** Characters of one message, defaulted and capped. */
export const SCAFFOLD_HISTORY_DEFAULT_MESSAGE_CHARS = 1_000;
export const SCAFFOLD_HISTORY_MAX_MESSAGE_CHARS = 8_000;
/** Ceiling on a whole page, whatever the per-message budget allows. Without it
 *  `{ limit: 100, maxChars: 8000 }` would hand 800k characters back across the
 *  sandbox boundary — a read surface that can flood the caller is not budgeted. */
export const SCAFFOLD_HISTORY_MAX_PAGE_CHARS = 40_000;

/** One message as text: prose verbatim, tool traffic named rather than dumped.
 *  A scaffold navigating its history needs to know a tool ran and roughly what
 *  it returned; the full result is a `workspace.readFile` away when it is
 *  spilled and a re-read away when it is not. */
function renderMessage(message: ModelMessage): string {
  const content = message.content;
  if (!Array.isArray(content)) return content;
  return content.map((part): string => {
    switch (part.type) {
      case 'text':
      case 'reasoning':
        return part.text;
      case 'tool-call':
        return `[tool-call ${part.toolName} ${safeJson(part.input)}]`;
      case 'tool-result':
        return `[tool-result ${part.toolName} ${safeJson(part.output)}]`;
      default:
        return `[${part.type}]`;
    }
  }).filter(Boolean).join('\n');
}

function safeJson<Value>(value: Value): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return String(value);
  }
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = value !== undefined && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * `host.history` — read-only, budgeted, and the same on both backends. The
 * source is whatever that backend calls the model-visible message list (the
 * CLI session's own array; the DO's prepared turn options), so the scaffold
 * reads exactly the stream it is the inference loop for.
 *
 * Read-only is structural: this returns plain data, and no writer is bridged.
 * Budgeted is structural too — every query is clamped, and a page stops at a
 * total-character ceiling regardless of what was asked for.
 */
export function createScaffoldHistory(
  source: () => readonly ModelMessage[],
): ScaffoldHistoryReader {
  return async (query: ScaffoldHistoryQuery = {}) => {
    const messages = source();
    const total = messages.length;
    const limit = clampInt(query.limit, SCAFFOLD_HISTORY_DEFAULT_LIMIT, 1, SCAFFOLD_HISTORY_MAX_LIMIT);
    const maxChars = clampInt(
      query.maxChars, SCAFFOLD_HISTORY_DEFAULT_MESSAGE_CHARS, 1, SCAFFOLD_HISTORY_MAX_MESSAGE_CHARS,
    );
    const requested = query.offset !== undefined && Number.isFinite(query.offset)
      ? Math.floor(query.offset)
      : total - limit;
    const offset = Math.min(total, Math.max(0, requested < 0 ? total + requested : requested));

    const entries: ScaffoldHistoryEntry[] = [];
    let spent = 0;
    let clipped = false;
    for (const message of messages.slice(offset, offset + limit)) {
      const rendered = renderMessage(message);
      const text = evidenceWindow(rendered, maxChars);
      if (spent + text.length > SCAFFOLD_HISTORY_MAX_PAGE_CHARS && entries.length > 0) {
        clipped = true;
        break;
      }
      spent += text.length;
      entries.push({
        index: offset + entries.length,
        role: message.role,
        chars: rendered.length,
        text,
        // Against the BUDGET, not against the rendered length: a window carries
        // an omission marker, so a message a little over budget comes back
        // longer than it started and `text.length < rendered.length` would call
        // it whole.
        truncated: rendered.length > maxChars,
      });
    }
    return { total, offset, entries, clipped } satisfies ScaffoldHistoryPage;
  };
}

export function createScaffoldCallTool(tools: () => ToolSet): NonNullable<ScaffoldRunOptions['callTool']> {
  return async (name, args) => {
    const t = tools()[name];
    if (!t?.execute) return { error: `tool not found: ${name}` };
    try {
      const options: Parameters<NonNullable<ToolSet[string]['execute']>>[1] = {
        messages: [], toolCallId: `scaffold-${Date.now()}`,
      };
      const input = await safeValidateTypes({ value: args, schema: t.inputSchema });
      if (!input.success) return { error: input.error.message };
      const result = await t.execute(input.value, options);
      return result === undefined ? undefined : decodeJsonValue({ value: result });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };
}
