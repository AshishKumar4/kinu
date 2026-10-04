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
import { KinuError, settle, tolerate, toKinuError } from '../obs/index';
import { readJsonObjectText, type JsonObject } from '../utils/json';
import type { ModelCallSink } from '../events/model-call';
import type { Usage } from '../usage';
import type { TierRefusals } from '../types/refusals';
import { codeForStatus, OWNER_FIXABLE_REFUSALS, providerRefusalCode } from './util';
import { Effect } from 'effect';

export const DEFAULT_DECISION_MODEL = 'workers-ai/@cf/cloudflare/clef';

/** The decision models a catalog may name. */
export const DECISION_MODELS = [DEFAULT_DECISION_MODEL, 'workers-ai/@cf/cloudflare/clef-flash'] as const;

export type DecisionModel = (typeof DECISION_MODELS)[number];

/** The notice key a refusing decision model is said under, beside the tiers' (`profiles/tier-refusals.ts`). */
export const DECISION_REFUSALS = 'decision';

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

/** Measured 2026-10-02 (kinu-logs/evals-fast/clef-satisfaction/binding-2026-10-02): the binding answers
 *  `{ model, answers, usage }` and REST wraps the same in `result`; both report `input_tokens`. */
const AnswersSchema = v.object({
  answers: v.record(v.string(), DecisionAnswerSchema),
  usage: v.object({ input_tokens: v.number(), output_tokens: v.number() }),
});

const RunAnswerSchema = v.union([v.object({ result: AnswersSchema }), AnswersSchema]);

/** One decision request on a Workers AI model id (`@cf/cloudflare/clef`), answered as the transport returns it. */
export type DecisionRun = (modelId: string, body: JsonObject) => Promise<JsonObject>;

export interface DecisionResult {
  readonly answers: DecisionAnswers;
  readonly usage: Usage;
}

/** What a runtime carries. Null: the model refused for a reason only the owner can fix, already said to them. */
export type DecisionPort = (request: DecisionRequest) => Promise<DecisionResult | null>;

/**
 * The model is read per call, so a changed setting applies to the next rating, and each answer reports its spend.
 * A refusal only the owner can fix is said once through `refusals` and answers null rather than failing, so nothing
 * retries it; any other failure throws for the caller's retry.
 */
export function createDecisionPort(opts: {
  readonly run: DecisionRun;
  readonly model: () => Promise<DecisionModel>;
  readonly report: ModelCallSink;
  readonly refusals: TierRefusals;
}): DecisionPort {
  return (request) => settle(Effect.gen(function* () {
    const spec = yield* Effect.promise(() => opts.model());
    const modelId = spec.slice(`${WORKERS_AI_PROVIDER_ID}/`.length);
    const since = opts.refusals.changes();
    // The body names the model bare: Workers AI refuses `@cf/cloudflare/clef` there (400, `^(clef|clef-flash)$`,
    // measured on the binding 2026-10-03).
    const model = modelId.slice(modelId.lastIndexOf('/') + 1);

    const raw = yield* Effect.tryPromise({
      try: () => opts.run(modelId, { model, state: request.state, questions: { ...request.questions } }),
      catch: (cause) => toKinuError({ doing: `rating a turn with ${spec}`, cause, otherwise: 'unavailable' }),
    }).pipe(Effect.catch((failure) => OWNER_FIXABLE_REFUSALS.has(providerRefusalCode({ cause: failure }) ?? failure.code)
      ? Effect.sync(() => {
        opts.refusals.refused({ tier: DECISION_REFUSALS, since, refusals: [{ model: spec, cause: failure.cause }] });

        return null;
      })
      : Effect.fail(failure)));

    if (raw === null) return null;
    const parsed = v.safeParse(RunAnswerSchema, raw);

    if (!parsed.success) return yield* Effect.fail(new KinuError('bad_input', `${spec} answered without typed answers`));

    const { answers, usage: reported } = 'result' in parsed.output ? parsed.output.result : parsed.output;
    const usage = { input: reported.input_tokens, output: reported.output_tokens };

    opts.report({ source: 'rating', spec, usage });
    opts.refusals.answered(DECISION_REFUSALS);
    const missing = Object.keys(request.questions).filter((id) => answers[id]?.type !== request.questions[id]?.type);

    if (missing.length > 0) return yield* Effect.fail(new KinuError('bad_input', `${spec} did not answer ${missing.join(', ')}`));

    return { answers, usage };
  }));
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
      codeForStatus(res.status) ?? 'unavailable',
      `${modelId} answered ${res.status}${message ? `: ${message}` : ''}`,
    )));
  };
}
