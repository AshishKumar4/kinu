import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
// Lessons live only in the ledger, so wiping MEMORY.md hides nothing; ratings
// are append-only and readers resolve one effective rating per turn by source
// precedence, keeping the model's row beneath the user's.
import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers';
import { EvolutionEngine } from '../src/evolution/engine';
import type { CompletedTurn } from '../src/evolution/types';
import { listLessons, renderRecentLessons } from '../src/evolution/lessons';
import { hasLowRating, listTurnRatings, realRatingScaffoldRates, recordTurnRating } from '../src/evolution/ratings';

function makeTurn(overrides: Partial<CompletedTurn> = {}): CompletedTurn {
  return {
    userMessage: 'rotate the API keys',
    assistantResponse: 'rotated staging keys',
    toolCalls: [],
    steps: 2,
    durationMs: 1_000,
    feedback: null,
    hadError: false,
    turnId: 'msg-1',
    sessionId: 'default',
    origin: 'user',
    ...overrides,
  };
}

describe('S5 — the corroborated lessons view survives a MEMORY.md reset', () => {
  test('prompt tail, search and session reflection all derive from the ledger', async () => {
    const { rt, stores } = createTestRuntime({ llmResponses: { 'In one sentence': 'check the cluster name before rotating keys' } });
    rt.decide = async () => ({ answers: {
      satisfaction: { type: 'score', score: 0.5 }, corrected: { type: 'noul', noul: 0.95 },
      wrong: { type: 'choice', choice: 'misunderstood' },
    }, usage: { input: 0, output: 0 } });

    const engine = new EvolutionEngine(rt, stores.history);

    // A lesson rated by the user's reply is born corroborated, as a ledger row.
    await engine.reviewTurn(makeTurn(), 'no — you rotated production, not staging');
    const lessons = listLessons(rt.storage.sql, rt.actor, { status: 'corroborated' });
    expect(lessons).toHaveLength(1);
    const lessonText = lessons[0].text;

    // Wipe the memory file plane, as a workspace reset does.
    await writeText(rt.storage.vfs, 'memory/MEMORY.md', '');

    // 1. The prompt view still carries the lesson.
    expect(renderRecentLessons(rt.storage.sql, rt.actor)).toContain(lessonText);
    // 2. Search still finds it.
    expect(listLessons(rt.storage.sql, rt.actor, { status: 'corroborated' })
      .filter((lesson) => lesson.text.includes('cluster'))).toHaveLength(1);
    // 3. The session-reflection pass reads the same rows.
    recordTurnRating(rt.storage.sql, rt.actor, {
      turnId: 'msg-1', score: 1, corrected: 1, wrong: null, source: 'thumbs', request: 'u', answer: 'a',
    });
    const prompts: string[] = [];
    const complete = rt.llm.complete.bind(rt.llm);
    rt.llm.complete = async (prompt: string) => {
      prompts.push(prompt);

      return complete(prompt);
    };

    await engine.onSessionComplete({
      sessionId: 'default', startedAt: Date.now() - 60_000, endedAt: Date.now(),
      turns: [makeTurn(), makeTurn({ turnId: 'msg-2' }), makeTurn({ turnId: 'msg-3' })],
    });
    const reflectionPrompt = prompts.find(p => p.includes('reflecting on your recent interactions')) ?? '';
    expect(reflectionPrompt).toContain('check the cluster name before rotating keys');
    // Nothing re-created a MEMORY.md copy.
    const memory = await rt.memory.read('memory/MEMORY.md');
    expect((memory ?? '')).not.toContain(lessonText);
  });
});

describe("S8 — the user's rating overrules the model's without erasing it", () => {
  test('the effective reader resolves one rating per turn, the thumb wins', () => {
    const { rt } = createTestRuntime();
    recordTurnRating(rt.storage.sql, rt.actor, {
      turnId: 't1', score: 4.5, corrected: 0, wrong: 'nothing', source: 'model', request: 'u', answer: 'a', scaffoldVersion: 3,
    });
    recordTurnRating(rt.storage.sql, rt.actor, {
      turnId: 't1', score: 1, corrected: 1, wrong: null, source: 'thumbs', request: 'u', answer: 'a', scaffoldVersion: 3,
    });

    // One effective rating per turn; the model's row stays beneath it.
    expect(listTurnRatings(rt.storage.sql, rt.actor)).toMatchObject([{ turnId: 't1', score: 1, source: 'thumbs' }]);
    expect(rt.storage.sql<{ n: number }>`SELECT COUNT(*) AS n FROM turn_ratings`[0]?.n).toBe(2);
    // Downstream gates read the effective rating too.
    expect(hasLowRating(rt.storage.sql, rt.actor, ['t1'])).toBe(true);
    expect(realRatingScaffoldRates(rt.storage.sql, rt.actor).get(3)).toEqual({ accepted: 0, negative: 1 }); // counted once
  });
});
