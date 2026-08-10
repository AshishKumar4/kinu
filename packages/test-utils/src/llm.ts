// LLM fixtures — scripted responses without hitting an actual model.
import type { LLM } from '@proteus/core';

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
export function createJSONLLM(payload: unknown): LLM {
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    async *stream() { yield json; },
    async complete() { return json; },
  };
}
