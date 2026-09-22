/**
 * A hand-rolled v2 model. `doStream` replays the `doGenerate` script instead of throwing: every turn goes through
 * `runChat`, which streams, and a throw would surface only as an unnamed `errored` head.
 */
import type { LanguageModelV2, LanguageModelV2StreamPart } from '@ai-sdk/provider';

type TestLanguageModelOptions = {
  provider?: string;
  modelId?: string;
  supportedUrls?: LanguageModelV2['supportedUrls'];
  doGenerate?: LanguageModelV2['doGenerate'];
  doStream?: LanguageModelV2['doStream'];
};

export class TestLanguageModelV2 implements LanguageModelV2 {
  readonly specificationVersion = 'v2';
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: LanguageModelV2['supportedUrls'];
  doGenerate: LanguageModelV2['doGenerate'];
  doStream: LanguageModelV2['doStream'];

  constructor({
    provider = 'test',
    modelId = 'test-model',
    supportedUrls = {},
    doGenerate = async () => { throw new Error('Test model does not implement doGenerate'); },
    doStream,
  }: TestLanguageModelOptions = {}) {
    this.provider = provider;
    this.modelId = modelId;
    this.supportedUrls = supportedUrls;
    this.doGenerate = doGenerate;
    this.doStream = doStream ?? (async (options) => {
      const result = await doGenerate(options);
      const parts: LanguageModelV2StreamPart[] = [{ type: 'stream-start', warnings: result.warnings }];
      let part = 0;

      for (const item of result.content) {
        const id = `p${String(part++)}`;

        if (item.type === 'text') {
          parts.push({ type: 'text-start', id });
          parts.push({ type: 'text-delta', id, delta: item.text });
          parts.push({ type: 'text-end', id });
        } else if (item.type === 'reasoning') {
          parts.push({ type: 'reasoning-start', id });
          parts.push({ type: 'reasoning-delta', id, delta: item.text });
          parts.push({ type: 'reasoning-end', id });
        } else if (item.type === 'tool-call') {
          parts.push(item);
        }
      }

      parts.push({ type: 'finish', finishReason: result.finishReason, usage: result.usage });

      return {
        stream: new ReadableStream<LanguageModelV2StreamPart>({
          start(controller) {
            for (const chunk of parts) controller.enqueue(chunk);
            controller.close();
          },
        }),
      };
    });
  }
}
