/**
 * A hand-rolled v2 model for the suites that need the v2 spec specifically.
 *
 * `doStream` DEFAULTS TO A REPLAY of the same `doGenerate` script rather than to a
 * throw. Every agent turn in this tree is issued by `runChat`, which streams — an
 * actor's, a fork's and a swarm node's alike — so a fixture that scripts only
 * `doGenerate` would answer nothing at all and would say only "does not implement
 * doStream" from inside the loop, where a head report turns it into `errored` and
 * names nothing about the fixture. A script is a script; which method the loop
 * happens to call is not the fixture's business.
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
