/** The model a hire-recovery test and the process it kills share: a hire that reports, then makes one more call. */
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { REPORT_TOOL, type LLMProviderConfig } from '@kinu.run/core';
import { TestLanguageModelV2 } from './test-language-model';

export const PROBE_LLM: LLMProviderConfig = { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model' };

/** The hire's task, also quoted in the hirer's report notification. */
export const HIRE_DEATH_TASK = 'Summarise the ledger and report it.';

const USAGE = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

function streamOf(parts: readonly LanguageModelV2StreamPart[]): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

const answer = (text: string): LanguageModelV2StreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', delta: text },
  { type: 'text-end', id: '0' },
  { type: 'finish', finishReason: 'stop', usage: USAGE },
];

/** The hire's first call files its `completed` report; every other call answers at once. `childCalls` counts the hire's. */
export function hireDeathModel() {
  let childCalls = 0;

  const model = new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doGenerate: async () => ({ content: [{ type: 'text', text: 'acknowledged' }], finishReason: 'stop' as const, usage: USAGE, warnings: [] }),
    doStream: async (options) => {
      const prompt = JSON.stringify(options.prompt);

      const reportingChild = options.tools?.some((tool) => tool.name === REPORT_TOOL) === true;

      if (!reportingChild || !prompt.includes(HIRE_DEATH_TASK)) return { stream: streamOf(answer('acknowledged')), response: { headers: {} } };
      childCalls += 1;

      if (childCalls === 1) {
        return {
          stream: streamOf([
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: 'report-1', toolName: REPORT_TOOL, input: JSON.stringify({ status: 'completed', content: 'summarised' }) },
            { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
          ]),
          response: { headers: {} },
        };
      }

      return { stream: streamOf(answer('summarised')), response: { headers: {} } };
    },
  });

  return { model, childCalls: () => childCalls };
}
