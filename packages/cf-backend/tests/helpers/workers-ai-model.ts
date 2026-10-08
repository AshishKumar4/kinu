// The Workers AI model production builds over the deployment's binding, with a scripted `Ai.run` recording each call.
import { createWorkersAIProvider, type JsonObject, type WorkersAIRunBinding, type WorkersAIRunOptions } from '@kinu.run/core';
import type { LanguageModel } from 'ai';

/** Every shape workerd's `Ai.run` can return; a concurrent call decides which arrives. */
export type BindingAnswer = Response | ReadableStream<Uint8Array> | JsonObject;

export interface RecordedRun {
  readonly model: string;
  readonly inputs: JsonObject;
  readonly options: WorkersAIRunOptions | undefined;
}

export interface BindingModel {
  readonly model: LanguageModel;
  readonly runs: RecordedRun[];
}

export interface BindingModelOptions {
  readonly modelId?: string;
  readonly affinity?: string;
}

export function bindingModel(
  answer: (run: RecordedRun) => BindingAnswer | Promise<BindingAnswer>,
  { modelId = '@cf/moonshotai/kimi-k2.6', affinity = 'kinu-test' }: BindingModelOptions = {},
): BindingModel {
  const runs: RecordedRun[] = [];

  const fake: WorkersAIRunBinding = {
    run(model, inputs, options) {
      const recorded: RecordedRun = { model, inputs, options };
      runs.push(recorded);

      return Promise.resolve().then(() => answer(recorded));
    },
  };

  // `Ai` is the binding's whole surface; the provider calls `run` alone.
  const binding: Ai = Object.create(fake);

  const model = createWorkersAIProvider(binding).createModel(modelId, {
    env: {}, sessionAffinity: affinity, workspaceAffinity: affinity, getAuth: async () => null, hasCredential: async () => false,
  });

  return { model, runs };
}

export interface SharedBinding {
  readonly models: LanguageModel[];
  /** The binding itself, for another of the deployment's callers that asks `run` for no raw response. */
  readonly binding: WorkersAIRunBinding;
  readonly runs: RecordedRun[];
}

/** Models for each affinity over ONE binding whose `run`, as workerd's `Ai.run` does, keeps its options on the binding
 *  and rereads them after awaiting upstream: `upstream(run)` is that await, and a call made meanwhile overwrites them. */
export function sharedBindingModels(
  affinities: readonly string[],
  answer: (run: RecordedRun) => ReadableStream<Uint8Array>,
  upstream: (run: RecordedRun) => Promise<void>,
): SharedBinding {
  const runs: RecordedRun[] = [];
  let kept: WorkersAIRunOptions | undefined;

  const fake: WorkersAIRunBinding = {
    async run(model, inputs, options) {
      const recorded: RecordedRun = { model, inputs, options };

      runs.push(recorded);
      kept = options;
      await upstream(recorded);
      const body = answer(recorded);

      // The shape follows whichever call's options were kept last; the content stays this call's.
      return kept?.returnRawResponse === true ? eventStream(body) : body;
    },
  };

  const binding: Ai = Object.create(fake);

  const models = affinities.map((affinity) => createWorkersAIProvider(binding).createModel('@cf/moonshotai/kimi-k2.6', {
    env: {}, sessionAffinity: affinity, workspaceAffinity: affinity, getAuth: async () => null, hasCredential: async () => false,
  }));

  return { models, binding, runs };
}

export function eventStream(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

export function eventStreamOf(text: string): Response {
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

export function sse(payload: JsonObject): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const DONE = 'data: [DONE]\n\n';
