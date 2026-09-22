import type { JsonValue, LLM } from '@kinu.run/core';
import type { ToolExecutionOptions } from 'ai';
import * as v from 'valibot';

/** A scripted LLM returning the next of `responses` per call; records prompts. */
export interface ScriptedLLM extends LLM {
  /** The prompts the LLM has received, in order. */
  readonly prompts: ReadonlyArray<string>;
  readonly callCount: number;
}

export function createScriptedLLM(responses: string[]): ScriptedLLM {
  let i = 0;
  const prompts: string[] = [];

  function nextResponse(prompt: string): string {
    prompts.push(prompt);
    const out = responses[i++];

    if (out === undefined) {
      throw new Error(
        `ScriptedLLM out of responses (called ${i} times, only ${responses.length} scripted).`,
      );
    }

    return out;
  }

  return {
    prompts,
    get callCount() { return i; },
    async *stream(opts: { messages?: Array<{ content: string }>; system?: string }) {
      const prompt = (opts.messages ?? []).map(m => m.content).join('\n');
      yield nextResponse(prompt);
    },
    async complete(prompt: string): Promise<string> {
      return nextResponse(prompt);
    },
  };
}

/** An LLM that echoes the prompt. */
export function createEchoLLM(): LLM {
  return {
    async *stream() { yield ''; },
    async complete(prompt: string) { return prompt; },
  };
}

/** An LLM that returns canned JSON. */
export function createJSONLLM(payload: JsonValue): LLM {
  const stringPayload = v.safeParse(v.string(), payload);
  const json = stringPayload.success ? stringPayload.output : JSON.stringify(payload);

  return {
    async *stream() { yield json; },
    async complete() { return json; },
  };
}

/** The `execute` of a built tool, typed for a direct call; throws if not callable. */
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
