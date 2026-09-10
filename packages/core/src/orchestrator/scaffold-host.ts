/**
 * The scaffold's host bridges — how an evolved scaffold reaches the model, the
 * agent's tool surface, and its own conversation from inside the codemode
 * sandbox. One implementation for both backends:
 *
 *   createScaffoldLLMStream   host.llmStream — tool NAMES cross the sandbox
 *                             boundary; the host resolves them against the
 *                             live surface and runs a genuine multi-step loop.
 *   createScaffoldCallTool    host.callTool — dispatch into the live surface
 *                             by name; a throw becomes `{ error }` (the shape
 *                             buildHostProvider guarantees).
 *   createScaffoldHistory     host.history — a read-only, budgeted view of the
 *                             conversation the scaffold is the inference loop
 *                             for. Without it a scaffold has one string
 *                             (`task`) and a prepared default stream, and
 *                             cannot see, let alone navigate, the context it
 *                             is supposed to be managing.
 */

import { safeValidateTypes } from '@ai-sdk/provider-utils';
import type { LanguageModel, ModelMessage, ToolSet } from 'ai';
import { runChat, type ChatOptions } from '../chat';
import { ExtensionHost, type KinuExtension } from '../extension';
import { evidenceWindow } from '../prompts/evidence-window';
import { beginModelOperation, type ModelCallSpend } from '../events/model-call';
import { addUsage, type Usage } from '../usage';
import { decodeJsonValue } from '../utils/json';
import { boundedInt } from '../utils/bounds';
import { nanoid } from '../utils/nanoid';
import { renderThrownChain, KinuError } from '../obs/index';
import { assertScaffoldActive, type ScaffoldRunControl, type ScaffoldToolOutput } from '../scaffold/executor';
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

export interface ScaffoldBridgeOpts extends ScaffoldRunControl {
  model: LanguageModel;
  /** The live tool surface, resolved per call so mid-turn rebuilds land. */
  tools: () => ToolSet;
  /** Shared chat options and the existing pre-step extension hook. */
  streamOptions?: Pick<ChatOptions, 'providerOptions' | 'onStep' | 'stopWhen'> & Pick<KinuExtension, 'prepareStep'>;
  /** Where this loop reports what it cost, and as whose spend — `scaffold` for a
   *  live or candidate scaffold driving its own inference. One field, both
   *  halves, like every other seam that hands its result to more than one kind of
   *  caller, so a scaffold's spend is attributed to something. Absent means it is
   *  attributed to nothing. */
  spend?: ModelCallSpend;
}

export function createScaffoldLLMStream(opts: ScaffoldBridgeOpts): ScaffoldRunOptions['llmStream'] {
  return async function* (call) {
    assertScaffoldActive(opts);
    const all = opts.tools();

    const toolSet: ToolSet = call.tools && call.tools.length > 0
      ? Object.fromEntries(call.tools.filter(name => all[name]).map(name => [name, all[name]]))
      : all;

    const spend = opts.spend;
    const operation = beginModelOperation(spend, 'stream');
    let usage: Usage = {};
    let modelId: string | undefined;
    const outputs = new Map<string, ScaffoldToolOutput>();

    const extensions = new ExtensionHost().register({ name: 'kinu.scaffold-lifetime',
      prepareStep: async ctx => {
        assertScaffoldActive(opts);

        return opts.streamOptions?.prepareStep?.(ctx);
      },
    });

    try {
      for await (const event of runChat({
        model: opts.model, system: call.system, history: call.messages, tools: toolSet,
        signal: opts.signal, extensions,
        providerOptions: opts.streamOptions?.providerOptions,
        stopWhen: opts.streamOptions?.stopWhen,
        onToolOutput: part => {
          outputs.set(part.toolCallId, { type: 'tool-output-available', toolCallId: part.toolCallId,
            output: part.output, preliminary: part.preliminary });
        },
        onStep: async step => {
          modelId = step.response.modelId;
          await opts.streamOptions?.onStep?.(step);
        },
      })) {
        if (event.type === 'step-finish' && event.usage) usage = addUsage(usage, event.usage);

        if (event.type === 'tool-result') {
          const output = event.success ? outputs.get(event.toolCallId)
            : { type: 'tool-output-error', toolCallId: event.toolCallId, errorText: event.error ?? event.result } satisfies ScaffoldToolOutput;

          if (output === undefined) throw new KinuError('missing', 'the SDK tool output was not observed');
          outputs.delete(event.toolCallId);
          yield { type: 'native-tool-output', output };
        }

        yield event;
      }
    } catch (cause) {
      operation.failed({ cause });
      throw cause;
    }

    operation.completed({ usage, modelId });
    spend?.report({ source: spend.source, usage, modelId });
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
  } catch (error) {
    // The clamp precedent: `String()` on a cyclic object is "[object Object]" — the one
    // string that carries nothing at all — so the reason takes its place.
    return `unserializable host history part: ${renderThrownChain({ cause: error })}`;
  }
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
    const limit = boundedInt(query.limit, SCAFFOLD_HISTORY_DEFAULT_LIMIT, 1, SCAFFOLD_HISTORY_MAX_LIMIT);

    const maxChars = boundedInt(
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

export function createScaffoldCallTool(
  tools: () => ToolSet,
  /**
   * The RECOVERABLE identity this rollout runs under, when it has one.
   *
   * A queued shadow trial can be re-driven after an interruption, and its
   * candidate reaches the live tool surface — so a wall-clock call id gave every
   * replay fresh ids and the tool-effect claim could not tell a re-drive from a
   * first run. Scoped, the ids are `<scope>#0`, `<scope>#1` … in dispatch order,
   * which is what lets the claim dedupe them.
   *
   * Absent for a rollout with no durable identity (a live preview, a GEPA
   * candidate): nothing will re-drive those, so there is nothing to dedupe
   * against and inventing a scope would be a lie about recoverability.
   *
   * The ids line up only as far as the rollout is deterministic. A candidate
   * whose model answers differently makes different calls, and the claim then
   * sees genuinely different work — which is the honest reading, not a
   * mis-dedupe.
   */
  callScope?: string,
  signal?: AbortSignal,
  assertActive?: () => void,
): NonNullable<ScaffoldRunOptions['callTool']> {
  let seq = 0;
  // Scope-less rollouts have no durable identity to re-drive them, so their
  // ids only need to be unique — never reused. A wall-clock id was neither:
  // two calls inside one millisecond shared it, and the tool-effect claim
  // then replayed the first call's stored result for the second. The counter
  // keeps two calls on one wrapper apart; the nonce keeps two wrappers
  // apart. Scoped ids stay `<scope>#<seq>` so a re-drive still dedupes.
  const nonce = nanoid();
  const control = { signal, assertActive };

  return async (name, args) => {
    assertScaffoldActive(control);
    const t = tools()[name];

    if (!t?.execute) throw new KinuError('missing', `tool not found: ${name}`);

    const options: Parameters<NonNullable<ToolSet[string]['execute']>>[1] = {
      messages: [],
      toolCallId: callScope === undefined ? `scaffold-${nonce}#${seq++}` : `${callScope}#${seq++}`,
    };

    if (signal !== undefined) options.abortSignal = signal;
    const input = await safeValidateTypes({ value: args, schema: t.inputSchema });

    if (!input.success) throw new KinuError('bad_input', 'invalid scaffold tool arguments', { cause: input.error });
    assertScaffoldActive(control);
    const result = await t.execute(input.value, options);

    return result === undefined ? undefined : decodeJsonValue({ value: result });
  };
}
