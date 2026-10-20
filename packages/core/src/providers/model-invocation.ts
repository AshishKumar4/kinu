/**
 * Model invocation, reported. Product code reaches a model only here (.oxlintrc.json names the exemptions): each
 * entry takes the spend it reports, opens its operation frame before the request, and files one `model_call` row
 * when the call returns. A call that threw was not billed and files none.
 */

import { generateText, jsonSchema, NoObjectGeneratedError, Output, streamText } from 'ai';
import { toJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';
import { Cause, Effect } from 'effect';
import { KinuError, settle } from '../obs/index';
import {
  beginModelOperation, type ModelCallReport, type ModelCallSink, type ModelCallSpend, type ModelOperationKind,
} from '../events/model-call';
import type { Embedder } from '../memory/vector-store';
import { normalizeUsage, type Usage } from '../usage';
import { callAccountOf } from './quota';
import { mergeProviderOptions, type ProviderOptions } from './effort';

export type GenerateRequest = Parameters<typeof generateText>[0];

export type GenerateResult = Awaited<ReturnType<typeof generateText>>;

export type StreamRequest = Parameters<typeof streamText>[0];

export interface ReportedCall {
  readonly spend: ModelCallSpend;
  readonly spec?: string;
}

export type StreamPart = StreamResult['fullStream'] extends AsyncIterable<infer Part> ? Part : never;

type StreamResult = ReturnType<typeof streamText>;

function reportOf(
  call: ReportedCall, usage: Usage, response: { readonly modelId?: string; readonly headers?: Readonly<Record<string, string>> },
): ModelCallReport {
  const report: ModelCallReport = call.spec === undefined
    ? { source: call.spend.source, usage, account: callAccountOf(response) }
    : { source: call.spend.source, usage, spec: call.spec, account: callAccountOf(response) };

  const modelId = response.modelId;

  return modelId === undefined || modelId.length === 0 ? report : { ...report, modelId };
}

/** An answer stopped at the model's output limit is no answer: a one-shot call has no next step to continue it. */
function outputLimitFailure(modelId: string, finishReason: string, cause?: Error): KinuError {
  return new KinuError('unavailable', `${modelId} stopped its answer at its output limit (${finishReason})`, cause === undefined ? undefined : { cause });
}

/** Files the row before the caller parses the answer: the call was billed either way, and an answer the requested output
 *  could not read (`NoObjectGeneratedError`, thrown inside the call) was answered too. An answer stopped at the model's
 *  output limit fails rather than reads complete ({@link outputLimitFailure}). */
export function generateReported(
  request: GenerateRequest,
  call: ReportedCall,
  op: Exclude<ModelOperationKind, 'stream'> = 'complete',
): Promise<GenerateResult> {
  return settle(Effect.gen(function* () {
    const operation = beginModelOperation(call.spend, op, { spec: call.spec });

    const billed = (usage: Usage, response: { readonly modelId?: string; readonly headers?: Readonly<Record<string, string>> }) => {
      operation.completed({ usage, modelId: response.modelId });
      call.spend.report(reportOf(call, usage, response));
    };

    const result = yield* Effect.onError(Effect.promise(() => generateText(request)), (cause) => Effect.sync(() => {
      const failure = Cause.squash(cause);

      if (NoObjectGeneratedError.isInstance(failure) && failure.usage !== undefined && failure.response !== undefined) billed(normalizeUsage(failure.usage), failure.response);
      else operation.failed({ cause: failure });
    }));

    billed(normalizeUsage(result.usage), result.response);

    if (result.finishReason === 'length') return yield* Effect.fail(outputLimitFailure(result.response.modelId, result.rawFinishReason ?? 'length'));

    return result;
  }));
}

/**
 * Strict structured output admits only closed objects whose every field is required (OpenAI's `strict`, which the
 * OpenAI and OpenAI-compatible adapters default to): a schema with an optional field or an open JSON value is refused
 * there before any answer. The schema is still sent; the answer is read through it.
 */
const NON_STRICT: ProviderOptions = { openai: { strictJsonSchema: false }, openaiCompatible: { strictJsonSchema: false } };

/**
 * One answer of `schema`'s shape, through the model's structured output: the provider is sent the schema as JSON
 * Schema (`toJsonSchema`; a value it cannot express, as a JSON value, is any value there), and the answer is read back
 * through `schema` itself. Billed as {@link generateReported} bills. An answer off the schema was billed and is no
 * answer: it fails `bad_input`, as a wrong answer does, and is not asked of another model; an answer stopped at the
 * output limit fails `unavailable`, as {@link generateReported}'s does.
 */
export function generateObjectReported<S extends v.GenericSchema>(request: GenerateRequest, schema: S, call: ReportedCall): Promise<v.InferOutput<S>> {
  const generated: GenerateRequest = {
    ...request,
    output: Output.object({ schema: jsonSchema(toJsonSchema(schema, { errorMode: 'ignore' })) }),
    providerOptions: mergeProviderOptions(request.providerOptions, NON_STRICT),
  };

  const offSchema = (cause: Error) => new KinuError('bad_input', `${call.spec ?? 'the model'} answered off its schema`, { cause });

  return settle(Effect.promise(() => generateReported(generated, call)).pipe(
    // Any other failure is the provider's, kept as it came for the route walk to read.
    Effect.catchDefect((defect) => {
      if (!NoObjectGeneratedError.isInstance(defect)) return Effect.die(defect);

      return Effect.fail(defect.finishReason === 'length' ? outputLimitFailure(defect.response?.modelId ?? call.spec ?? 'the model', 'length', defect) : offSchema(defect));
    }),
    Effect.flatMap((result) => {
      const parsed = v.safeParse(schema, result.output);

      return parsed.success ? Effect.succeed(parsed.output) : Effect.fail(offSchema(new v.ValiError(parsed.issues)));
    }),
  ));
}

/** Files the row once the stream drains; an abandoned stream leaves only the start row. */
export async function* streamTextReported(
  request: StreamRequest,
  call: ReportedCall,
  onPart?: (part: StreamPart) => void,
): AsyncGenerator<string> {
  const operation = beginModelOperation(call.spend, 'stream', { spec: call.spec });
  let result;

  try {
    result = streamText(request);

    if (onPart === undefined) {
      for await (const chunk of result.textStream) yield chunk;
    } else {
      for await (const part of result.stream) {
        // Like textStream
        if (part.type === 'error') throw part.error;
        onPart(part);

        if (part.type === 'text-delta') yield part.text;
      }
    }
  } catch (cause) {
    operation.failed({ cause });
    throw cause;
  }

  const usage = normalizeUsage(await result.usage);
  const response = await result.response;
  operation.completed({ usage, modelId: response.modelId });
  call.spend.report(reportOf(call, usage, response));
}

/** Structural: core compiles without the Worker's `Env`. */
export interface WorkersAiEmbedding {
  run(model: string, input: { text: string | string[] }): Promise<{ data?: number[][] }>;
}

type WorkersAiMarkdownConversion = (files: { name: string; blob: Blob }[]) => Promise<
  ({ format: 'markdown' | 'text'; data: string } | { format: 'error' })[]
>;

export interface WorkersAiMarkdown {
  readonly toMarkdown?: WorkersAiMarkdownConversion;
}

interface ConvertingBinding {
  readonly toMarkdown: WorkersAiMarkdownConversion;
}

function converts(ai: WorkersAiMarkdown | undefined): ai is ConvertingBinding {
  return ai?.toMarkdown !== undefined;
}

/** The binding reports no usage: each request files one unmeasured `platform` row. */
export function createWorkersAIEmbedder(opts: {
  readonly env: { readonly AI?: WorkersAiEmbedding };
  readonly model?: string;
  readonly dimensions?: number;
  readonly report: ModelCallSink;
}): Embedder | undefined {
  const binding = opts.env.AI;

  if (binding === undefined) return undefined;
  const model = opts.model ?? '@cf/baai/bge-small-en-v1.5';
  const filed: ModelCallReport = { source: 'platform', usage: {}, spec: `workers-ai/${model}`, modelId: model };

  const runOne = (text: string): Effect.Effect<number[]> => Effect.flatMap(Effect.promise(() => binding.run(model, { text })), (result) => {
    opts.report(filed);
    const vec = result?.data?.[0];

    return !vec || vec.length === 0 ? Effect.die(new Error(`Workers AI embed returned no vector for model ${model}`)) : Effect.succeed(vec);
  });

  return {
    dimensions: opts.dimensions ?? 384,
    embed(text: string) { return settle(runOne(text)); },
    embedBatch(texts: readonly string[]) {
      return settle(Effect.flatMap(Effect.promise(() => binding.run(model, { text: [...texts] })), (result) => {
        opts.report(filed);
        const vectors = result?.data ?? [];

        return vectors.length === texts.length ? Effect.succeed(vectors) : Effect.forEach(texts, (t) => runOne(t), { concurrency: 'unbounded' });
      }));
    },
  };
}

/** The binding's web search (`Ai.websearch`, @cloudflare/workers-types): Cloudflare's Web Search API on a gateway. */
export interface WorkersAiWebSearch {
  websearch(request: { gatewayId: string; query: string; limit?: number; provider: string }): Promise<Response>;
}

/** The binding's search, bound; each answered search is filed as `search` spend by the chain that asked it
 *  (web/search-chain.ts), which alone knows the provider and who paid. */
export function workersAiWebSearch(env: { readonly AI?: Partial<WorkersAiWebSearch> }): WorkersAiWebSearch['websearch'] | undefined {
  const ai = env.AI;

  return ai?.websearch?.bind(ai);
}

/** Each conversion files one unmeasured `platform` row. */
export function workersAiHtmlToMarkdown(
  env: { readonly AI?: WorkersAiMarkdown },
  report: ModelCallSink,
): ((html: string, opts?: { url?: string }) => Promise<string>) | undefined {
  const ai = env.AI;

  if (!converts(ai)) return undefined;

  return async (html, opts) => {
    const name = `${opts?.url ?? 'page'}.html`;
    const blob = new Blob([html], { type: 'text/html' });
    const out = await ai.toMarkdown([{ name, blob }]);
    report({ source: 'platform', usage: {}, modelId: 'toMarkdown' });
    const converted = out[0];

    return converted?.format === 'markdown' ? converted.data : '';
  };
}
