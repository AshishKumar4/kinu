import { Effect } from 'effect';
import { KinuError, settleSync } from '@kinu.run/core/obs';
import { renderIssuesUnquoted, type JsonValue, type RoutedLLM, type TemporaryAgentPort, type TemporaryRunRequest } from '@kinu.run/core';
import type { ToolExecutionOptions } from 'ai';
import * as v from 'valibot';

/** A scripted LLM returning the next of `responses` per call; records prompts. */
export interface ScriptedLLM extends RoutedLLM {
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
    async complete(prompt: string): Promise<string> {
      return nextResponse(prompt);
    },
    async object(prompt, schema) {
      return answeredAs(schema, nextResponse(prompt));
    },
  };
}

/**
 * A scripted answer read as a structured call reads one (`generateObjectReported`): through `schema`, and an answer off
 * it refused as wrong (`bad_input`).
 */
export function answeredAs<S extends v.GenericSchema>(schema: S, text: string): v.InferOutput<S> {
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), schema), text);

  return settleSync(parsed.success
    ? Effect.succeed(parsed.output)
    : Effect.fail(new KinuError('bad_input', 'the scripted model answered off its schema', { cause: new KinuError('bad_input', renderIssuesUnquoted(parsed.issues)) })));
}

/** An LLM that returns canned JSON. */
export function createJSONLLM(payload: JsonValue): RoutedLLM {
  const stringPayload = v.safeParse(v.string(), payload);
  const json = stringPayload.success ? stringPayload.output : JSON.stringify(payload);

  return {
    async complete() { return json; },
    async object(_prompt, schema) { return answeredAs(schema, json); },
  };
}

/** The `execute` of a built tool, typed for a direct call; throws if not callable. */
interface ExecutableTool<Args, Result> {
  execute?: (args: Args, options: ToolExecutionOptions<unknown>) => PromiseLike<Result> | Result;
}

const DEFAULT_TOOL_OPTIONS: ToolExecutionOptions<unknown> = {
  toolCallId: 'test-tool-call',
  messages: [],
  context: undefined,
};

export function toolExecute<Args, Result>(
  entry: ExecutableTool<Args, Result>,
): (args: Args, options?: ToolExecutionOptions<unknown>) => Promise<Result> {
  return settleSync(Effect.gen(function* () {
    const execute = entry.execute;

    if (!execute) {
      return yield* Effect.die(new Error('toolExecute: the tool has no execute (was it built with a different name?)'));
    }

    return async (args, options = DEFAULT_TOOL_OPTIONS) => {
      return await execute(args, options);
    };
  }));
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
