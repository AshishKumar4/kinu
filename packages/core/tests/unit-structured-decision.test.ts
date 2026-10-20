/** Decisions over a chat model: one category a question through its structured output, each a fixed answer. */
import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { APICallError } from 'ai';
import { answerStructured, createStructuredDecider } from '../src/providers/structured-decision';
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
    refusals: { changes: () => 0, refused: () => {}, answered: () => {} },
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
  test('the fast tier answers nothing where no model it walks was measured', async () => {
    const decide = present(createStructuredDecider(ACTOR, lane({ 'openai/never-measured': scripted('{"corrected":"yes","satisfaction":"2","wrong":"nothing"}') }, [], 'openai/never-measured')), 'decider');

    expect(await decide({ state: 's', questions: QUESTIONS })).toBeUndefined();
  });

  // Muse's measured row clears triage's bar and not a rating's (what went wrong, 65% against 77.5%).
  test('a measured fallback answers the questions its row clears, and only those, from wherever it sits on the route', async () => {
    const asked: string[] = [];
    const muse = 'opencode-go/muse-spark-1.3-contributor';

    const decide = present(createStructuredDecider(ACTOR, lane({
      'openai/never-measured': scripted('{"worth":"no"}', { prompts: asked, formats: [] }),
      [muse]: scripted('{"worth":"yes"}'),
    }, [], 'openai/never-measured', [muse])), 'decider');

    expect(await decide({ state: 's', questions: { worth: { type: 'noul', instructions: 'Worth a look?' } } })).toMatchObject({ answers: { worth: { type: 'noul', noul: 0.9 } } });
    expect(await decide({ state: 's', questions: QUESTIONS })).toBeUndefined();
    expect(asked).toEqual([]);
  });
});

describe('the one decision port a host serves', () => {
  const answered = (by: string): DecisionResult => ({ answers: { worth: { type: 'choice', choice: by } }, usage: { input: 0, output: 0 } });
  const request = { state: 's', questions: { worth: { type: 'noul', instructions: 'Worth a look?' } } } as const;

  const clef = (reachable: boolean, asked: string[]) => ({
    port: (async () => {
      asked.push('clef');

      return reachable ? answered('clef') : null;
    }) satisfies DecisionPort,
    reachable: async () => reachable,
  });

  test('Clef where the account reaches Workers AI, the fast tier never asked', async () => {
    const asked: string[] = [];

    const decide = decisionPortOf({
      clef: clef(true, asked),
      structured: async () => {
        asked.push('fast');

        return answered('fast');
      },
    });

    expect(await decide?.(request)).toEqual(answered('clef'));
    expect(asked).toEqual(['clef']);
  });

  test('without Workers AI the trusted fast tier answers; untrusted, Clef says what to connect', async () => {
    const asked: string[] = [];

    expect(await decisionPortOf({ clef: clef(false, asked), structured: async () => answered('fast') })?.(request)).toEqual(answered('fast'));
    expect(asked).toEqual([]);
    expect(await decisionPortOf({ clef: clef(false, asked), structured: async () => undefined })?.(request)).toBeNull();
    expect(asked).toEqual(['clef']);
  });

  test('a host with no Clef answers nothing the fast tier is not trusted with, and a host with neither has no port', async () => {
    expect(await decisionPortOf({ clef: null, structured: async () => undefined })?.(request)).toBeNull();
    expect(decisionPortOf({ clef: null, structured: null })).toBeUndefined();
  });
});
