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

/** Files the row before the caller parses the answer: the call was billed either way. An answer stopped at the model's
 *  output limit is no answer: a one-shot call has no next step to continue it, so it fails rather than reads complete. */
export function generateReported(
  request: GenerateRequest,
  call: ReportedCall,
  op: Exclude<ModelOperationKind, 'stream'> = 'complete',
): Promise<GenerateResult> {
  return settle(Effect.gen(function* () {
    const operation = beginModelOperation(call.spend, op, { spec: call.spec });

    const result = yield* Effect.onError(Effect.promise(() => generateText(request)),
      (cause) => Effect.sync(() => operation.failed({ cause: Cause.squash(cause) })));

    const usage = normalizeUsage(result.usage);
    operation.completed({ usage, modelId: result.response.modelId });
    call.spend.report(reportOf(call, usage, result.response));

    if (result.finishReason === 'length') {
      return yield* Effect.fail(new KinuError('unavailable', `${result.response.modelId} stopped its answer at its output limit (${result.rawFinishReason ?? 'length'})`));
    }

    return result;
  }));
}

/** Files the row once the stream drains; an abandoned stream leaves only the start row. */
/** What a structured call sends: the routed call's model, prompt and options; the output is the schema's. */
export interface ObjectRequest {
  readonly model: GenerateRequest['model'];
  readonly prompt: string;
  readonly system?: string;
  readonly maxRetries?: number;
  readonly providerOptions?: GenerateRequest['providerOptions'];
}

/**
 * One answer of `schema`'s shape, through the model's structured output: the provider is sent the schema as JSON
 * Schema (`toJsonSchema`; a value it cannot express, as a JSON value, is any value there), and the answer is read back
 * through `schema` itself. Billed as {@link generateReported} bills. An answer off the schema was billed and is no
 * answer: it fails `unavailable`, caused by the SDK's `NoObjectGeneratedError` or the schema's `ValiError`, so a route
 * walk hands the call to its next model.
 */
export function generateObjectReported<S extends v.GenericSchema>(request: ObjectRequest, schema: S, call: ReportedCall): Promise<v.InferOutput<S>> {
  const { system, ...sent } = request;

  const generated: GenerateRequest = {
    ...sent, ...(system !== undefined && { system }), output: Output.object({ schema: jsonSchema(toJsonSchema(schema, { errorMode: 'ignore' })) }),
  };

  const offSchema = (cause: Error) => new KinuError('unavailable', `${call.spec ?? 'the model'} answered off its schema`, { cause });

  return settle(Effect.promise(() => generateReported(generated, call)).pipe(
    // Any other failure is the provider's, kept as it came for the route walk to read.
    Effect.catchDefect((defect) => (NoObjectGeneratedError.isInstance(defect) ? Effect.fail(offSchema(defect)) : Effect.die(defect))),
    Effect.flatMap((result) => {
      const parsed = v.safeParse(schema, result.output);

      return parsed.success ? Effect.succeed(parsed.output) : Effect.fail(offSchema(new v.ValiError(parsed.issues)));
    }),
  ));
}

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
