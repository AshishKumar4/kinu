/** Decisions over a chat model: one category a question through its structured output, each a fixed answer. */
import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { APICallError } from 'ai';
import { answerStructured, createStructuredDecider } from '../src/evolution/structured-decision';
import { decisionPortOf, type DecisionPort, type DecisionQuestion, type DecisionResult } from '../src/providers/decision-model';
import type { ModelRouteResolution } from '../src/profiles/model-route';
import { routedLlm, type ModelLaneComponents } from '../src/profiles/model-lane';
import { profileCatalogDigest, resolveTurnProfile } from '../src/profiles';
import type { ModelCallReport } from '../src/events/model-call';
import { rateTurn } from '../src/evolution/ratings';
import { present } from '@kinu.run/test-utils';

/** What a scripted model was sent: each prompt, and the response format it was asked for. */
interface Seen {
  readonly prompts: string[];
  readonly formats: string[];
}

/** A model that answers `text`, recording what it was sent. */
function scripted(text: string, seen: Seen = { prompts: [], formats: [] }) {
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      seen.prompts.push(JSON.stringify(options.prompt));
      seen.formats.push(options.responseFormat?.type ?? 'text');

      return {
        content: [{ type: 'text' as const, text }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: { inputTokens: { total: 11, noCache: 11, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 3, text: 3, reasoning: undefined } },
        warnings: [],
      };
    },
  });
}

/** A model that refuses as a spent allowance does: a refusal only the owner can fix. */
function spent() {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new APICallError({ message: 'insufficient balance', url: 'https://api.example/v1', requestBodyValues: {}, statusCode: 402, isRetryable: false });
    },
  });
}

const QUESTIONS = {
  corrected: { type: 'noul', instructions: 'Did the reply correct the turn?' },
  satisfaction: { type: 'score', instructions: 'How satisfied is the user?', criteria: ['unhappy', 'neutral', 'happy'] },
  wrong: { type: 'choice', instructions: 'What went wrong?', criteria: { nothing: 'Nothing', incorrect: 'A wrong result' } },
} satisfies Readonly<Record<string, DecisionQuestion>>;

const route = (model: string, fallbacks: readonly string[] = []): ModelRouteResolution => ({
  source: 'fast', tier: 'fast', model, reasoningEffort: null, fallbacks: fallbacks.map((spec) => ({ model: spec, reasoningEffort: null })), retries: 0,
});

/** The routed lane a host builds: each model on the route bound, billed to `reports`; the fast tier is `fast`. */
function lane(models: Readonly<Record<string, MockLanguageModelV3>>, reports: ModelCallReport[] = [], fast = 'openai/gpt-6-luna', fallbacks: readonly string[] = []): ModelLaneComponents {
  const tiers = { default: { model: 'openai/gpt-6-luna' }, fast: { model: fast } };
  const catalog = { roles: {}, tiers, ...(fallbacks.length > 0 && { modelFallbacks: { [fast]: [...fallbacks] } }) };

  return {
    refusals: { changes: () => 0, refused: () => {}, answered: () => {}, untrusted: () => {} },
    llm: (walked) => routedLlm((serving) => ({ model: present(models[serving.model], serving.model) }), walked, { report: (row) => { reports.push(row); } }),
    resolveProfile: async () => resolveTurnProfile({
      envelope: { authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog },
      provider: { revision: 'r', availableModels: [...new Set(['openai/gpt-6-luna', fast, ...fallbacks])] },
      roleId: 'task', workMode: 'build', availableTools: [], activeSkills: [],
    }),
  };
}

const ACTOR = { actorId: 'actor-test', workspaceId: 'ws-test', parentActorId: null };

describe('a chat model answering decisions', () => {
  test('each question takes one allowed category, through the structured output, read as its fixed answer and billed to the route', async () => {
    const seen: Seen = { prompts: [], formats: [] };
    const reports: ModelCallReport[] = [];
    const model = scripted('{"corrected":"unclear","satisfaction":"2","wrong":"incorrect"}', seen);

    const decided = await answerStructured(lane({ 'openai/gpt-6-luna': model }, reports), route('openai/gpt-6-luna'), { state: 'THE TURN', questions: QUESTIONS });

    expect(decided?.answers).toEqual({ corrected: { type: 'noul', noul: 0.4 }, satisfaction: { type: 'score', score: 2 }, wrong: { type: 'choice', choice: 'incorrect' } });
    expect(seen.formats).toEqual(['json']);

    // The model reads the state, each question and each category it may answer.
    for (const read of ['THE TURN', 'How satisfied is the user?', 'unhappy', 'What went wrong?', 'A wrong result']) expect(seen.prompts[0]).toContain(read);
    expect(reports.map(({ source, spec, usage }) => ({ source, spec, usage }))).toEqual([{ source: 'fast', spec: 'openai/gpt-6-luna', usage: expect.objectContaining({ input: 11, output: 3 }) }]);
  });

  test('an answer off the list, or a question left out, is refused rather than guessed', async () => {
    for (const answer of ['{"corrected":"maybe","satisfaction":"0","wrong":"nothing"}', '{"corrected":"no","wrong":"nothing"}', 'no JSON here']) {
      await expect(answerStructured(lane({ 'openai/gpt-6-luna': scripted(answer) }), route('openai/gpt-6-luna'), { state: 's', questions: QUESTIONS }))
        .rejects.toMatchObject({ code: 'bad_input' });
    }
  });

  test('a refusal only the owner can fix answers nothing, after the next model on the route was tried', async () => {
    const models = { 'openai/gpt-6-luna': spent(), 'anthropic/claude-haiku-5-5': spent() };

    expect(await answerStructured(lane(models), route('openai/gpt-6-luna', ['anthropic/claude-haiku-5-5']), { state: 's', questions: QUESTIONS })).toBeNull();
  });

  test("the production rater reads its answers as it reads Clef's", async () => {
    const model = scripted('{"satisfaction":"1","corrected":"yes","wrong":"misunderstood"}');
    const decide = (request: Parameters<typeof answerStructured>[2]) => answerStructured(lane({ 'openai/gpt-6-luna': model }), route('openai/gpt-6-luna'), request);

    expect(await rateTurn(decide, { request: 'use staging', actions: '', answer: 'used production', followup: 'no, staging' }, 0))
      .toEqual({ score: 2, corrected: 0.9, wrong: 'misunderstood', rejects: null });
  });

  // An unmeasured model's answers were never compared with Clef's: none of them is used.
  test('the fast tier answers nothing where no model it walks was measured, and keeps which, until a rating is answered', async () => {
    const kept: unknown[] = [];

    const keeping = (built: ModelLaneComponents): ModelLaneComponents => ({ ...built, refusals: { ...present(built.refusals, 'refusals'), untrusted: (asked) => { kept.push(asked); } } });
    const rating = { satisfaction: QUESTIONS.satisfaction, corrected: QUESTIONS.corrected, wrong: { type: 'choice', instructions: 'What went wrong?', criteria: { nothing: 'Nothing', misunderstood: 'Misread' } } } as const;
    const untrusted = keeping(lane({ 'openai/never-measured': scripted('{}') }, [], 'openai/never-measured'));
    const muse = 'opencode-go/muse-spark-1.3-contributor';

    expect(await createStructuredDecider(ACTOR, untrusted)({ state: 's', questions: rating })).toBeUndefined();
    // A triage Muse is trusted for says nothing of ratings, which it still cannot answer: the marker stays.
    await createStructuredDecider(ACTOR, keeping(lane({ [muse]: scripted('{"worth":"yes"}') }, [], muse)))({ state: 's', questions: { worth: { type: 'noul', instructions: 'Worth a look?' } } });
    expect(kept).toEqual([{ model: 'openai/never-measured', questions: ['satisfaction', 'corrected', 'wrong'] }]);
  });

  // Muse's measured row clears triage's bar and not a rating's (what went wrong, 65% against 77.5%).
  test('a measured fallback answers the questions its row clears, and only those, from wherever it sits on the route', async () => {
    const asked: string[] = [];
    const muse = 'opencode-go/muse-spark-1.3-contributor';

    const decide = createStructuredDecider(ACTOR, lane({
      'openai/never-measured': scripted('{"worth":"no"}', { prompts: asked, formats: [] }),
      [muse]: scripted('{"worth":"yes"}'),
    }, [], 'openai/never-measured', [muse]));

    expect(await decide({ state: 's', questions: { worth: { type: 'noul', instructions: 'Worth a look?' } } })).toMatchObject({ answers: { worth: { type: 'noul', noul: 0.9 } } });
    expect(await decide({ state: 's', questions: QUESTIONS })).toBeUndefined();
    expect(asked).toEqual([]);
  });
});

describe('the one decision port a host serves', () => {
  const answered = (by: string): DecisionResult => ({ answers: { worth: { type: 'choice', choice: by } }, usage: { input: 0, output: 0 } });
  const request = { state: 's', questions: { worth: { type: 'noul', instructions: 'Worth a look?' } } } as const;

  /** Clef answering, or refusing as an account without Workers AI does: said to the owner, then null. */
  const clef = (reaches: boolean, asked: string[]): DecisionPort => async () => {
    asked.push(reaches ? 'clef' : 'clef refused, said');

    return reaches ? answered('clef') : null;
  };

  const fast = (asked: string[], trusted: boolean) => async () => {
    asked.push('fast');

    return trusted ? answered('fast') : undefined;
  };

  test('Clef answers where it can, and the fast tier is never asked', async () => {
    const asked: string[] = [];

    expect(await decisionPortOf(clef(true, asked), fast(asked, true))(request)).toEqual(answered('clef'));
    expect(asked).toEqual(['clef']);
  });

  // Every null a consumer reads was said to the owner: Clef's refusal says what to connect.
  test('where Clef refused, the trusted fast tier answers; untrusted, Clef\'s refusal stands', async () => {
    const asked: string[] = [];

    expect(await decisionPortOf(clef(false, asked), fast(asked, true))(request)).toEqual(answered('fast'));
    expect(await decisionPortOf(clef(false, asked), fast(asked, false))(request)).toBeNull();
    expect(asked).toEqual(['clef refused, said', 'fast', 'clef refused, said', 'fast']);
  });
});
