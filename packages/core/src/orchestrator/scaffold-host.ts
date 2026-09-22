/** Host bridges (llmStream, callTool, history) an evolved scaffold uses from the codemode sandbox. */

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
  spec?: string;
  modelContext?: ChatOptions['modelContext'];
  /** Resolved per call so mid-turn rebuilds land. */
  tools: () => ToolSet;
  streamOptions?: Pick<ChatOptions, 'providerOptions' | 'onStep' | 'stopWhen'> & Pick<KinuExtension, 'prepareStep'>;
  /** Absent means the scaffold's spend is attributed to nothing. */
  spend?: ModelCallSpend;
}

export function createScaffoldLLMStream(opts: ScaffoldBridgeOpts): ScaffoldRunOptions['llmStream'] {
  return async function* (call) {
    assertScaffoldActive(opts);
    const all = opts.tools();

    const toolSet: ToolSet = call.tools && call.tools.length > 0
      ? Object.fromEntries(call.tools.filter(name => all[name]).map(name => [name, all[name]]))
      : all;

    yield* streamScaffoldChat(opts, { system: call.system, history: call.messages, tools: toolSet });
  };
}

export function createScaffoldDefaultInference(
  opts: ScaffoldBridgeOpts,
  frame: Pick<ChatOptions, 'system' | 'history' | 'modelContext'>,
): NonNullable<ScaffoldRunOptions['defaultInference']> {
  return async function* () {
    for await (const event of streamScaffoldChat(opts, { ...frame, tools: opts.tools() })) {
      if (event.type !== 'native-tool-output') yield { event };
    }
  };
}

async function* streamScaffoldChat(
  opts: ScaffoldBridgeOpts,
  frame: Pick<ChatOptions, 'system' | 'history' | 'tools' | 'modelContext'>,
): ReturnType<ScaffoldRunOptions['llmStream']> {
  assertScaffoldActive(opts);
  const spend = opts.spend;
  const operation = beginModelOperation(spend, 'stream', { spec: opts.spec });
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
      ...frame, model: opts.model, modelContext: opts.modelContext ?? frame.modelContext,
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

      if (event.type === 'done') {
        operation.completed({ usage, modelId });
        spend?.report({ source: spend.source, usage, modelId, spec: opts.spec });
      }

      yield event;
    }
  } catch (cause) {
    operation.failed({ cause });
    throw cause;
  } finally {
    operation.failed({ cause: opts.signal?.reason ?? new Error('Scaffold model stream closed before completion') });
  }
}

/** Page size, defaulted and capped: the scaffold pages rather than ingests. */
export const SCAFFOLD_HISTORY_DEFAULT_LIMIT = 20;

export const SCAFFOLD_HISTORY_MAX_LIMIT = 100;

export const SCAFFOLD_HISTORY_DEFAULT_MESSAGE_CHARS = 1_000;

export const SCAFFOLD_HISTORY_MAX_MESSAGE_CHARS = 8_000;

/** Page ceiling whatever the per-message budget allows. */
export const SCAFFOLD_HISTORY_MAX_PAGE_CHARS = 40_000;

/** Prose verbatim; tool traffic named rather than dumped. */
function renderMessage(message: ModelMessage): string {
  const content = message.content;

  if (!Array.isArray(content)) return content;

  return content.map((part): string => {
    switch (part.type) {
      case 'text':
      case 'reasoning':
        return part.text;
      case 'tool-call':
        return `[tool-call ${part.toolName} ${safeJson({ value: part.input })}]`;
      case 'tool-result':
        return `[tool-result ${part.toolName} ${safeJson({ value: part.output })}]`;

      case 'file':
      case 'image':
      case 'tool-approval-request':
      case 'tool-approval-response':
      default:
        return `[${part.type}]`;
    }
  }).filter(Boolean).join('\n');
}

function safeJson(input: { value: unknown }): string {
  try {
    return JSON.stringify(input.value) ?? 'null';
  } catch (error) {
    // `String()` on a cyclic object carries nothing; the reason replaces it.
    return `unserializable host history part: ${renderThrownChain({ cause: error })}`;
  }
}

/** `host.history`: read-only and budgeted by construction; every query is clamped. */
export function createScaffoldHistory(
  source: () => Promise<readonly ModelMessage[]>,
): ScaffoldHistoryReader {
  return async (query: ScaffoldHistoryQuery = {}) => {
    const messages = await source();
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
        // Against the budget: a window's omission marker can make `text` longer than `rendered`.
        truncated: rendered.length > maxChars,
      });
    }

    return { total, offset, entries, clipped } satisfies ScaffoldHistoryPage;
  };
}

export function createScaffoldCallTool(
  tools: () => ToolSet,
  /** Recoverable rollout identity; scoped ids `<scope>#<seq>` let the tool-effect claim dedupe a re-drive. */
  callScope?: string,
  signal?: AbortSignal,
  assertActive?: () => void,
): NonNullable<ScaffoldRunOptions['callTool']> {
  let seq = 0;
  // Scope-less ids must be unique: the counter separates calls, the nonce separates wrappers.
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
