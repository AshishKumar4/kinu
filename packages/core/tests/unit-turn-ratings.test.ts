/**
 * The rating ledger: a thumb or a pick wins over the decision model, a cleared thumb falls back, and the quality
 * series reads satisfaction per day. The decision model's transports read Clef's answers in both shapes.
 */
import { describe, expect, test } from 'bun:test';
import { EvolutionEngine } from '../src/evolution/engine';
import type { CompletedTurn } from '../src/evolution/types';
import {
  listThumbs, listTurnRatings, qualitySeries, ratingOf, recordTurnRating, retractThumbs, satisfactionInterval,
} from '../src/evolution/ratings';
import {
  createDecisionPort, restDecisionRun, type DecisionAnswers, type DecisionPort, type DecisionQuestion,
} from '../src/providers/decision-model';
import { asFetchFunction } from '../src/providers/fetch-shim';
import { requestUrl } from '../src/http/http';
import type { ModelCallReport } from '../src/events/model-call';
import { createTestRuntime } from './helpers';

/** Clef's REST answer (2026-10-02) to a turn whose reply was a written correction. */
const CLEF_REST_ANSWER = {
  result: {
    model: 'clef',
    answers: {
      satisfaction: { type: 'score', score: 0.3393, confidence: 0.4631 },
      corrected: { type: 'noul', noul: 0.9704 },
      wrong: { type: 'choice', choice: 'misunderstood', confidence: 0.12 },
    },
    usage: { input_tokens: 1802, output_tokens: 0 },
  },
  success: true,
};

const QUESTIONS = {
  satisfaction: { type: 'score', instructions: 'How satisfied?', criteria: ['no', 'yes'] },
  corrected: { type: 'noul', instructions: 'Corrected?' },
  wrong: { type: 'choice', instructions: 'What went wrong?', criteria: { nothing: 'nothing' } },
} satisfies Record<string, DecisionQuestion>;

function turn(): CompletedTurn {
  return {
    userMessage: 'export the report as CSV', assistantResponse: 'Here it is as JSON.',
    toolCalls: [{ name: 'shell', args: { command: 'export --json' }, outcome: { success: true } }],
    durationMs: 1, steps: 1, hadError: false, feedback: null, turnId: 'u-1', sessionId: 'default', origin: 'user',
  };
}

function decide(answers: DecisionAnswers): DecisionPort {
  return async () => answers;
}

const LOW: DecisionAnswers = {
  satisfaction: { type: 'score', score: 0.3 }, corrected: { type: 'noul', noul: 0.9 }, wrong: { type: 'choice', choice: 'misunderstood' },
};

describe('the rating ledger', () => {
  test('a thumb wins over the decision model, and a cleared thumb falls back to it', async () => {
    const { rt, stores } = createTestRuntime();
    Object.assign(rt, { decide: decide(LOW) });
    const engine = new EvolutionEngine(rt, stores.history);

    await engine.reviewTurn(turn(), 'No, CSV. I said CSV.');
    expect(ratingOf(rt.storage.sql, rt.actor, 'u-1')).toMatchObject({ source: 'model', score: 1.3, wrong: 'misunderstood' });

    await engine.applyExplicitFeedback('u-1', 'positive');
    expect(ratingOf(rt.storage.sql, rt.actor, 'u-1')).toMatchObject({ source: 'thumbs', score: 5, corrected: 0 });
    expect(Object.fromEntries(listThumbs(rt.storage.sql, rt.actor))).toEqual({ 'u-1': 'positive' });

    await engine.applyExplicitFeedback('u-1', null);
    expect(ratingOf(rt.storage.sql, rt.actor, 'u-1')).toMatchObject({ source: 'model', score: 1.3 });
    expect(listThumbs(rt.storage.sql, rt.actor).size).toBe(0);
  });

  test('a thumb recorded before the reply is adopted without asking the model', async () => {
    const { rt, stores } = createTestRuntime();
    let asked = 0;

    rt.decide = async () => {
      asked++;

      return LOW;
    };

    const engine = new EvolutionEngine(rt, stores.history);

    await engine.applyExplicitFeedback('u-1', 'negative');
    await engine.reviewTurn(turn(), 'whatever');

    expect(asked).toBe(0);
    expect(listTurnRatings(rt.storage.sql, rt.actor).map((rating) => [rating.source, rating.score])).toEqual([['thumbs', 1]]);
  });

  test('without a decision model, an answered turn stays unrated', async () => {
    const { rt, stores } = createTestRuntime();

    await new EvolutionEngine(rt, stores.history).reviewTurn(turn(), 'No, CSV.');

    expect(listTurnRatings(rt.storage.sql, rt.actor)).toEqual([]);
  });

  test('satisfaction per day carries its interval, the corrected rate and the thumbs share', () => {
    const { rt } = createTestRuntime();
    const day = Date.UTC(2026, 9, 1, 12);

    const rate = (turnId: string, score: number, source: 'model' | 'thumbs', now: number) => recordTurnRating(
      rt.storage.sql, rt.actor, { turnId, score, corrected: score <= 2 ? 1 : 0, wrong: null, source, request: 'r', answer: 'a', now },
    );

    rate('a', 4, 'model', day);
    rate('b', 2, 'model', day + 1);
    rate('c', 5, 'thumbs', day + 86_400_000);

    const series = qualitySeries(rt.storage.sql, rt.actor, { days: 2, now: day + 86_400_000 });

    expect(series.map((entry) => [entry.day, entry.rated, entry.thumbs, entry.satisfaction.mean])).toEqual([
      ['2026-10-01', 2, 0, 3], ['2026-10-02', 1, 1, 5],
    ]);
    expect(series[0]?.corrected.mean).toBe(0.5);
    expect(series[0]?.satisfaction).toMatchObject(satisfactionInterval([4, 2]));
  });

  test('retracting a thumb touches no other source', () => {
    const { rt } = createTestRuntime();
    recordTurnRating(rt.storage.sql, rt.actor, { turnId: 't', score: 4, corrected: 0, wrong: null, source: 'take_pick', request: 'r', answer: 'a' });
    recordTurnRating(rt.storage.sql, rt.actor, { turnId: 't', score: 1, corrected: 1, wrong: null, source: 'thumbs', request: 'r', answer: 'a' });

    retractThumbs(rt.storage.sql, rt.actor, 't');

    expect(ratingOf(rt.storage.sql, rt.actor, 't')).toMatchObject({ source: 'take_pick', score: 4 });
  });
});

describe('the decision model', () => {
  test("reads Clef's REST answer and the binding's bare one alike, and reports each call's spend", async () => {
    const spent: ModelCallReport[] = [];
    const report = (call: ModelCallReport) => { spent.push(call); };

    const { usage: _usage, ...bare } = CLEF_REST_ANSWER.result;
    const rest = createDecisionPort(async () => CLEF_REST_ANSWER, async () => 'workers-ai/@cf/cloudflare/clef', report);
    const binding = createDecisionPort(async () => bare, async () => 'workers-ai/@cf/cloudflare/clef', report);

    for (const port of [rest, binding]) {
      expect(await port({ state: 's', questions: QUESTIONS })).toMatchObject({
        satisfaction: { type: 'score', score: 0.3393 }, corrected: { type: 'noul', noul: 0.9704 }, wrong: { choice: 'misunderstood' },
      });
    }

    // The binding reports no usage, so its row is unmeasured rather than free.
    expect(spent).toEqual([
      { source: 'rating', spec: 'workers-ai/@cf/cloudflare/clef', usage: { input: 1802, output: 0 } },
      { source: 'rating', spec: 'workers-ai/@cf/cloudflare/clef', usage: {} },
    ]);
  });

  test('names the model by its selector in the body, and refuses an answer that skips a question', async () => {
    const bodies: unknown[] = [];

    const port = createDecisionPort(async (modelId, body) => {
      bodies.push({ modelId, model: body.model });

      return { answers: { satisfaction: { type: 'score', score: 1 } } };
    }, async () => 'workers-ai/@cf/cloudflare/clef-flash', () => {});

    await expect(port({ state: 's', questions: QUESTIONS })).rejects.toThrow('did not answer corrected, wrong');
    expect(bodies).toEqual([{ modelId: '@cf/cloudflare/clef-flash', model: 'clef-flash' }]);
  });

  test("runs at `/ai/run` beside the credential's `/ai/v1`, on Cloudflare and through the worker alike", async () => {
    for (const [baseURL, expected] of [
      ['https://api.cloudflare.com/client/v4/accounts/acct/ai/v1', 'https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef'],
      ['https://kinu.run/api/user/ai/v1', 'https://kinu.run/api/user/ai/run/@cf/cloudflare/clef'],
    ] as const) {
      const seen: Array<{ url: string; auth: string | null }> = [];

      const run = restDecisionRun({
        getAuth: async () => ({ baseURL, headers: { Authorization: 'Bearer t' } }),
        fetch: asFetchFunction(async (input, init) => {
          seen.push({ url: new URL(requestUrl(input)).href, auth: new Headers(init?.headers).get('authorization') });

          return Response.json(CLEF_REST_ANSWER);
        }),
      });

      expect(await run('@cf/cloudflare/clef', { model: 'clef', state: 's', questions: {} })).toEqual(CLEF_REST_ANSWER);
      expect(seen).toEqual([{ url: expected, auth: 'Bearer t' }]);
    }
  });

  test("a refusal carries the provider's own words", async () => {
    const run = restDecisionRun({
      getAuth: async () => ({ baseURL: 'https://kinu.run/api/user/ai/v1', headers: {} }),
      fetch: asFetchFunction(async () => Response.json({ errors: [{ message: 'Rate limited' }] }, { status: 400 })),
    });

    await expect(run('@cf/cloudflare/clef', {})).rejects.toThrow('@cf/cloudflare/clef answered 400: Rate limited');
  });
});
