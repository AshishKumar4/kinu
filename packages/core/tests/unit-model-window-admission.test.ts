// A turn is admitted, and compacted, against its own model's catalog window (m2072c, m2077c): GPT plan models were held
// to a 272k table while their rows allowed more, and a fallback was sized by the model that failed.
import { describe, expect, test } from 'bun:test';
import { APICallError, isStepCount, type ModelMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { ExtensionHost, runChat, type ChatEvent, type ChatFallback } from '../src/index';
import { ProviderPacer } from '../src/providers/pacing';

/** One text answer, streamed the way the SDK delivers it. */
function answered(): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(c) {
      c.enqueue({ type: 'stream-start', warnings: [] });
      c.enqueue({ type: 'text-start', id: 't1' });
      c.enqueue({ type: 'text-delta', id: 't1', delta: 'ok' });
      c.enqueue({ type: 'text-end', id: 't1' });
      c.enqueue({
        type: 'finish', finishReason: { unified: 'stop', raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
      });
      c.close();
    },
  });
}

/** A model that answers, counting the requests it was sent. */
function answering() {
  let calls = 0;

  const model = new MockLanguageModelV3({
    doStream: async () => {
      calls += 1;

      return { stream: answered(), response: { headers: {} } };
    },
  });

  return { model, calls: () => calls };
}

/** A model its account cannot reach: the turn hands over to the next. */
const unreachable = new MockLanguageModelV3({
  doStream: async () => { throw new APICallError({ message: 'Forbidden', url: 'https://api.openai.com/v1/responses', requestBodyValues: {}, statusCode: 403, isRetryable: false }); },
});

/** About 400,000 input tokens of history at the estimate's four characters a token: past 272k, within GPT-6.1 Sol's row. */
const LONG_HISTORY: ModelMessage[] = [
  { role: 'user', content: 'x'.repeat(1_600_000) },
  { role: 'assistant', content: 'read it' },
  { role: 'user', content: 'go on' },
];

/** GPT-6.1 Sol's window as its plan catalog row gives it (`max_context_window`), and the table it was once held to. */
const ROW_WINDOW = 1_050_000;

const OLD_TABLE_WINDOW = 272_000;

async function turn(input: { readonly contextWindow: number; readonly model: MockLanguageModelV3; readonly fallbacks?: readonly ChatFallback[]; readonly extensions?: ExtensionHost }) {
  const events: ChatEvent[] = [];
  let refused: string | null = null;

  try {
    for await (const event of runChat({
      modelSpec: 'chatgpt/gpt-6.1-sol', model: input.model, modelContext: { id: 'chatgpt/gpt-6.1-sol', contextWindow: input.contextWindow },
      fallbacks: input.fallbacks ?? [], pacer: new ProviderPacer(),
      system: 'sys', history: LONG_HISTORY, tools: {}, stopWhen: isStepCount(1), ...(input.extensions !== undefined && { extensions: input.extensions }),
    })) events.push(event);
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }

  return { events, refused };
}

describe('a long history is admitted against the window its model\'s catalog row gives', () => {
  test('past 272k, within the row: sent', async () => {
    const sol = answering();
    const { refused, events } = await turn({ contextWindow: ROW_WINDOW, model: sol.model });

    expect({ refused, calls: sol.calls() }).toEqual({ refused: null, calls: 1 });
    expect(events.find((event) => event.type === 'context-admitted')).toMatchObject({ contextWindow: ROW_WINDOW });
  });

  test('the same history under the 272k table: refused before anything is sent', async () => {
    const sol = answering();
    const { refused } = await turn({ contextWindow: OLD_TABLE_WINDOW, model: sol.model });

    expect({ refused: refused?.includes('above the') ?? false, calls: sol.calls() }).toEqual({ refused: true, calls: 0 });
  });
});

describe('a fallback is assembled against its own row\'s window, not the failed model\'s', () => {
  test('the compaction that sized the first request for Sol sizes the next one for the fallback', async () => {
    const windows: (number | null)[] = [];
    const backup = answering();

    const fallback: ChatFallback = {
      spec: 'openrouter/backup', accepts: new Set(), window: { contextWindow: OLD_TABLE_WINDOW, modelOutputLimit: null },
      bind: () => ({ model: backup.model, provider: 'openrouter' }),
    };

    // Records the window each assembly was compacted against, and changes nothing.
    const host = new ExtensionHost().register({
      name: 'window-recorder',
      transformContext: async ({ contextWindow }) => {
        windows.push(contextWindow);

        return undefined;
      },
    });

    const { refused } = await turn({ contextWindow: ROW_WINDOW, model: unreachable, fallbacks: [fallback], extensions: host });

    expect({ refused, backupCalls: backup.calls(), windows: [windows[0], windows.at(-1)] })
      .toEqual({ refused: null, backupCalls: 1, windows: [ROW_WINDOW, OLD_TABLE_WINDOW] });
  });
});
