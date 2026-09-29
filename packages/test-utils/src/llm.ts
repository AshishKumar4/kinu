import type { JsonValue, LLM, TemporaryAgentPort, TemporaryRunRequest } from '@kinu.run/core';
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

/** A hire port whose advisors answer when the test says so, as the ingress stores a helper's answer. */
export interface ScriptedAdvisorPort extends TemporaryAgentPort {
  /** Every brief an advisor was hired on, in order. */
  readonly tasks: readonly TemporaryRunRequest[];
  /** Every advisor still working answers `reply`. */
  answer(reply: string): void;
}

export function scriptedAdvisorPort(): ScriptedAdvisorPort {
  const tasks: TemporaryRunRequest[] = [];
  const lanes = new Map<string, NonNullable<ReturnType<TemporaryAgentPort['reclaim']>> & { readonly requestId: string }>();

  return {
    tasks,
    start: async (request) => {
      tasks.push(request);
      const name = `ask-advisor-${String(tasks.length)}`;

      if (request.lane !== undefined) lanes.set(name, { state: 'running', name, requestId: request.lane.requestId });

      return { status: 'working', agent: name, lifetime: 'task', role: request.roleLabel, answer: '', transcript: 'kept' };
    },
    release: () => {},
    reclaim: (lane) => [...lanes.values()].find((entry) => entry.requestId === lane.requestId) ?? null,
    answered: () => [...lanes.values()].flatMap((entry) => (entry.state === 'answered'
      ? [{ name: entry.name, lane: { requestId: entry.requestId }, status: entry.status, answer: entry.answer }] : [])),
    forget: (name) => { lanes.delete(name); },
    answer: (reply) => {
      for (const entry of lanes.values()) {
        if (entry.state === 'running') lanes.set(entry.name, { state: 'answered', name: entry.name, requestId: entry.requestId, status: 'completed', answer: reply });
      }
    },
  };
}
