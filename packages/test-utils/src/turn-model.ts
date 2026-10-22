// Imports nothing beyond `ai/test`, so a workerd test project can host it.
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';

/** Model-contract types derived from `MockLanguageModelV4`, since `ai` does not re-export them. */
export type ModelStreamPart =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer Part>
    ? Part
    : never;

/** One scripted step's answer and input; annotate each branch so `finishReason` does not widen to `string`. */
export type ScriptedTurnResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

export type ScriptedTurnOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];

/**
 * A fake model answering `doGenerate` and `doStream` from one script; agent turns stream via `runChat`,
 * so count `doStreamCalls`, not `doGenerateCalls`.
 */
export function scriptedTurnModel(config: {
  provider?: string;
  modelId?: string;
  doGenerate: (options: ScriptedTurnOptions) => PromiseLike<ScriptedTurnResult> | ScriptedTurnResult;
}): MockLanguageModelV4 {
  const { doGenerate } = config;

  return new MockLanguageModelV4({
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

/** What a scripted advisor says at its next review: one `advise` call's input. */
export interface ScriptedAdvice {
  readonly note: string;
  readonly severity: 'nit' | 'concern' | 'blocker';
  readonly class?: 'wrong-work' | 'missed-capability' | 'dissatisfaction';
}

/** An in-session advisor's model, as a session's `advisorLane` binds it: each review answers the advice queued for it,
 *  in order, then silence; every request it was sent is kept. */
export interface ScriptedAdvisor {
  readonly model: MockLanguageModelV4;
  /** Each review's request, as the advisor's model was sent it. */
  readonly asked: readonly string[];
  /** The next review says this. */
  advise(advice: ScriptedAdvice): void;
}

const ADVISOR_USAGE: ScriptedTurnResult['usage'] = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

export function scriptedAdvisor(): ScriptedAdvisor {
  const asked: string[] = [];
  const queued: ScriptedAdvice[] = [];

  const model = scriptedTurnModel({
    doGenerate: (options): ScriptedTurnResult => {
      asked.push(JSON.stringify(options.prompt));
      const advice = queued.shift();

      if (advice === undefined) return { content: [], finishReason: { unified: 'stop', raw: undefined }, usage: ADVISOR_USAGE, warnings: [] };

      return {
        content: [{ type: 'tool-call', toolCallId: `advise-${String(asked.length)}`, toolName: 'advise', input: JSON.stringify(advice) }],
        finishReason: { unified: 'tool-calls', raw: undefined }, usage: ADVISOR_USAGE, warnings: [],
      };
    },
  });

  return { model, asked, advise: (advice) => { queued.push(advice); } };
}
