/**
 * The rating ledger: a thumb or a pick wins over the decision model, a cleared thumb falls back, and the quality
 * series reads satisfaction per day. The decision model reads Clef's measured answers on both transports, and a
 * refusal only the owner can fix is said once and retried by nothing.
 */
import { compactToolCall } from '../src/evolution/tool-call-record';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { EvolutionEngine } from '../src/evolution/engine';
import type { CompletedTurn } from '../src/evolution/types';
import {
  listThumbs, listTurnRatings, qualitySeries, qualityWindow, ratingOf, recordTurnRating, retractThumbs,
} from '../src/evolution/ratings';
import {
  bindingDecisionRun, createDecisionPort, DECISION_REFUSALS, restDecisionRun, type DecisionAnswers, type DecisionPort, type DecisionQuestion,
} from '../src/providers/decision-model';
import { tierRefusals, unratedReason } from '../src/profiles/tier-refusals';
import { RefinementListingSchema } from '../src/evolution/refinement-host';
import { readActivityLog } from '../src/identity/activity-log';
import { KinuError } from '../src/obs/error';
import { CLEF_BINDING_ANSWER } from '@kinu.run/test-utils/clef-binding-answer';
import type { AgentRuntime } from '../src/types/agent-runtime';
import { asFetchFunction } from '../src/providers/fetch-shim';
import { requestUrl } from '../src/http/http';
import type { ModelCallReport } from '../src/events/model-call';
import { createTestRuntime } from './helpers';
import { historyTurnPairs } from '../src/identity/conversation-store';

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
    toolCalls: [compactToolCall({ name: 'shell', args: { command: 'export --json' }, outcome: { success: true } })],
    durationMs: 1, steps: 1, hadError: false, feedback: null, turnId: 'u-1', sessionId: 'default', origin: 'user',
  };
}

function decide(answers: DecisionAnswers): DecisionPort {
  return async () => ({ answers, usage: { input: 0, output: 0 } });
}

/** Refusal notices over the runtime's own config and activity log, as both backends build them. */
function noticesOf(rt: AgentRuntime) {
  const refusals = tierRefusals({
    sql: rt.storage.sql, actor: rt.actor, config: rt.actor.config, now: () => 1, settings: 'Settings → Models', changes: () => 0,
  });

  return {
    refusals,
    said: () => readActivityLog(rt.storage.sql, rt.actor, 10).filter((row) => row.event === 'model_tier_refused').map((row) => row.detail),
  };
}

const LOW: DecisionAnswers = {
  satisfaction: { type: 'score', score: 0.3 }, corrected: { type: 'noul', noul: 0.9 }, wrong: { type: 'choice', choice: 'misunderstood' },
};

describe('the rating ledger', () => {
  test('a thumb wins over the decision model, and a cleared thumb falls back to it', async () => {
    const { rt, stores } = createTestRuntime();
    Object.assign(rt, { decide: decide(LOW) });
    const engine = new EvolutionEngine(rt, historyTurnPairs(stores.history));

    await engine.reviewTurn(turn(), 'No, CSV. I said CSV.');
    expect(ratingOf(rt.storage.sql, rt.actor, 'u-1')).toMatchObject({ source: 'model', score: 1.3, wrong: 'misunderstood' });

    await engine.applyExplicitFeedback('u-1', 'positive');
    expect(ratingOf(rt.storage.sql, rt.actor, 'u-1')).toMatchObject({ source: 'thumbs', score: 5, corrected: 0 });
    expect(Object.fromEntries(listThumbs(rt.storage.sql, rt.actor))).toEqual({ 'u-1': 'positive' });

    await engine.applyExplicitFeedback('u-1', null);
    expect(ratingOf(rt.storage.sql, rt.actor, 'u-1')).toMatchObject({ source: 'model', score: 1.3 });
    expect(listThumbs(rt.storage.sql, rt.actor).size).toBe(0);
  });

  test('a reply under a thumb is still read, so clearing the thumb leaves the turn rated', async () => {
    const { rt, stores } = createTestRuntime();
    let asked = 0;

    rt.decide = async () => {
      asked++;

      return { answers: LOW, usage: { input: 0, output: 0 } };
    };

    const engine = new EvolutionEngine(rt, historyTurnPairs(stores.history));

    await engine.applyExplicitFeedback('u-1', 'negative');
    await engine.reviewTurn(turn(), 'No, CSV. I said CSV.');

    expect(asked).toBe(1);
    expect(ratingOf(rt.storage.sql, rt.actor, 'u-1')).toMatchObject({ source: 'thumbs', score: 1 });

    await engine.applyExplicitFeedback('u-1', null);
    expect(ratingOf(rt.storage.sql, rt.actor, 'u-1')).toMatchObject({ source: 'model', score: 1.3 });
  });

  test('without a decision model, an answered turn stays unrated', async () => {
    const { rt, stores } = createTestRuntime();

    await new EvolutionEngine(rt, historyTurnPairs(stores.history)).reviewTurn(turn(), 'No, CSV.');

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
  });

  // #107: "Satisfaction, 7 days" read the last seven days that had ratings, so a rating weeks old counted as this week's.
  test('the last seven days are seven UTC days, however far apart the ratings are', () => {
    const { rt } = createTestRuntime();
    const today = Date.UTC(2026, 9, 30, 12);
    const DAY = 86_400_000;

    const rate = (turnId: string, score: number, daysAgo: number) => recordTurnRating(
      rt.storage.sql, rt.actor, { turnId, score, corrected: 0, wrong: null, source: 'thumbs', request: 'r', answer: 'a', now: today - daysAgo * DAY },
    );

    rate('weeks-ago', 1, 20);
    rate('last-month', 1, 13);
    rate('this-week', 5, 2);

    const week = qualityWindow(rt.storage.sql, rt.actor, { days: 7, now: today });
    const series = qualitySeries(rt.storage.sql, rt.actor, { days: 30, now: today });

    expect({ from: week.from, to: week.to, rated: week.rated, mean: week.satisfaction.mean }).toEqual({ from: '2026-10-24', to: '2026-10-30', rated: 1, mean: 5 });
    expect(series.length).toBe(30);
    expect(series.filter((entry) => entry.rated > 0).map((entry) => entry.day)).toEqual(['2026-10-10', '2026-10-17', '2026-10-28']);
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
  const clef = async () => 'workers-ai/@cf/cloudflare/clef' as const;

  test("reads Clef's measured answer from the binding and from REST alike, and reports the tokens each counted", async () => {
    const spent: ModelCallReport[] = [];
    const report = (call: ModelCallReport) => { spent.push(call); };

    const { refusals } = noticesOf(createTestRuntime().rt);
    const binding = createDecisionPort({ run: async () => ({ ...CLEF_BINDING_ANSWER }), model: clef, report, refusals });
    const rest = createDecisionPort({ run: async () => CLEF_REST_ANSWER, model: clef, report, refusals });

    expect(await binding({ state: 's', questions: QUESTIONS })).toMatchObject({
      answers: { satisfaction: { type: 'score', score: 0.5407 }, corrected: { noul: 0.9722 }, wrong: { choice: 'misunderstood' } },
      usage: { input: 406, output: 0 },
    });
    expect(await rest({ state: 's', questions: QUESTIONS })).toMatchObject({
      answers: { satisfaction: { score: 0.3393 } }, usage: { input: 1802, output: 0 },
    });
    expect(spent).toEqual([
      { source: 'rating', spec: 'workers-ai/@cf/cloudflare/clef', usage: { input: 406, output: 0 } },
      { source: 'rating', spec: 'workers-ai/@cf/cloudflare/clef', usage: { input: 1802, output: 0 } },
    ]);
  });

  // `Ai.run` rereads its options from the shared binding after awaiting, so a raw-response call made meanwhile (the
  // binding's chat completions) hands a rating its Response, or that Response's body. The native suites logged "clef
  // streamed instead of answering" for a Response whose body was Clef's whole answer, as application/json.
  test("reads Clef's answer from every shape the binding can hand back, and a refusal in any of them as REST's", async () => {
    const answers = [
      () => ({ ...CLEF_BINDING_ANSWER }),
      () => Response.json(CLEF_BINDING_ANSWER),
      () => Response.json(CLEF_BINDING_ANSWER).body ?? new ReadableStream(),
    ];

    for (const answer of answers) {
      const port = createDecisionPort({
        run: bindingDecisionRun({ run: async () => answer() }), model: clef, report: () => {}, refusals: noticesOf(createTestRuntime().rt).refusals,
      });

      expect(await port({ state: 's', questions: QUESTIONS })).toMatchObject({ answers: { satisfaction: { score: 0.5407 } }, usage: { input: 406 } });
    }

    const refused = bindingDecisionRun({
      run: async () => Response.json({ errors: [{ message: 'You have used up your daily free allocation of 10,000 neurons.' }] }, { status: 429 }),
    });

    await expect(refused('@cf/cloudflare/clef', {})).rejects.toThrow('@cf/cloudflare/clef answered 429: You have used up your daily free allocation');
  });

  test("sends its model, state and questions, as Clef's published schema requires, and refuses an answer that skips a question", async () => {
    const bodies: unknown[] = [];

    const port = createDecisionPort({
      run: async (modelId, body) => {
        bodies.push({ modelId, keys: Object.keys(body), model: body['model'] });

        return { answers: { satisfaction: { type: 'score', score: 1 } }, usage: { input_tokens: 9, output_tokens: 0 } };
      },
      model: async () => 'workers-ai/@cf/cloudflare/clef-flash',
      report: () => {},
      refusals: noticesOf(createTestRuntime().rt).refusals,
    });

    await expect(port({ state: 's', questions: QUESTIONS })).rejects.toThrow('did not answer corrected, wrong');
    // Bare, as Workers AI's body schema requires; the full id is refused.
    expect(bodies).toEqual([{ modelId: '@cf/cloudflare/clef-flash', keys: ['model', 'state', 'questions'], model: 'clef-flash' }]);
  });

  test('a refusal only the owner can fix is said once, leaves the turn unrated, and fails no review', async () => {
    const { rt, stores } = createTestRuntime();
    const { refusals, said } = noticesOf(rt);
    let asked = 0;

    rt.decide = createDecisionPort({
      run: async () => {
        asked++;

        throw new KinuError('denied', '@cf/cloudflare/clef answered 403: Authentication error');
      },
      model: clef,
      report: () => {},
      refusals,
    });

    const engine = new EvolutionEngine(rt, historyTurnPairs(stores.history));
    await engine.reviewTurn(turn(), 'No, CSV.');
    await engine.reviewTurn({ ...turn(), turnId: 'u-2' }, 'Still JSON.');

    expect(asked).toBe(2);
    expect(listTurnRatings(rt.storage.sql, rt.actor)).toEqual([]);
    expect(said()).toEqual(['Your decision model is refusing requests. workers-ai/@cf/cloudflare/clef: '
      + '@cf/cloudflare/clef answered 403: Authentication error. Change it in Settings → Models.']);
  });

  test("a Workers AI allocation spent over REST is the owner's to fix: said once, the turn unrated, no review failed", async () => {
    const { rt, stores } = createTestRuntime();
    const { refusals, said } = noticesOf(rt);
    let asked = 0;

    rt.decide = createDecisionPort({
      run: restDecisionRun({
        getAuth: async () => ({ baseURL: 'https://api.cloudflare.com/client/v4/accounts/a/ai/v1', headers: {} }),
        fetch: asFetchFunction(async () => {
          asked++;

          return Response.json({ success: false, errors: [{ code: 3036, message: 'You have used up your daily free allocation of 10,000 neurons.' }] }, { status: 429 });
        }),
      }),
      model: clef,
      report: () => {},
      refusals,
    });

    const engine = new EvolutionEngine(rt, historyTurnPairs(stores.history));
    await engine.reviewTurn(turn(), 'No, CSV.');
    await engine.reviewTurn({ ...turn(), turnId: 'u-2' }, 'Still JSON.');

    expect(asked).toBe(2);
    expect(listTurnRatings(rt.storage.sql, rt.actor)).toEqual([]);
    expect(said()).toEqual(['Your decision model is refusing requests. workers-ai/@cf/cloudflare/clef: '
      + '@cf/cloudflare/clef answered 429: You have used up your daily free allocation of 10,000 neurons.. Change it in Settings → Models.']);
  });

  test('an owner tier named `decision` is said as a tier, never as the decision model', () => {
    const { rt } = createTestRuntime();
    const { refusals, said } = noticesOf(rt);

    refusals.refused({ tier: 'decision', since: 0, refusals: [{ model: 'openrouter/acme/m', cause: new KinuError('budget', 'acme answered 402') }] });

    expect(said()).toEqual(['Your decision tier is refusing requests. openrouter/acme/m: acme answered 402. Change it in Settings → Models.']);
  });

  test('a failure that may pass fails the review, for its retry', async () => {
    const { rt, stores } = createTestRuntime();

    rt.decide = createDecisionPort({
      run: async () => { throw new KinuError('unavailable', '@cf/cloudflare/clef answered 503'); },
      model: clef,
      report: () => {},
      refusals: noticesOf(rt).refusals,
    });

    await expect(new EvolutionEngine(rt, historyTurnPairs(stores.history)).reviewTurn(turn(), 'No, CSV.'))
      .rejects.toMatchObject({ code: 'unavailable', cause: { message: '@cf/cloudflare/clef answered 503' } });
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

      expect(await run('@cf/cloudflare/clef', { state: 's', questions: {} })).toEqual(CLEF_REST_ANSWER);
      expect(seen).toEqual([{ url: expected, auth: 'Bearer t' }]);
    }
  });

  // A Claude-only CLI: Clef refuses for want of Workers AI and its fast model was never measured, so no turn is rated
  // and no dream opens. `/refine` says so, in the owner's words, until either is fixed.
  test('where Clef refused and the fast tier is trusted for none of a rating, the owner is told why no turn is rated', () => {
    const { rt } = createTestRuntime();
    const { refusals } = noticesOf(rt);
    const refusing = { model: 'workers-ai/@cf/cloudflare/clef', cause: new KinuError('denied', 'This account has no Workers AI.') };

    refusals.untrusted({ model: 'claude/claude-never-measured', questions: ['satisfaction', 'corrected', 'wrong'] });
    expect(unratedReason(rt.actor.config, 'Settings → Models')).toBeNull();

    refusals.refused({ tier: DECISION_REFUSALS, since: 0, refusals: [refusing] });
    expect(unratedReason(rt.actor.config, 'Settings → Models')).toBe(
      'No turn is being rated, so no dream opens: Clef, the decision model, is refusing requests (its notice in Activity says why), and '
      + 'claude/claude-never-measured on your fast tier is not measured close enough to Clef to rate a turn in its place. Clef\'s access is set in Settings → Models.',
    );

    // A tier the owner named `untrusted` answering, or refusing, leaves the marker alone: no tier id can name its key.
    refusals.answered('untrusted');
    expect(unratedReason(rt.actor.config, 'Settings → Models')).not.toBeNull();

    refusals.untrusted(null);
    expect(unratedReason(rt.actor.config, 'Settings → Models')).toBeNull();
  });

  // Version skew: a peer from before `unrated` sends a listing without it, which still reads.
  test('a refinement listing from an older peer, with no unrated line, reads as nothing to say', () => {
    const older = { requests: [], debt: { turnIds: [], owed: false, key: '', summary: 'no new rated turns since the last dream' } };

    expect(v.parse(RefinementListingSchema, older)).toEqual({ ...older, unrated: null });
  });

  test("a refusal carries the provider's own words and the status's code", async () => {
    const run = (status: number) => restDecisionRun({
      getAuth: async () => ({ baseURL: 'https://kinu.run/api/user/ai/v1', headers: {} }),
      fetch: asFetchFunction(async () => Response.json({ errors: [{ message: 'No' }] }, { status })),
    })('@cf/cloudflare/clef', {});

    await expect(run(400)).rejects.toThrow('@cf/cloudflare/clef answered 400: No');
    await expect(run(403)).rejects.toMatchObject({ code: 'denied' });
    await expect(run(402)).rejects.toMatchObject({ code: 'denied' });
  });
});
