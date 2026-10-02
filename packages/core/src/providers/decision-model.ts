/**
 * Decision models: a state and typed questions in, a probability for every allowed answer out (the System One API).
 * Workers AI serves Clef and Clef-flash at `/ai/run`, beside the OpenAI-compatible `/ai/v1`; evolution rates turns
 * with one (`evolution/ratings.ts`).
 */

import * as v from 'valibot';
import { createCloudflareAIFetch } from './cloudflare-ai-fetch';
import type { createDirectWorkersAIFetch } from './direct-workers-ai-fetch';
import { asFetchFunction } from './fetch-shim';
import { CLOUDFLARE_OAUTH_CRED_KEY } from './cloudflare-oauth';
import { WORKERS_AI_PROVIDER_ID } from './workers-ai';
import type { AuthResolver, ProviderWaitInfo } from './types';
import { KinuError, settle, tolerate } from '../obs/index';
import { readJsonObjectText, type JsonObject } from '../utils/json';
import type { ModelCallSink } from '../events/model-call';
import { Effect } from 'effect';

export const DEFAULT_DECISION_MODEL = 'workers-ai/@cf/cloudflare/clef';

/** The decision models a catalog may name. */
export const DECISION_MODELS = [DEFAULT_DECISION_MODEL, 'workers-ai/@cf/cloudflare/clef-flash'] as const;

export type DecisionQuestion =
  | { readonly type: 'score'; readonly instructions: string; readonly criteria: string[] }
  | { readonly type: 'noul'; readonly instructions: string }
  | { readonly type: 'choice'; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> };

export interface DecisionRequest {
  readonly state: string;
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
}

/** `score` is probability-weighted and 0-based over the criteria; `noul` is the probability of yes. */
const DecisionAnswerSchema = v.variant('type', [
  v.object({ type: v.literal('score'), score: v.number() }),
  v.object({ type: v.literal('noul'), noul: v.number() }),
  v.object({ type: v.literal('choice'), choice: v.string() }),
]);

export type DecisionAnswer = v.InferOutput<typeof DecisionAnswerSchema>;

export type DecisionAnswers = Readonly<Record<string, DecisionAnswer>>;

const AnswersSchema = v.object({
  answers: v.record(v.string(), DecisionAnswerSchema),
  usage: v.optional(v.object({ input_tokens: v.optional(v.number()), output_tokens: v.optional(v.number()) })),
});

/** The REST endpoint wraps the answers in `result`; the binding returns them bare. */
const RunAnswerSchema = v.union([v.object({ result: AnswersSchema }), AnswersSchema]);

/** One decision request on a Workers AI model id (`@cf/cloudflare/clef`), answered as the transport returns it. */
export type DecisionRun = (modelId: string, body: JsonObject) => Promise<JsonObject>;

/** What a runtime carries: the backend chooses the model and the transport. */
export type DecisionPort = (request: DecisionRequest) => Promise<DecisionAnswers>;

/** The model is read per call, so a changed setting applies to the next rating; each answer reports its spend. */
export function createDecisionPort(run: DecisionRun, model: () => Promise<string>, report: ModelCallSink): DecisionPort {
  return async (request) => {
    const spec = await model();
    const modelId = spec.slice(`${WORKERS_AI_PROVIDER_ID}/`.length);
    // The System One API names the model again in the body, by its last segment: `clef`, `clef-flash`.
    const selector = modelId.slice(modelId.lastIndexOf('/') + 1);
    const raw = await run(modelId, { model: selector, state: request.state, questions: { ...request.questions } });
    const parsed = v.safeParse(RunAnswerSchema, raw);

    if (!parsed.success) {
      return settle(Effect.fail(new KinuError('unavailable', `${spec} answered without typed answers`)));
    }

    const { answers, usage } = 'result' in parsed.output ? parsed.output.result : parsed.output;

    // The binding reports no usage: a row with `{}` is unmeasured spend, never free.
    report({
      source: 'rating', spec,
      usage: {
        ...(usage?.input_tokens !== undefined && { input: usage.input_tokens }),
        ...(usage?.output_tokens !== undefined && { output: usage.output_tokens }),
      },
    });
    const missing = Object.keys(request.questions).filter((id) => answers[id]?.type !== request.questions[id]?.type);

    if (missing.length > 0) {
      return settle(Effect.fail(new KinuError('unavailable', `${spec} did not answer ${missing.join(', ')}`)));
    }

    return answers;
  };
}

/** Through the deployment's Workers AI binding, which answers a decision as a whole object. */
export function bindingDecisionRun(binding: Parameters<typeof createDirectWorkersAIFetch>[0]): DecisionRun {
  return async (modelId, body) => {
    const answer = await binding.run(modelId, body);

    if (answer instanceof Response || answer instanceof ReadableStream) {
      return settle(Effect.fail(new KinuError('unavailable', `${modelId} streamed instead of answering`)));
    }

    return answer;
  };
}

const PLACEHOLDER = 'https://kinu-decision.invalid';

const ErrorBodySchema = v.object({
  error: v.optional(v.object({ message: v.string() })),
  errors: v.optional(v.array(v.object({ message: v.string() }))),
});

/**
 * Through `/ai/run`, the sibling of the `/ai/v1` base URL a Workers AI credential names: Cloudflare's own, or the
 * worker's proxy for a signed-in CLI. The request names `<base>/../run/<model>`, resolved before it is sent.
 */
export function restDecisionRun(opts: {
  readonly getAuth: AuthResolver;
  readonly fetch?: typeof fetch;
  readonly onProviderWait?: (info: ProviderWaitInfo) => void;
}): DecisionRun {
  const transport = opts.fetch ?? fetch;
  const resolved = asFetchFunction((input, init) => transport(new URL(input instanceof Request ? input.url : input), init));

  return async (modelId, body) => {
    const send = createCloudflareAIFetch({
      credKey: CLOUDFLARE_OAUTH_CRED_KEY,
      getAuth: opts.getAuth,
      fetch: resolved,
      provider: WORKERS_AI_PROVIDER_ID,
      modelId,
      ...(opts.onProviderWait !== undefined && { onProviderWait: opts.onProviderWait }),
      placeholder: PLACEHOLDER,
      missingCredentialMessage: 'Connect Cloudflare before the decision model can rate turns.',
    });

    const res = await send(`${PLACEHOLDER}/../run/${modelId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    const answer = tolerate(() => readJsonObjectText(text), 'malformed-input');

    if (res.ok && answer) return answer;

    const detail = v.safeParse(ErrorBodySchema, answer);
    const message = detail.success ? detail.output.error?.message ?? detail.output.errors?.[0]?.message : undefined;

    return settle(Effect.fail(new KinuError(
      res.status === 401 || res.status === 403 ? 'denied' : 'unavailable',
      `${modelId} answered ${res.status}${message ? `: ${message}` : ''}`,
    )));
  };
}
