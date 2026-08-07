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

import { streamText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { evidenceWindow } from '../prompts/evidence-window.js';
import type { ScaffoldRunOptions } from '../scaffold/executor.js';

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
      messages: call.messages.map((m) => ({
        role: m.role as 'system' | 'user' | 'assistant', content: m.content,
      })),
      tools: toolSet,
      stopWhen: stepCountIs(call.maxSteps ?? opts.defaultMaxSteps),
      ...(opts.streamOptions ?? {}),
    });
    for await (const chunk of result.textStream) yield chunk;
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

export interface ScaffoldHistoryQuery {
  /** Where the page starts. Negative counts back from the end, so -20 is "the
   *  last 20 messages" without first asking how many there are. Defaults to the
   *  tail: the recent end is what a turn is usually about. */
  offset?: number;
  limit?: number;
  /** Characters kept per message, head and tail. */
  maxChars?: number;
}

export interface ScaffoldHistoryEntry {
  /** Position in the durable history — stable enough to page from. */
  index: number;
  role: string;
  /** Length of the rendered message BEFORE budgeting, so the scaffold can see
   *  what it is not being shown and decide whether to go and get it. */
  chars: number;
  text: string;
  truncated: boolean;
}

export interface ScaffoldHistoryPage {
  /** Messages in the whole history, not in this page. */
  total: number;
  offset: number;
  entries: ScaffoldHistoryEntry[];
  /** The page ended early against SCAFFOLD_HISTORY_MAX_PAGE_CHARS. */
  clipped: boolean;
}

/** One message as text: prose verbatim, tool traffic named rather than dumped.
 *  A scaffold navigating its history needs to know a tool ran and roughly what
 *  it returned; the full result is a `workspace.readFile` away when it is
 *  spilled and a re-read away when it is not. */
function renderMessage(message: ModelMessage): string {
  const content: unknown = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((raw): string => {
    const part = raw as { type?: string; text?: unknown; toolName?: unknown; input?: unknown; output?: unknown };
    switch (part.type) {
      case 'text':
      case 'reasoning':
        return String(part.text ?? '');
      case 'tool-call':
        return `[tool-call ${String(part.toolName ?? '?')} ${safeJson(part.input)}]`;
      case 'tool-result':
        return `[tool-result ${String(part.toolName ?? '?')} ${safeJson(part.output)}]`;
      default:
        return `[${String(part.type ?? 'part')}]`;
    }
  }).filter(Boolean).join('\n');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return String(value);
  }
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
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
): NonNullable<ScaffoldRunOptions['history']> {
  return async (query: ScaffoldHistoryQuery = {}) => {
    const messages = source();
    const total = messages.length;
    const limit = clampInt(query.limit, SCAFFOLD_HISTORY_DEFAULT_LIMIT, 1, SCAFFOLD_HISTORY_MAX_LIMIT);
    const maxChars = clampInt(
      query.maxChars, SCAFFOLD_HISTORY_DEFAULT_MESSAGE_CHARS, 1, SCAFFOLD_HISTORY_MAX_MESSAGE_CHARS,
    );
    const requested = typeof query.offset === 'number' && Number.isFinite(query.offset)
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
    if (!t || typeof t.execute !== 'function') return { error: `tool not found: ${name}` };
    try {
      // `args as never` is the legitimate dynamic-dispatch escape: the tool is
      // selected by string name at runtime, so its input type is unknown here.
      // The options object IS statically known — typed precisely so a future
      // required ToolCallOptions field can't silently slip through.
      const options: Parameters<NonNullable<ToolSet[string]['execute']>>[1] = {
        messages: [], toolCallId: `scaffold-${Date.now()}`,
      };
      return await t.execute(args as never, options);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };
}
