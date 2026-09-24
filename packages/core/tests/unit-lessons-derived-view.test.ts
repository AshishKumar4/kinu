// Lessons live only in the ledger, so wiping MEMORY.md hides nothing; observations
// are append-only and readers resolve one effective verdict per turn by source
// precedence, keeping the classifier row the calibration set labels by id.
import { describe, test, expect } from 'bun:test';
import { present, unobservedSpend } from '@kinu.run/test-utils';
import { createTestRuntime } from './helpers';
import { EvolutionEngine } from '../src/evolution/engine';
import type { CompletedTurn } from '../src/evolution/types';
import {
  recordTurnOutcome, recordOutcomeLabels, goldLabels, listLessons,
  renderRecentLessons, listTurnOutcomes,
  realOutcomeScaffoldRates, hasNegativeOutcome, initTurnOutcomeTables,
} from '../src/evolution/outcomes';
import { calibrationUniverse } from '../src/evolution/calibration';

const CLASSIFY = 'Classify what the follow-up reveals';

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
    const { rt, stores } = createTestRuntime({
      llmResponses: {
        [CLASSIFY]: '{"outcome":"corrected","confidence":0.9,"evidence":"test"}',
        'In one sentence': 'check the cluster name before rotating keys',
      },
    });

    const engine = new EvolutionEngine(rt, stores.history, { reportModelCall: unobservedSpend });

    // A lesson graded by the user's reply is born corroborated, as a ledger row.
    await engine.reviewTurn(makeTurn(), 'no — you rotated production, not staging');
    const lessons = listLessons(rt.storage.sql, rt.actor, { status: 'corroborated' });
    expect(lessons).toHaveLength(1);
    const lessonText = lessons[0].text;

    // Wipe the memory file plane, as a workspace reset does.
    await rt.storage.vfs.writeFile('memory/MEMORY.md', '');

    // 1. The prompt view still carries the lesson.
    expect(renderRecentLessons(rt.storage.sql, rt.actor)).toContain(lessonText);
    // 2. Search still finds it.
    expect(listLessons(rt.storage.sql, rt.actor, { status: 'corroborated' })
      .filter((lesson) => lesson.text.includes('cluster'))).toHaveLength(1);
    // 3. The session-reflection pass reads the same rows.
    recordTurnOutcome(rt.storage.sql, rt.actor, {
      turnId: 'msg-1', outcome: 'corrected', confidence: 0.9, source: 'explicit',
      userMessage: 'u', assistantResponse: 'a',
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

describe('S8 — an explicit verdict overrules the classifier without erasing it', () => {
  function setup() {
    const rt = createTestRuntime().rt;
    initTurnOutcomeTables(rt.storage.execRaw);

    return rt;
  }

  test('the effective reader resolves one verdict per turn, explicit wins', () => {
    const rt = setup();
    recordTurnOutcome(rt.storage.sql, rt.actor, {
      turnId: 't1', outcome: 'accepted', confidence: 0.9, source: 'classifier',
      userMessage: 'u', assistantResponse: 'a', scaffoldVersion: 3,
    });
    recordTurnOutcome(rt.storage.sql, rt.actor, {
      turnId: 't1', outcome: 'corrected', confidence: 1, source: 'explicit',
      userMessage: 'u', assistantResponse: 'a', scaffoldVersion: 3,
    });

    // One effective verdict per identified turn.
    const rows = listTurnOutcomes(rt.storage.sql, rt.actor);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ turnId: 't1', outcome: 'corrected', source: 'explicit' });
    // Downstream gates read the effective verdict too.
    expect(hasNegativeOutcome(rt.storage.sql, rt.actor, ['t1'])).toBe(true);
    const rates = realOutcomeScaffoldRates(rt.storage.sql, rt.actor);
    expect(rates.get(3)).toEqual({ accepted: 0, negative: 1 }); // counted once
  });

  test('calibration still addresses the classifier row its label was spent on', () => {
    const rt = setup();
    recordTurnOutcome(rt.storage.sql, rt.actor, {
      turnId: 't1', outcome: 'accepted', confidence: 0.9, source: 'classifier',
      userMessage: 'u', assistantResponse: 'a',
    });
    const [classifierRow] = listTurnOutcomes(rt.storage.sql, rt.actor, { outcomes: ['accepted'] });
    expect(classifierRow.source).toBe('classifier');

    // The gold label lands on that row, by id.
    const written = recordOutcomeLabels(rt.storage.sql, rt.actor, {
      labeler: 'owner', labels: [{ outcomeId: classifierRow.id, label: 'corrected' }],
    });

    expect(written).toBe(1);
    const gold = goldLabels(rt.storage.sql, rt.actor);
    expect(present(gold.get(classifierRow.id), 'the gold label for the classifier row').label).toBe('corrected');

    // The universe is classifier rows only, so a later explicit verdict neither dilutes nor deletes it.
    recordTurnOutcome(rt.storage.sql, rt.actor, {
      turnId: 't1', outcome: 'corrected', confidence: 1, source: 'explicit',
      userMessage: 'u', assistantResponse: 'a',
    });
    const universe = calibrationUniverse(rt.storage.sql, rt.actor);
    expect(universe.map(r => r.id)).toEqual([classifierRow.id]);
    expect(universe[0].predicted).toBe('accepted'); // what the model GUESSED
    expect(listLessons(rt.storage.sql, rt.actor)).toHaveLength(0); // untouched lane
  });
});
