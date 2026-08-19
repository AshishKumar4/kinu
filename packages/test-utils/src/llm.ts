// LLM fixtures — scripted responses without hitting an actual model.
import type { JsonValue, LLM } from '@proteus/core';
import type { ToolExecutionOptions } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import * as v from 'valibot';

/** A scripted LLM that returns the next answer in `responses` on each call.
 *  Tracks all prompts seen so tests can assert what was asked. */
export interface ScriptedLLM extends LLM {
  /** The prompts the LLM has received, in order. */
  readonly prompts: ReadonlyArray<string>;
  /** Index of the next response that will be returned (for diagnostics). */
  readonly callCount: number;
}

export function createScriptedLLM(responses: string[]): ScriptedLLM {
  let i = 0;
  const prompts: string[] = [];
  return {
    prompts,
    get callCount() { return i; },
    async *stream(opts: { messages?: Array<{ content: string }>; system?: string }) {
      const prompt = (opts.messages ?? []).map(m => m.content).join('\n');
      prompts.push(prompt);
      const out = responses[i++] ?? '';
      yield out;
    },
    async complete(prompt: string): Promise<string> {
      prompts.push(prompt);
      const out = responses[i++];
      if (out === undefined) {
        throw new Error(
          `ScriptedLLM out of responses (called ${i} times, only ${responses.length} scripted).`,
        );
      }
      return out;
    },
  };
}

/** An LLM that echoes back whatever was prompted — useful when the test
 *  doesn't care about content but does care that the LLM was invoked. */
export function createEchoLLM(): LLM {
  return {
    async *stream() { yield ''; },
    async complete(prompt: string) { return prompt; },
  };
}

/** An LLM that returns canned JSON, with retries on schema mismatch. Pair
 *  with structured-output tests (auto-judge, curriculum, sleep-time, eval). */
export function createJSONLLM(payload: JsonValue): LLM {
  const stringPayload = v.safeParse(v.string(), payload);
  const json = stringPayload.success ? stringPayload.output : JSON.stringify(payload);
  return {
    async *stream() { yield json; },
    async complete() { return json; },
  };
}

/**
 * The three halves of the model contract a suite has to name to fake one: the
 * stream-part union `doStream` yields, the result `doGenerate` returns, and the
 * call options both receive.
 *
 * `ai` re-exports the model contract but none of the types inside it, and the
 * package that declares them (`@ai-sdk/provider`) is a dependency of the one
 * backend that implements a provider — not of every suite that fakes a model. So
 * they are derived from `MockLanguageModelV3`, which is the class every suite
 * here already instantiates: one definition each, pinned to exactly the spec
 * version the fakes implement, and they follow a major bump with the class
 * instead of naming a `V2` it quietly retires. Derived from the wider
 * `LanguageModel` union they would each widen to V2-or-V3 and no hand-built part
 * would typecheck.
 */
export type ModelStreamPart =
  Awaited<ReturnType<MockLanguageModelV3['doStream']>>['stream'] extends ReadableStream<infer Part>
    ? Part
    : never;
type ModelGenerateResult = Awaited<ReturnType<MockLanguageModelV3['doGenerate']>>;
type ModelCallOptions = Parameters<MockLanguageModelV3['doGenerate']>[0];

/**
 * A fake model that answers BOTH ways from ONE script: `doGenerate` for a
 * one-shot completion, and `doStream` replayed from the same result.
 *
 * WHY IT EXISTS RATHER THAN A `MockLanguageModelV3` PER SUITE. Every agent turn
 * in this tree is issued by `runChat`, which STREAMS — an actor's, a fork's and
 * a swarm node's alike. A fake that implements only `doGenerate` therefore
 * throws the SDK's bare "Not implemented" the moment it is handed to an agent
 * instead of to a completion, and it throws it from inside the loop where the
 * head report turns it into `errored` and says nothing about the fixture. Nine
 * such fakes across six suites failed exactly that way the day the fork loop
 * stopped being a second caller of `generateText`. One factory means a fixture
 * cannot be written against the half of the provider interface production does
 * not use.
 *
 * The replay is the minimum a step needs and no more: the warnings, the ordered
 * content the script produced, and the terminal usage/finish reason. Text and
 * reasoning arrive as ONE delta each, because a fixture that cared about
 * chunking would be asserting the SDK's own splitting rather than the agent's
 * behaviour — the suites that DO care build their `doStream` by hand.
 *
 * It returns the mock itself, not a widened `LanguageModel`, so a suite keeps
 * `doStreamCalls` — and `doStreamCalls` is the one to count: an agent turn
 * streams, so `doGenerateCalls` stays EMPTY however many requests the turn made.
 * A fixture counting model calls off the wrong array would read zero and assert
 * nothing.
 */
export function scriptedTurnModel(config: {
  provider?: string;
  modelId?: string;
  doGenerate: (options: ModelCallOptions) => PromiseLike<ModelGenerateResult> | ModelGenerateResult;
}): MockLanguageModelV3 {
  const { doGenerate } = config;
  return new MockLanguageModelV3({
    provider: config.provider ?? 'fake',
    modelId: config.modelId ?? 'fake-model',
    // Adapted rather than passed through: the mock's own field requires a
    // PromiseLike, while a script that answers synchronously is a perfectly good
    // script and every suite here would otherwise have to say `async` for the
    // mock's benefit.
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

/**
 * The `execute` of a built tool, typed for a direct call.
 *
 * A `ToolSet` entry widens to a union TypeScript will not narrow to a callable
 * signature, so every suite that drives a tool without a model reached for its
 * own structural cast. This is the one place that does it, and it checks at
 * runtime that the thing really is callable rather than failing later inside
 * the call.
 */
interface ExecutableTool<Args, Result> {
  execute?: (args: Args, options: ToolExecutionOptions) => PromiseLike<Result> | Result;
}

const DEFAULT_TOOL_OPTIONS: ToolExecutionOptions = {
  toolCallId: 'test-tool-call',
  messages: [],
};

export function toolExecute<Args, Result>(
  entry: ExecutableTool<Args, Result>,
): (args: Args, options?: ToolExecutionOptions) => Promise<Result> {
  const execute = entry.execute;
  if (!execute) {
    throw new Error('toolExecute: the tool has no execute (was it built with a different name?)');
  }
  return async (args, options = DEFAULT_TOOL_OPTIONS) => {
    return await execute(args, options);
  };
}
