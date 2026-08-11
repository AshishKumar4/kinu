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
  executionVerdict, executionVerdictOutcome, isUserVerdictSource, isPureLookupCall,
  initTurnOutcomeTables, recordTurnOutcome, listTurnOutcomes, hasNegativeOutcome,
  realOutcomeScaffoldRates, blendRealOutcomeRates, buildOutcomeEvalSplit,
  describeSplitDegeneracy,
  recordLesson, listLessons, corroborateLessonsForTurn,
} from '../src/evolution/outcomes.js';
import type { ScaffoldArchiveEntry } from '../src/scaffold/archive.js';
import { initRunEventTables, RunEventRecorder } from '../src/events/recorder.js';

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

// The pre-take_pick production DDL (CHECK lacks the 'take_pick' source).
const LEGACY_DDL = `(
    id TEXT PRIMARY KEY,
    turn_id TEXT,
    session_id TEXT NOT NULL DEFAULT 'default',
    outcome TEXT NOT NULL CHECK (outcome IN ('accepted','corrected','frustrated','abandoned')),
    confidence REAL NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('explicit','classifier','session_end')),
    user_message TEXT NOT NULL,
    assistant_response TEXT NOT NULL,
    followup TEXT,
    scaffold_version INTEGER,
    created_at INTEGER NOT NULL
  )`;

function legacyRow(db: Database, id: string) {
  db.exec(`INSERT INTO ${id.startsWith('legacy:') ? 'turn_outcomes_legacy' : 'turn_outcomes'}
    (id, turn_id, outcome, confidence, source, user_message, assistant_response, created_at)
    VALUES ('${id}', 't-${id}', 'accepted', 0.8, 'classifier', 'u', 'a', 100)`);
}

describe('executionVerdict — the environment\'s verdict, read symmetrically', () => {
  const turn = (over: Partial<{ hadError: boolean; toolCalls: Array<{ name: string; args: Record<string, unknown>; result: unknown }> }> = {}) =>
    ({ hadError: false, toolCalls: [{ name: 'run', args: { command: 'make' }, result: 'ok' }], ...over });

  test('a turn that acted on the world and finished clean SUCCEEDED', () => {
    expect(executionVerdict(turn())).toBe('succeeded');
    expect(executionVerdictOutcome('succeeded')).toBe('accepted');
  });

  test('a turn that errored FAILED', () => {
    expect(executionVerdict(turn({ hadError: true }))).toBe('failed');
    expect(executionVerdictOutcome('failed')).toBe('corrected');
  });

  test('a turn that never acted has NO verdict — silence is not success', () => {
    expect(executionVerdict(turn({ toolCalls: [] }))).toBeNull();
    // …and neither is an errorless turn that only read state.
    expect(executionVerdict(turn({
      toolCalls: [{ name: 'memory', args: { action: 'search' }, result: [] }],
    }))).toBeNull();
  });

  test('an errored turn that never acted still has no verdict to record', () => {
    expect(executionVerdict({ hadError: true, toolCalls: [] })).toBeNull();
  });

  test('pure-lookup calls are the one definition, shared with the extractor', () => {
    expect(isPureLookupCall({ name: 'memory', args: { action: 'search' } })).toBe(true);
    expect(isPureLookupCall({ name: 'fact', args: { action: 'recall' } })).toBe(true);
    expect(isPureLookupCall({ name: 'memory', args: { action: 'append' } })).toBe(false);
    expect(isPureLookupCall({ name: 'run', args: {} })).toBe(false);
  });
});

describe('execution-sourced rows are priced and labelled as proxies', () => {
  test('an execution verdict never reaches a user verdict\'s poles', () => {
    expect(outcomeQuality('accepted', 'execution')).toBeLessThan(outcomeQuality('accepted', 'explicit'));
    expect(outcomeQuality('accepted', 'execution')).toBeGreaterThan(0.5);
    expect(outcomeQuality('corrected', 'execution')).toBeGreaterThan(outcomeQuality('corrected', 'explicit'));
    expect(outcomeQuality('corrected', 'execution')).toBeLessThan(0.5);
  });

  test('the user-verdict sources are every source but execution', () => {
    for (const source of ['explicit', 'classifier', 'session_end', 'take_pick'] as const) {
      expect(isUserVerdictSource(source)).toBe(true);
    }
    expect(isUserVerdictSource('execution')).toBe(false);
  });

  test('user-verdict quality is untouched by the new source parameter', () => {
    expect(outcomeQuality('accepted')).toBe(0.9);
    expect(outcomeQuality('corrected')).toBe(0.2);
    expect(outcomeQuality('frustrated')).toBe(0.1);
    expect(outcomeQuality('abandoned')).toBe(0.5);
    expect(outcomeQuality('abandoned', 'execution')).toBe(0.5);
  });
});

describe('turn_outcomes CHECK-widening rebuild', () => {
  test('rebuilds the legacy CHECK in place, keeping rows, and accepts take_pick after', () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    db.exec(`CREATE TABLE turn_outcomes ${LEGACY_DDL}`);
    legacyRow(db, 'old-1');
    expect(() => recordTurnOutcome(sql, {
      turnId: 'x', outcome: 'accepted', confidence: 1, source: 'take_pick',
      userMessage: 'u', assistantResponse: 'a',
    })).toThrow();

    initTurnOutcomeTables(makeExecRaw(db), sql);
    expect(listTurnOutcomes(sql).map((r) => r.id)).toEqual(['old-1']);
    recordTurnOutcome(sql, {
      turnId: 'x', outcome: 'accepted', confidence: 1, source: 'take_pick',
      userMessage: 'u', assistantResponse: 'a', now: 200,
    });
    expect(listTurnOutcomes(sql)).toHaveLength(2);
    // Idempotent re-run.
    initTurnOutcomeTables(makeExecRaw(db), sql);
    expect(listTurnOutcomes(sql)).toHaveLength(2);
  });

  test('self-heals a crash after RENAME: stranded legacy rows are recovered, not orphaned', () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    // Crash point: RENAME succeeded, CREATE never ran — only the legacy
    // table exists. A bare CREATE IF NOT EXISTS would start an empty ledger.
    db.exec(`CREATE TABLE turn_outcomes_legacy ${LEGACY_DDL}`);
    legacyRow(db, 'legacy:1');
    legacyRow(db, 'legacy:2');

    initTurnOutcomeTables(makeExecRaw(db), sql);
    expect(listTurnOutcomes(sql).map((r) => r.id).sort()).toEqual(['legacy:1', 'legacy:2']);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'turn_outcomes_legacy'`).all()).toHaveLength(0);
  });

  test('self-heals a crash after the copy but before DROP: no duplicates', () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    const execRaw = makeExecRaw(db);
    db.exec(`CREATE TABLE turn_outcomes_legacy ${LEGACY_DDL}`);
    legacyRow(db, 'legacy:1');
    initTurnOutcomeTables(execRaw, sql); // creates the new table + copies
    // Re-create the crash state: legacy still present alongside copied rows.
    db.exec(`CREATE TABLE turn_outcomes_legacy ${LEGACY_DDL}`);
    db.exec(`INSERT INTO turn_outcomes_legacy SELECT * FROM turn_outcomes`);

    initTurnOutcomeTables(execRaw, sql);
    expect(listTurnOutcomes(sql)).toHaveLength(1);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'turn_outcomes_legacy'`).all()).toHaveLength(0);
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

  test('a rare outcome buried under many newer rows is still returned', () => {
    const { sql } = setup();
    // The failures the optimizer learns from, followed by far more accepted
    // turns than any candidate window: a JS-side filter over a bounded window
    // drops them silently, which truncates the whole evolution signal.
    for (let i = 0; i < 3; i++) {
      recordTurnOutcome(sql, {
        turnId: `neg${i}`, outcome: 'corrected', confidence: 1, source: 'classifier',
        userMessage: 'fix', assistantResponse: 'wrong', now: 1000 + i,
      });
    }
    for (let i = 0; i < 500; i++) {
      recordTurnOutcome(sql, {
        turnId: `pos${i}`, outcome: 'accepted', confidence: 1, source: 'classifier',
        userMessage: 'ok', assistantResponse: 'fine', now: 2000 + i,
      });
    }
    expect(listTurnOutcomes(sql, { limit: 10, outcomes: ['corrected', 'frustrated'] })
      .map((r) => r.turnId)).toEqual(['neg2', 'neg1', 'neg0']);
    // The limit now bounds the rows actually wanted, not a pre-filter window.
    expect(listTurnOutcomes(sql, { limit: 4, outcomes: ['accepted'] })).toHaveLength(4);
    expect(listTurnOutcomes(sql, { limit: 2 }).map((r) => r.turnId)).toEqual(['pos499', 'pos498']);
    expect(listTurnOutcomes(sql, { outcomes: [] })).toEqual([]);
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
      version: 1, parentVersion: 0, status: 'historical', rationale: 'r', pathology: null, writtenAt: 0,
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

describe('buildOutcomeEvalSplit — GEPA train/val discipline (disjoint)', () => {
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

  /** The turn each instance came from — the identity that must not appear on
   *  both sides of the split. */
  const turnOf = (instance: { id: string }) => instance.id.split('-').slice(2).join('-');

  test('train = failures to fix; val = HELD-OUT failures + accepted guards, with no overlap', () => {
    const { sql } = setup();
    seed(sql, 5, 5);
    const split = buildOutcomeEvalSplit(sql, 8);

    // Budget 8 → 4 failures drawn, of which round(4/3) = 1 is held out.
    expect(split.train).toHaveLength(3);
    expect(split.val).toHaveLength(5);
    expect(split.heldOutNegatives).toBe(1);
    expect(split.degeneracy).toBeNull();

    expect(split.train.every((i) => i.expected?.outcome === 'corrected')).toBe(true);
    // The negative instances carry the user's correction for the metric.
    expect(split.train[0].expected?.followup).toContain('correction');

    // Accepted turns stay in val as regression guards.
    expect(split.val.filter((i) => i.expected?.outcome === 'accepted')).toHaveLength(4);
    // …and the one failure in val was never trained on.
    const heldOut = split.val.filter((i) => i.expected?.outcome === 'corrected');
    expect(heldOut).toHaveLength(1);

    const trainTurns = new Set(split.train.map(turnOf));
    expect(split.val.filter((i) => trainTurns.has(turnOf(i)))).toEqual([]);
  });

  test('failures far older than the accepted rows still reach train/val', () => {
    const { sql } = setup();
    seed(sql, 5, 0);
    // The optimizer's targets are the OLDEST rows here. A bounded pre-filter
    // window would leave the split with nothing to optimize toward.
    for (let i = 0; i < 400; i++) {
      recordTurnOutcome(sql, {
        turnId: `a${i}`, outcome: 'accepted', confidence: 1, source: 'classifier',
        userMessage: 'ok', assistantResponse: 'fine', now: 5000 + i,
      });
    }
    const split = buildOutcomeEvalSplit(sql, 8);
    expect(split.degeneracy).toBeNull();
    expect(split.train).toHaveLength(3);
    expect(split.heldOutNegatives).toBe(1);
  });

  test('no instance is ever on both sides, across every budget', () => {
    const { sql } = setup();
    seed(sql, 9, 9);
    for (const budget of [2, 3, 4, 5, 6, 8, 12, 18, 24]) {
      const split = buildOutcomeEvalSplit(sql, budget);
      const trainTurns = new Set(split.train.map(turnOf));
      expect(split.val.some((i) => trainTurns.has(turnOf(i)))).toBe(false);
      expect(split.heldOutNegatives)
        .toBe(split.val.filter((i) => i.expected?.outcome !== 'accepted').length);
    }
  });

  test('instances carry process evidence reconstructed from the existing run ledger', () => {
    const { db, sql } = setup();
    initRunEventTables(makeExecRaw(db));
    db.exec(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, parent_id TEXT, content TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
    const now = Date.now();
    sql`INSERT INTO messages (id, parent_id, content, created_at)
        VALUES (${'u0'}, ${null}, ${'fix task 0'}, ${now - 1_000})`;
    sql`INSERT INTO messages (id, parent_id, content, created_at)
        VALUES (${'n0'}, ${'u0'}, ${'bad answer 0'}, ${now + 1_000})`;
    const recorder = new RunEventRecorder(sql);
    recorder.emit('run-1', { type: 'run_start', agentId: 'agent', caused_by: 'chat', userMessage: 'fix task 0' });
    recorder.emit('run-1', { type: 'step_finish', stepIndex: 1 });
    recorder.emit('run-1', { type: 'tool_call_end', name: 'team', toolCallId: 'tc-1', result: 'spawned' });
    recorder.emit('run-1', { type: 'step_finish', stepIndex: 2 });
    recorder.emit('run-1', { type: 'tool_call_end', name: 'execute_tools', toolCallId: 'tc-2', result: 'done' });
    recorder.emit('run-1', { type: 'run_end', reason: 'completed' });
    seed(sql, 1, 0);

    const instance = buildOutcomeEvalSplit(sql, 2).train[0];
    expect(instance.evidence).toContain('Outcome: corrected');
    expect(instance.evidence).toContain(
      'Turn process: 2 sequential steps, 1 staffing, 0 fork, 0 messaging, 1 execute_tools',
    );
  });

  test('negatives backfill when accepted turns are scarce (and vice versa)', () => {
    const { sql } = setup();
    seed(sql, 6, 1);
    // 5 failures drawn (backfilling the 2 the accepted pool can't cover) →
    // round(5/3) = 2 held out, 3 to train on, plus the 1 accepted guard.
    const split = buildOutcomeEvalSplit(sql, 6);
    expect(split.train).toHaveLength(3);
    expect(split.val).toHaveLength(3);
    expect(split.heldOutNegatives).toBe(2);
    expect(split.degeneracy).toBeNull();
  });

  test('the newest failures are the held-out ones — a forward-in-time holdout', () => {
    const { sql } = setup();
    seed(sql, 4, 0); // recorded oldest-first: "fix task 0" … "fix task 3"
    const split = buildOutcomeEvalSplit(sql, 8);
    expect(split.val.map((i) => i.input)).toEqual(['fix task 3']);
    expect(split.train.map((i) => i.input)).toEqual(['fix task 2', 'fix task 1', 'fix task 0']);
  });

  test('a single failure cannot be held out — the split says so instead of overlapping', () => {
    const { sql } = setup();
    seed(sql, 1, 3);
    const split = buildOutcomeEvalSplit(sql, 8);
    expect(split.train).toHaveLength(1);
    expect(split.heldOutNegatives).toBe(0);
    expect(split.val.every((i) => i.expected?.outcome === 'accepted')).toBe(true);
    expect(split.degeneracy).toBe('no_held_out_negatives');
    expect(describeSplitDegeneracy(split.degeneracy!)).toContain('not evidence');
  });

  test('no negatives yet → empty train set, flagged (never the accepted set)', () => {
    const { sql } = setup();
    seed(sql, 0, 3);
    const split = buildOutcomeEvalSplit(sql, 6);
    expect(split.val).toHaveLength(3);
    expect(split.train).toHaveLength(0);
    expect(split.heldOutNegatives).toBe(0);
    expect(split.degeneracy).toBe('no_negatives');
  });

  test('empty ledger → empty split, flagged', () => {
    const { sql } = setup();
    const split = buildOutcomeEvalSplit(sql, 8);
    expect(split.val).toHaveLength(0);
    expect(split.train).toHaveLength(0);
    expect(split.degeneracy).toBe('no_labeled_turns');
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
