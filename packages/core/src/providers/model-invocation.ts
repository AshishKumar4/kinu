/**
 * Model invocation, reported. Product code reaches a model only here (.oxlintrc.json names the exemptions): each
 * entry takes the spend it reports, opens its operation frame before the request, and files one `model_call` row
 * when the call returns. A call that threw was not billed and files none.
 */

import { generateText, streamText } from 'ai';
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

function reportOf(
  call: ReportedCall, usage: Usage, response: { readonly modelId?: string; readonly headers?: Readonly<Record<string, string>> },
): ModelCallReport {
  const report: ModelCallReport = call.spec === undefined
    ? { source: call.spend.source, usage, account: callAccountOf(response) }
    : { source: call.spend.source, usage, spec: call.spec, account: callAccountOf(response) };

  const modelId = response.modelId;

  return modelId === undefined || modelId.length === 0 ? report : { ...report, modelId };
}

/** Files the row before the caller parses the answer: the call was billed either way. */
export async function generateReported(
  request: GenerateRequest,
  call: ReportedCall,
  op: Exclude<ModelOperationKind, 'stream'> = 'complete',
): Promise<GenerateResult> {
  const operation = beginModelOperation(call.spend, op, { spec: call.spec });
  let result;

  try {
    result = await generateText(request);
  } catch (cause) {
    operation.failed({ cause });
    throw cause;
  }

  // `totalUsage`, not `usage`: `usage` is the last step's only.
  const usage = normalizeUsage(result.totalUsage);
  operation.completed({ usage, modelId: result.response.modelId });
  call.spend.report(reportOf(call, usage, result.response));

  return result;
}

/** Files the row once the stream drains; an abandoned stream leaves only the start row. */
export async function* streamTextReported(request: StreamRequest, call: ReportedCall): AsyncGenerator<string> {
  const operation = beginModelOperation(call.spend, 'stream', { spec: call.spec });
  let result;

  try {
    result = streamText(request);

    for await (const chunk of result.textStream) yield chunk;
  } catch (cause) {
    operation.failed({ cause });
    throw cause;
  }

  const usage = normalizeUsage(await result.totalUsage);
  const response = await result.response;
  operation.completed({ usage, modelId: response.modelId });
  call.spend.report(reportOf(call, usage, response));
}

/** Structural: core compiles without the Worker's `Env`. */
export interface WorkersAiEmbedding {
  run(model: string, input: { text: string | string[] }): Promise<{ data?: number[][] }>;
}

export type WorkersAiMarkdownConversion = (files: { name: string; blob: Blob }[]) => Promise<
  ({ format: 'markdown'; data: string } | { format: 'error' })[]
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

  const runOne = async (text: string): Promise<number[]> => {
    const result = await binding.run(model, { text });
    opts.report(filed);
    const vec = result?.data?.[0];

    if (!vec || vec.length === 0) {
      throw new Error(`Workers AI embed returned no vector for model ${model}`);
    }

    return vec;
  };

  return {
    dimensions: opts.dimensions ?? 384,
    async embed(text: string) { return runOne(text); },
    async embedBatch(texts: readonly string[]) {
      const result = await binding.run(model, { text: [...texts] });
      opts.report(filed);
      const vectors = result?.data ?? [];

      if (vectors.length !== texts.length) {
        return Promise.all(texts.map((t) => runOne(t)));
      }

      return vectors;
    },
  };
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
