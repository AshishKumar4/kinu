/**
 * Decisions for an account Clef does not serve (no Workers AI): the fast tier answers each question with one category
 * through the model's structured output, and each category stands for a fixed answer of its own (`STRUCTURED_NOUL`),
 * not Clef's probabilities. A model answers only the questions its measured agreement with Clef clears
 * (`AGREEMENT`, measured by `scripts/decision-agreement.ts`); a model or question never measured is not trusted.
 */

import * as v from 'valibot';
import { Effect } from 'effect';
import type { DecisionAnswer, DecisionQuestion, DecisionRequest, DecisionResult } from './decision-model';
import { parseModelSpec } from './types';
import { OWNER_FIXABLE_REFUSALS, providerRefusalCode } from './util';
import type { ActorReference } from '../identity/actor-handle';
import { objectOnRoute, onProfileRoute, type ModelLaneComponents, type RouteCallComponents } from '../profiles/model-lane';
import type { ModelRouteResolution } from '../profiles/model-route';
import { KinuError, settle, toKinuError } from '../obs/index';
import { estimateTokens } from '../token-estimate';

/**
 * What each yes-or-no category stands for. Unclear sits below every bar a consumer reads a yes-or-no against (0.5), so
 * a turn the model cannot read opens no dream, and counts as neither fixed nor harmed by an edit.
 */
const STRUCTURED_NOUL = { yes: 0.9, no: 0.1, unclear: 0.4 } as const;

const NOUL_ANSWERS = ['yes', 'no', 'unclear'] as const;

/** A share for each decision question, by its id in the request (`RATING_QUESTIONS`, `TRIAGE`). */
type Agreement = Readonly<Record<string, number>>;

/**
 * Each chat model's agreement with Clef, by question, as the consumer reads the answer: a rating's band (low below 2.5,
 * high from 3.5), a yes at 0.5, a reason exactly. Keyed by the bare model id, so the same model through any provider is
 * the same row. Measured 2026-10-20 by `scripts/decision-agreement.ts` over the 40 recorded turns of
 * `kinu-logs/dream-cost/recorded-turns-40.jsonl` and their 18 five-turn triage windows (outputs beside it, in
 * `agreement-2026-10-20/`); a row's share is of the items both models answered, the rest lost to Workers AI 408s
 * (gemma: 28 turns; glm-4.7-flash: 32 turns, 14 windows). Re-measure when a question's wording changes.
 * Owed: the Claude models (no plan signed in), and the judge's questions (no recorded judge inputs).
 */
const AGREEMENT: ReadonlyMap<string, Agreement> = new Map(Object.entries({
  'gpt-6-luna': { satisfaction: 0.575, corrected: 0.8, wrong: 0.75, worth: 0.667 },
  'muse-spark-1.3-contributor': { satisfaction: 0.675, corrected: 0.725, wrong: 0.65, worth: 0.778 },
  '@cf/google/gemma-4-26b-a4b-it': { satisfaction: 0.679, corrected: 0.679, wrong: 0.679, worth: 0.611 },
  '@cf/zai-org/glm-4.7-flash': { satisfaction: 0.563, corrected: 0.625, wrong: 0.625, worth: 0.857 },
} satisfies Readonly<Record<string, Agreement>>));

/**
 * The agreement a question needs: Clef-flash's with Clef over the same turns (55%, 70%, 77.5%, 38.9%), as an owner may
 * already pick Clef-flash to rate their turns; never below the share a constant answer gets (Clef's commonest: 47.5%,
 * 65%, 62.5%, 72.2%), as a model under that tells the consumer nothing. A question with none here was never measured,
 * and no chat model answers it.
 */
const TRUST_BAR: ReadonlyMap<string, number> = new Map(Object.entries({ satisfaction: 0.55, corrected: 0.7, wrong: 0.775, worth: 0.722 } satisfies Agreement));

/** The categories one question allows: yes, no or unclear; a criterion's number; or a choice's key. */
function categories(question: DecisionQuestion): readonly string[] {
  switch (question.type) {
    case 'noul': return NOUL_ANSWERS;
    case 'score': return question.criteria.map((_, index) => String(index));
    case 'choice': return Object.keys(question.criteria);
  }
}

function renderQuestion(id: string, question: DecisionQuestion): string {
  const allowed = categories(question).join(', ');

  switch (question.type) {
    case 'noul': return `- ${id} (one of ${allowed}): ${question.instructions}`;
    case 'score': return [`- ${id} (one of ${allowed}): ${question.instructions}`, ...question.criteria.map((text, index) => `    ${String(index)}: ${text}`)].join('\n');
    case 'choice': return [`- ${id} (one of ${allowed}): ${question.instructions}`, ...Object.entries(question.criteria).map(([key, text]) => `    ${key}: ${text}`)].join('\n');
  }
}

function renderPrompt(request: DecisionRequest): string {
  return [
    'Read the state below and answer every question with exactly one of the answers it allows.',
    '',
    'STATE:',
    request.state,
    '',
    'QUESTIONS:',
    Object.entries(request.questions).map(([id, question]) => renderQuestion(id, question)).join('\n'),
    '',
    'Answer as one JSON object with one key per question, its value one of the answers that question allows.',
  ].join('\n');
}

function answerOf(question: DecisionQuestion, category: string): DecisionAnswer {
  switch (question.type) {
    case 'noul': return { type: 'noul', noul: STRUCTURED_NOUL[v.parse(v.picklist(NOUL_ANSWERS), category)] };
    case 'score': return { type: 'score', score: Number(category) };
    case 'choice': return { type: 'choice', choice: category };
  }
}

/** The answer's shape: each question one of its categories. */
function answersSchema(request: DecisionRequest) {
  return v.strictObject(Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, v.picklist(categories(question))])));
}

/**
 * `request` answered by the route's models in turn, each through its structured output (`objectOnRoute`), billed
 * under the route's source as each call completes. An answer off the categories is refused, never guessed. Its usage
 * is estimated from the prompt and the answer, as a mission budget estimates a completion's. Null when every model
 * refused for a reason only the owner can fix, which the walk said once.
 */
export function answerStructured(lane: RouteCallComponents, route: ModelRouteResolution, request: DecisionRequest): Promise<DecisionResult | null> {
  const prompt = renderPrompt(request);

  return settle(Effect.tryPromise({
    try: () => objectOnRoute(route, lane, prompt, answersSchema(request)),
    catch: (cause) => (cause instanceof KinuError ? cause : toKinuError({ doing: 'answering decisions', cause, otherwise: 'unavailable' })),
  }).pipe(
    Effect.map((answered) => ({
      answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, answerOf(question, String(answered[id]))])),
      usage: { input: estimateTokens(prompt.length), output: estimateTokens(JSON.stringify(answered).length) },
    })),
    Effect.catch((failure) => (OWNER_FIXABLE_REFUSALS.has(providerRefusalCode({ cause: failure }) ?? failure.code)
      ? Effect.succeed(null)
      : Effect.fail(failure))),
  ));
}

/** Whether `model`'s measured agreement clears the bar of every question `request` asks. */
function trusts(model: string, request: DecisionRequest): boolean {
  const measured = AGREEMENT.get(parseModelSpec(model).modelId) ?? {};

  return Object.keys(request.questions).every((id) => {
    const bar = TRUST_BAR.get(id);
    const agreement = measured[id];

    return bar !== undefined && agreement !== undefined && agreement >= bar;
  });
}

/** `route` with only the models trusted for `request`, the first of them serving; null when none is. */
function trustedRoute(route: ModelRouteResolution, request: DecisionRequest): ModelRouteResolution | null {
  const [first, ...rest] = [{ model: route.model, reasoningEffort: route.reasoningEffort }, ...route.fallbacks]
    .filter((entry) => trusts(entry.model, request));

  return first === undefined ? null : { ...route, model: first.model, reasoningEffort: first.reasoningEffort, fallbacks: rest };
}

/** A decision answered by the fast tier's trusted models; undefined where none it walks is trusted for every question. */
export type StructuredDecider = (request: DecisionRequest) => Promise<DecisionResult | null | undefined>;

/**
 * The fast tier's route is read per call, so a changed setting applies to the next decision. Null while the table
 * trusts no model for any question: no decision could be answered, and a host without Clef keeps no decision port.
 */
export function createStructuredDecider(actor: ActorReference, lane: ModelLaneComponents): StructuredDecider | null {
  const trustsAny = [...AGREEMENT.values()].some((measured) => Object.entries(measured).some(([id, agreement]) => agreement >= (TRUST_BAR.get(id) ?? Infinity)));

  if (!trustsAny) return null;

  return (request) => onProfileRoute(actor, 'fast', lane, async (fast) => {
    const route = trustedRoute(fast, request);

    return route === null ? undefined : await answerStructured(lane, route, request);
  });
}
