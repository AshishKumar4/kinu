/**
 * Turn-outcome signal pipeline — classification, the durable ledger, the
 * trivial-turn pre-filter, real-outcome scaffold rates, the GEPA eval split,
 * and the provisional-lesson corroboration mechanics.
 */
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw, createMockLLM } from './helpers.js';
import {
  isTrivialTurn, classifyTurnOutcome, outcomeToFeedback, outcomeQuality, feedbackToQuality,
  initTurnOutcomeTables, recordTurnOutcome, listTurnOutcomes, hasNegativeOutcome,
  realOutcomeScaffoldRates, blendRealOutcomeRates, buildOutcomeEvalSplit,
  recordLesson, listLessons, corroborateLessonsForTurn,
} from '../src/evolution/outcomes.js';
import type { ScaffoldArchiveEntry } from '../src/scaffold/archive.js';

function setup() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  initTurnOutcomeTables(makeExecRaw(db), sql);
  return { db, sql };
}

describe('isTrivialTurn — the LLM-call pre-filter', () => {
  const turn = (userMessage: string, toolCalls: Array<{ name: string; args: Record<string, unknown>; result: unknown }> = []) =>
    ({ userMessage, toolCalls });

  test('greetings and acknowledgements are trivial', () => {
    for (const msg of ['hi', 'Hey!', 'thanks', 'Thank you!!', 'ok', 'cool', 'good morning', 'bye']) {
      expect(isTrivialTurn(turn(msg))).toBe(true);
    }
  });

  test('real requests are not trivial, even short ones with a question', () => {
    expect(isTrivialTurn(turn('why?'))).toBe(false);
    expect(isTrivialTurn(turn('Refactor the auth module to use the new token store'))).toBe(false);
  });

  test('a turn that ran tools is never trivial', () => {
    expect(isTrivialTurn(turn('ok', [{ name: 'execute_tools', args: {}, result: 1 }]))).toBe(false);
  });
});

describe('classifyTurnOutcome — one cheap LLM call', () => {
  const input = {
    userMessage: 'Summarize the Q3 report',
    assistantResponse: 'Here is the summary: revenue up 12%...',
    followup: 'No — I asked for Q3, this is Q2 data. Redo it.',
  };

  test('parses a corrected verdict', async () => {
    const llm = createMockLLM({
      'Classify what the follow-up reveals': '{"outcome":"corrected","confidence":0.9,"evidence":"user re-asked with a fix"}',
    });
    const result = await classifyTurnOutcome(llm, input);
    expect(result).toEqual({ outcome: 'corrected', confidence: 0.9, evidence: 'user re-asked with a fix' });
  });

  test('parses accepted and frustrated; clamps confidence', async () => {
    const accepted = await classifyTurnOutcome(
      createMockLLM({ 'Classify': '{"outcome":"accepted","confidence":1.7,"evidence":"moved on"}' }), input);
    expect(accepted?.outcome).toBe('accepted');
    expect(accepted?.confidence).toBe(1);
    const frustrated = await classifyTurnOutcome(
      createMockLLM({ 'Classify': '{"outcome":"frustrated","confidence":0.8,"evidence":"explicit anger"}' }), input);
    expect(frustrated?.outcome).toBe('frustrated');
  });

  test('returns null on unusable output instead of guessing', async () => {
    expect(await classifyTurnOutcome(createMockLLM({ 'Classify': 'not json at all' }), input)).toBeNull();
    expect(await classifyTurnOutcome(createMockLLM({ 'Classify': '{"outcome":"sideways"}' }), input)).toBeNull();
  });
});

describe('outcome mappings', () => {
  test('outcomeToFeedback', () => {
    expect(outcomeToFeedback('accepted')).toBe('positive');
    expect(outcomeToFeedback('corrected')).toBe('negative');
    expect(outcomeToFeedback('frustrated')).toBe('negative');
    expect(outcomeToFeedback('abandoned')).toBeNull();
  });

  test('outcomeQuality ties to the explicit-feedback constants', () => {
    expect(outcomeQuality('accepted')).toBe(feedbackToQuality('positive'));
    expect(outcomeQuality('corrected')).toBe(feedbackToQuality('negative'));
    expect(outcomeQuality('frustrated')).toBeLessThan(outcomeQuality('corrected'));
    expect(outcomeQuality('abandoned')).toBe(0.5);
  });
});

describe('turn_outcomes ledger', () => {
  test('record + list, newest first', () => {
    const { sql } = setup();
    recordTurnOutcome(sql, {
      turnId: 'm1', outcome: 'accepted', confidence: 0.8, source: 'classifier',
      userMessage: 'task one', assistantResponse: 'answer one', now: 100,
    });
    recordTurnOutcome(sql, {
      turnId: 'm2', outcome: 'corrected', confidence: 0.9, source: 'classifier',
      userMessage: 'task two', assistantResponse: 'answer two', followup: 'no, fix it', now: 200,
    });
    const rows = listTurnOutcomes(sql);
    expect(rows.map((r) => r.turnId)).toEqual(['m2', 'm1']);
    expect(rows[0].followup).toBe('no, fix it');
    expect(listTurnOutcomes(sql, { outcomes: ['corrected', 'frustrated'] })).toHaveLength(1);
  });

  test('explicit feedback replaces the classifier verdict for the same turn', () => {
    const { sql } = setup();
    recordTurnOutcome(sql, {
      turnId: 'm1', outcome: 'accepted', confidence: 0.6, source: 'classifier',
      userMessage: 't', assistantResponse: 'a', now: 100,
    });
    recordTurnOutcome(sql, {
      turnId: 'm1', outcome: 'corrected', confidence: 1, source: 'explicit',
      userMessage: 't', assistantResponse: 'a', now: 200,
    });
    const rows = listTurnOutcomes(sql);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('corrected');
    expect(rows[0].source).toBe('explicit');
  });

  test('hasNegativeOutcome keys on the given turn ids', () => {
    const { sql } = setup();
    recordTurnOutcome(sql, { turnId: 'good', outcome: 'accepted', confidence: 1, source: 'classifier', userMessage: 't', assistantResponse: 'a' });
    recordTurnOutcome(sql, { turnId: 'bad', outcome: 'frustrated', confidence: 1, source: 'classifier', userMessage: 't', assistantResponse: 'a' });
    expect(hasNegativeOutcome(sql, ['good'])).toBe(false);
    expect(hasNegativeOutcome(sql, ['good', 'bad'])).toBe(true);
    expect(hasNegativeOutcome(sql, [])).toBe(false);
  });
});

describe('real-outcome scaffold rates (route into R2 archive priors)', () => {
  test('aggregates accepted/negative per serving version and blends into win-rates', () => {
    const { sql } = setup();
    for (let i = 0; i < 3; i++) {
      recordTurnOutcome(sql, { outcome: 'accepted', confidence: 1, source: 'classifier', userMessage: 't', assistantResponse: 'a', scaffoldVersion: 1 });
    }
    recordTurnOutcome(sql, { outcome: 'corrected', confidence: 1, source: 'classifier', userMessage: 't', assistantResponse: 'a', scaffoldVersion: 1 });
    recordTurnOutcome(sql, { outcome: 'abandoned', confidence: 1, source: 'session_end', userMessage: 't', assistantResponse: 'a', scaffoldVersion: 1 });

    const rates = realOutcomeScaffoldRates(sql);
    expect(rates.get(1)).toEqual({ accepted: 3, negative: 1 }); // abandoned is not decisive

    const entry: ScaffoldArchiveEntry = {
      version: 1, parentVersion: 0, status: 'historical', rationale: 'r', writtenAt: 0,
      trials: 2, wins: 1, losses: 1, ties: 0, winRate: 0.5,
    };
    const untouched: ScaffoldArchiveEntry = { ...entry, version: 2 };
    const [blended, same] = blendRealOutcomeRates([entry, untouched], rates);
    // (1 shadow win + 3 accepted) / (2 shadow decisive + 4 real decisive)
    expect(blended.winRate).toBeCloseTo(4 / 6);
    expect(blended.trials).toBe(6);
    expect(same).toEqual(untouched); // versions without real data pass through
    expect(entry.winRate).toBe(0.5); // pure — input not mutated
  });
});

describe('buildOutcomeEvalSplit — GEPA train/val discipline', () => {
  function seed(sql: ReturnType<typeof makeSql>, negatives: number, accepted: number) {
    for (let i = 0; i < negatives; i++) {
      recordTurnOutcome(sql, {
        turnId: `n${i}`, outcome: 'corrected', confidence: 1, source: 'classifier',
        userMessage: `fix task ${i}`, assistantResponse: `bad answer ${i}`, followup: `correction ${i}`, now: 1000 + i,
      });
    }
    for (let i = 0; i < accepted; i++) {
      recordTurnOutcome(sql, {
        turnId: `a${i}`, outcome: 'accepted', confidence: 1, source: 'classifier',
        userMessage: `good task ${i}`, assistantResponse: `good answer ${i}`, now: 2000 + i,
      });
    }
  }

  test('train = the negative set; val = negatives + accepted regression guards', () => {
    const { sql } = setup();
    seed(sql, 5, 5);
    const split = buildOutcomeEvalSplit(sql, 8);
    expect(split.train).toHaveLength(4); // ceil(8/2) negatives
    expect(split.val).toHaveLength(8);
    expect(split.train.every((i) => i.expected?.outcome === 'corrected')).toBe(true);
    expect(split.val.filter((i) => i.expected?.outcome === 'accepted')).toHaveLength(4);
    // The negative instances carry the user's correction for the metric.
    expect(split.train[0].expected?.followup).toContain('correction');
  });

  test('negatives backfill when accepted turns are scarce (and vice versa)', () => {
    const { sql } = setup();
    seed(sql, 6, 1);
    const split = buildOutcomeEvalSplit(sql, 6);
    expect(split.val).toHaveLength(6);
    expect(split.train).toHaveLength(5);
  });

  test('no negatives yet → train falls back to the accepted val set', () => {
    const { sql } = setup();
    seed(sql, 0, 3);
    const split = buildOutcomeEvalSplit(sql, 6);
    expect(split.val).toHaveLength(3);
    expect(split.train).toEqual(split.val);
  });

  test('empty ledger → empty split', () => {
    const { sql } = setup();
    const split = buildOutcomeEvalSplit(sql, 8);
    expect(split.val).toHaveLength(0);
    expect(split.train).toHaveLength(0);
  });
});

describe('lessons ledger — provisional until corroborated', () => {
  test('a negative outcome on a tied turn corroborates provisional lessons', () => {
    const { sql } = setup();
    recordLesson(sql, { turnIds: ['m7'], text: 'always check the year', source: 'turn_reflection', status: 'provisional' });
    recordLesson(sql, { turnIds: ['m8'], text: 'unrelated lesson', source: 'turn_reflection', status: 'provisional' });

    const upgraded = corroborateLessonsForTurn(sql, 'm7', 999);
    expect(upgraded).toHaveLength(1);
    expect(upgraded[0].text).toBe('always check the year');
    expect(upgraded[0].status).toBe('corroborated');

    expect(listLessons(sql, { status: 'corroborated' })).toHaveLength(1);
    expect(listLessons(sql, { status: 'provisional' })).toHaveLength(1);
    // Idempotent: a second negative on the same turn upgrades nothing new.
    expect(corroborateLessonsForTurn(sql, 'm7')).toHaveLength(0);
  });

  test('session lessons tied to a window corroborate from any window turn', () => {
    const { sql } = setup();
    recordLesson(sql, { turnIds: ['t1', 't2', 't3'], text: 'window pattern', source: 'session_reflection', status: 'provisional' });
    expect(corroborateLessonsForTurn(sql, 't2')).toHaveLength(1);
  });
});
