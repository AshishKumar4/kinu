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
    env: {}, sessionAffinity: affinity, getAuth: async () => null, hasCredential: async () => false,
  });

  return { model, runs };
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
