// Imports nothing beyond `ai/test`, so a workerd test project can host it.
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';

/** Model-contract types derived from `MockLanguageModelV3`, since `ai` does not re-export them. */
export type ModelStreamPart =
  Awaited<ReturnType<MockLanguageModelV3['doStream']>>['stream'] extends ReadableStream<infer Part>
    ? Part
    : never;

/** One scripted step's answer and input; annotate each branch so `finishReason` does not widen to `string`. */
export type ScriptedTurnResult = Awaited<ReturnType<MockLanguageModelV3['doGenerate']>>;

export type ScriptedTurnOptions = Parameters<MockLanguageModelV3['doGenerate']>[0];

/**
 * A fake model answering `doGenerate` and `doStream` from one script; agent turns stream via `runChat`,
 * so count `doStreamCalls`, not `doGenerateCalls`.
 */
export function scriptedTurnModel(config: {
  provider?: string;
  modelId?: string;
  doGenerate: (options: ScriptedTurnOptions) => PromiseLike<ScriptedTurnResult> | ScriptedTurnResult;
}): MockLanguageModelV3 {
  const { doGenerate } = config;

  return new MockLanguageModelV3({
    provider: config.provider ?? 'fake',
    modelId: config.modelId ?? 'fake-model',
    // Adapted: the mock requires a PromiseLike; scripts may answer synchronously.
    doGenerate: async (options) => doGenerate(options),
    doStream: async (options) => {
      const result = await doGenerate(options);
      const parts: ModelStreamPart[] = [{ type: 'stream-start', warnings: result.warnings }];
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

      return { stream: convertArrayToReadableStream(parts) };
    },
  });
}
