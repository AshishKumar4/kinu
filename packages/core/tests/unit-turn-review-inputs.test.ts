/**
 * What the turn review reads besides the rating itself: the trivial-turn pre-filter, rated scaffold rates, the
 * GEPA eval split over rated turns, and the provisional-lesson corroboration mechanics.
 */
import { describe, test, expect } from 'bun:test';
import { makeSql, createTestActor, createTestWorkspace } from './helpers';
import type { ActorHandle } from '../src/identity/actor-handle';
import { recordLesson, listLessons, corroborateLessonsForTurn } from '../src/evolution/lessons';
import {
  isTrivialTurn, realRatingScaffoldRates, recordTurnRating, type RecordTurnRatingInput,
} from '../src/evolution/ratings';
import { buildOutcomeEvalSplit, describeSplitDegeneracy } from '../src/evolution/eval-split';
import { SessionHistory } from '../src/session/history';
import { CHAT_SESSION_ID } from '../src/session/transcript-schema';
import { blendRealOutcomeRates, type ScaffoldArchiveEntry } from '../src/scaffold/archive';
import { RunEventRecorder } from '../src/events/recorder';
import type { ToolCallRecord } from '../src/evolution/types';
import { seedTranscriptEntry, present } from '@kinu.run/test-utils';

/** The production schema: the eval split reads the message and run-event ledgers too. */
function setup() {
  const ws = createTestWorkspace();

  // A real workspace actor, since `conversationTurnPair` scopes transcript entries by `actor_id`.
  const actor = createTestActor(ws.sql, ws.execRaw, 'ws-outcomes', 'outcomes');

  const history = new SessionHistory({
    sql: ws.sql, actor, transactionSync: write => ws.db.transaction(write)(),
    files: async () => ({ vfs: ws.vfs, artifactDirectory: '/actor/.kinu/context' }),
  });

  return { ...ws, actor, history, transcript: history.transcript(CHAT_SESSION_ID) };
}

describe('isTrivialTurn — the LLM-call pre-filter', () => {
  const turn = (userMessage: string, toolCalls: ToolCallRecord[] = []) =>
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
    expect(isTrivialTurn(turn('ok', [{ name: 'eval', args: {}, result: 1 }]))).toBe(false);
  });
});

/** A model rating of one turn; high is 4.5 and low 1.5, neutral 3. */
function rate(sql: ReturnType<typeof makeSql>, actor: ActorHandle, input: Partial<RecordTurnRatingInput> & { turnId: string; score: number }) {
  recordTurnRating(sql, actor, {
    corrected: input.score <= 2 ? 1 : 0, wrong: null, source: 'model', request: 't', answer: 'a', ...input,
  });
}

describe('rated scaffold rates (route into R2 archive priors)', () => {
  test('aggregates high/low ratings per serving version and blends into win-rates', () => {
    const { sql, actor } = setup();

    for (let i = 0; i < 3; i++) rate(sql, actor, { turnId: `h${i}`, score: 4.5, scaffoldVersion: 1 });

    rate(sql, actor, { turnId: 'l', score: 1.5, scaffoldVersion: 1 });
    rate(sql, actor, { turnId: 'n', score: 3, scaffoldVersion: 1 });

    const rates = realRatingScaffoldRates(sql, actor);
    expect(rates.get(1)).toEqual({ accepted: 3, negative: 1 }); // a neutral rating is not decisive

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

describe('advisor negatives read the canonical conversation', () => {
  test('a note resolves its turn through the transcript', async () => {
    const ws = setup();
    await seedTranscriptEntry(ws.history, CHAT_SESSION_ID, { id: 'u-chat', origin: 'input',
      message: { role: 'user', content: 'inspect the deploy' } });
    await seedTranscriptEntry(ws.history, CHAT_SESSION_ID, { id: 'a-chat', origin: 'output',
      message: { role: 'assistant', content: 'I only guessed' } });
    void ws.sql`INSERT INTO evolution_events (actor_id, id, type, message, data, created_at)
      VALUES (${ws.actor.actorId}, ${'advisor-chat'}, ${'advisor_note'}, ${'should have delegated'},
              ${JSON.stringify({ severity: 'concern', class: 'missed-capability', turnId: 'a-chat' })}, ${2000})`;

    const split = await buildOutcomeEvalSplit(ws.sql, ws.actor, ws.transcript, 2);
    const instance = [...split.train, ...split.val].find((row) => row.input === 'inspect the deploy');
    expect(instance?.expected?.recordedResponse).toBe('I only guessed');
  });

  test('a note whose turn id names no assistant entry is dropped, not scored blank', async () => {
    const ws = setup();
    void ws.sql`INSERT INTO evolution_events (actor_id, id, type, message, data, created_at)
      VALUES (${ws.actor.actorId}, ${'advisor-orphan'}, ${'advisor_note'}, ${'should have delegated'},
              ${JSON.stringify({ severity: 'concern', class: 'missed-capability', turnId: 'gone' })}, ${2000})`;

    const split = await buildOutcomeEvalSplit(ws.sql, ws.actor, ws.transcript, 2);
    expect(split.train).toHaveLength(0);
    expect(split.degeneracy).toBe('no_labeled_turns');
  });
});

describe('buildOutcomeEvalSplit — GEPA train/val discipline (disjoint)', () => {
  function seed(
    sql: ReturnType<typeof makeSql>, actor: ActorHandle, negatives: number, accepted: number,
  ) {
    for (let i = 0; i < negatives; i++) {
      rate(sql, actor, {
        turnId: `n${i}`, score: 1.5, request: `fix task ${i}`, answer: `bad answer ${i}`, followup: `correction ${i}`, now: 1000 + i,
      });
    }

    for (let i = 0; i < accepted; i++) {
      rate(sql, actor, { turnId: `a${i}`, score: 4.5, request: `good task ${i}`, answer: `good answer ${i}`, now: 2000 + i });
    }
  }

  /** The turn identity that must not appear on both sides of the split. */
  const turnOf = (instance: { id: string }) => instance.id.split('-').slice(2).join('-');

  test('train = failures to fix; val = HELD-OUT failures + accepted guards, with no overlap', async () => {
    const { sql, actor, transcript } = setup();
    seed(sql, actor, 5, 5);
    const split = await buildOutcomeEvalSplit(sql, actor, transcript, 8);

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

  test('failures far older than the accepted rows still reach train/val', async () => {
    const { sql, actor, transcript } = setup();
    seed(sql, actor, 5, 0);

    // The targets are the oldest rows here.
    for (let i = 0; i < 400; i++) rate(sql, actor, { turnId: `a${i}`, score: 4.5, request: 'ok', answer: 'fine', now: 5000 + i });

    const split = await buildOutcomeEvalSplit(sql, actor, transcript, 8);
    expect(split.degeneracy).toBeNull();
    expect(split.train).toHaveLength(3);
    expect(split.heldOutNegatives).toBe(1);
  });

  test('no instance is ever on both sides, across every budget', async () => {
    const { sql, actor, transcript } = setup();
    seed(sql, actor, 9, 9);

    for (const budget of [2, 3, 4, 5, 6, 8, 12, 18, 24]) {
      const split = await buildOutcomeEvalSplit(sql, actor, transcript, budget);
      const trainTurns = new Set(split.train.map(turnOf));
      expect(split.val.some((i) => trainTurns.has(turnOf(i)))).toBe(false);
      expect(split.heldOutNegatives)
        .toBe(split.val.filter((i) => i.expected?.outcome !== 'accepted').length);
    }
  });

  test('instances carry process evidence reconstructed from the existing run ledger', async () => {
    const { sql, actor, history, transcript } = setup();
    // The ask is recorded before the run and the answer after, bracketing the evidence window.
    await seedTranscriptEntry(history, CHAT_SESSION_ID, { id: 'u0', origin: 'input',
      message: { role: 'user', content: 'fix task 0' } });
    const recorder = new RunEventRecorder(sql, actor);
    recorder.emit('run-1', { type: 'run_start', agentId: 'agent', caused_by: 'chat', userMessage: 'fix task 0' });
    // The real step messages: calls rebuilt from `tool_call_end` have empty args, which
    // would zero the redundancy and loop counts.
    recorder.emit('run-1', {
      type: 'step_finish',
      stepIndex: 1,
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc-1', toolName: 'agents', input: { action: 'hire', role: 'reviewer' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tc-1', toolName: 'agents', output: { type: 'text', value: 'spawned' } }] },
      ],
    });
    recorder.emit('run-1', { type: 'tool_call_end', name: 'agents', toolCallId: 'tc-1', result: 'spawned', outcome: { success: true } });
    recorder.emit('run-1', {
      type: 'step_finish',
      stepIndex: 2,
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc-2', toolName: 'eval', input: { code: 'ls' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tc-2', toolName: 'eval', output: { type: 'text', value: 'done' } }] },
      ],
    });
    recorder.emit('run-1', { type: 'tool_call_end', name: 'eval', toolCallId: 'tc-2', result: 'done', outcome: { success: true } });
    recorder.emit('run-1', { type: 'run_end', reason: 'completed' });
    await seedTranscriptEntry(history, CHAT_SESSION_ID, { id: 'n0', origin: 'output',
      message: { role: 'assistant', content: 'bad answer 0' } });
    seed(sql, actor, 1, 0);

    const instance = (await buildOutcomeEvalSplit(sql, actor, transcript, 2)).train[0];
    expect(instance.evidence).toContain('Outcome: corrected');
    expect(instance.evidence).toContain(
      'Turn process: 2 sequential steps, 1 hiring, 0 exploration, 0 messaging, 1 eval',
    );
  });

  test('negatives backfill when accepted turns are scarce (and vice versa)', async () => {
    const { sql, actor, transcript } = setup();
    seed(sql, actor, 6, 1);
    // 5 failures drawn (backfilling the 2 the accepted pool can't cover) →
    // round(5/3) = 2 held out, 3 to train on, plus the 1 accepted guard.
    const split = await buildOutcomeEvalSplit(sql, actor, transcript, 6);
    expect(split.train).toHaveLength(3);
    expect(split.val).toHaveLength(3);
    expect(split.heldOutNegatives).toBe(2);
    expect(split.degeneracy).toBeNull();
  });

  test('the newest failures are the held-out ones — a forward-in-time holdout', async () => {
    const { sql, actor, transcript } = setup();
    seed(sql, actor, 4, 0); // recorded oldest-first: "fix task 0" … "fix task 3"
    const split = await buildOutcomeEvalSplit(sql, actor, transcript, 8);
    expect(split.val.map((i) => i.input)).toEqual(['fix task 3']);
    expect(split.train.map((i) => i.input)).toEqual(['fix task 2', 'fix task 1', 'fix task 0']);
  });

  test('a single failure cannot be held out — the split says so instead of overlapping', async () => {
    const { sql, actor, transcript } = setup();
    seed(sql, actor, 1, 3);
    const split = await buildOutcomeEvalSplit(sql, actor, transcript, 8);
    expect(split.train).toHaveLength(1);
    expect(split.heldOutNegatives).toBe(0);
    expect(split.val.every((i) => i.expected?.outcome === 'accepted')).toBe(true);
    const degeneracy = present(split.degeneracy, 'the split degeneracy');
    expect(degeneracy).toBe('no_held_out_negatives');
    expect(describeSplitDegeneracy(degeneracy)).toContain('not evidence');
  });

  test('no negatives yet → empty train set, flagged (never the accepted set)', async () => {
    const { sql, actor, transcript } = setup();
    seed(sql, actor, 0, 3);
    const split = await buildOutcomeEvalSplit(sql, actor, transcript, 6);
    expect(split.val).toHaveLength(3);
    expect(split.train).toHaveLength(0);
    expect(split.heldOutNegatives).toBe(0);
    expect(split.degeneracy).toBe('no_negatives');
  });

  test('empty ledger → empty split, flagged', async () => {
    const { sql, actor, transcript } = setup();
    const split = await buildOutcomeEvalSplit(sql, actor, transcript, 8);
    expect(split.val).toHaveLength(0);
    expect(split.train).toHaveLength(0);
    expect(split.degeneracy).toBe('no_labeled_turns');
  });
});

describe('lessons ledger — provisional until corroborated', () => {
  test("the user's own negative on a tied turn corroborates provisional lessons", () => {
    const { sql, actor } = setup();
    recordLesson(sql, actor, { turnIds: ['m7'], text: 'always check the year', source: 'turn_reflection', status: 'provisional' });
    recordLesson(sql, actor, { turnIds: ['m8'], text: 'unrelated lesson', source: 'turn_reflection', status: 'provisional' });

    const upgraded = corroborateLessonsForTurn(sql, actor, 'm7', 999);
    expect(upgraded).toHaveLength(1);
    expect(upgraded[0].text).toBe('always check the year');
    expect(upgraded[0].status).toBe('corroborated');

    expect(listLessons(sql, actor, { status: 'corroborated' })).toHaveLength(1);
    expect(listLessons(sql, actor, { status: 'provisional' })).toHaveLength(1);
    // Idempotent: a second negative on the same turn upgrades nothing new.
    expect(corroborateLessonsForTurn(sql, actor, 'm7')).toHaveLength(0);
  });

  test('session lessons tied to a window corroborate from any window turn', () => {
    const { sql, actor } = setup();
    recordLesson(sql, actor, { turnIds: ['t1', 't2', 't3'], text: 'window pattern', source: 'session_reflection', status: 'provisional' });
    expect(corroborateLessonsForTurn(sql, actor, 't2')).toHaveLength(1);
  });
});
