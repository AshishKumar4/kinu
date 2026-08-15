// LLM fixtures — scripted responses without hitting an actual model.
import type { JsonValue, LLM } from '@proteus/core';
import type { LanguageModel, ToolExecutionOptions } from 'ai';
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
 * The stream-part union a provider's `doStream` yields.
 *
 * `ai` re-exports the model contract but not the part type inside it, and the
 * package that declares that type (`@ai-sdk/provider`) is a dependency of the
 * one backend that implements a provider — not of every suite that fakes a
 * model. So it is derived from the model contract itself: one definition, and
 * it follows the SDK's spec version automatically instead of naming a `V2` that
 * a major bump quietly retires.
 */
type StreamingLanguageModel = Extract<LanguageModel, { doStream: unknown }>;
export type ModelStreamPart =
  Awaited<ReturnType<StreamingLanguageModel['doStream']>>['stream'] extends ReadableStream<infer Part>
    ? Part
    : never;

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
