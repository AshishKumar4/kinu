/**
 * Unit tests for RunEventRecorder.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  initRunEventTables, RunEventRecorder, WORKSPACE_RUN_ID,
  type RunEvent,
} from '../src/index';
import { makeSql, makeExecRaw } from './helpers';

function setup() {
  const db = new Database(':memory:');
  initRunEventTables(makeExecRaw(db));
  const sql = makeSql(db);
  return { recorder: new RunEventRecorder(sql), sql };
}

describe('RunEventRecorder.emit', () => {
  test('assigns monotonic eventIndex starting at 0', () => {
    const { recorder } = setup();
    const a = recorder.emit('run-1', { type: 'run_start', agentId: 'a' });
    const b = recorder.emit('run-1', { type: 'turn_start', turnIndex: 0 });
    expect(a.eventIndex).toBe(0);
    expect(b.eventIndex).toBe(1);
  });

  test('per-runId indices are independent', () => {
    const { recorder } = setup();
    const a = recorder.emit('run-A', { type: 'run_start', agentId: 'a' });
    const b = recorder.emit('run-B', { type: 'run_start', agentId: 'a' });
    expect(a.eventIndex).toBe(0);
    expect(b.eventIndex).toBe(0);
  });

  test('decorates each event with runId + ISO timestamp', () => {
    const { recorder } = setup();
    const a = recorder.emit('run-1', { type: 'error', message: 'hi' });
    expect(a.runId).toBe('run-1');
    expect(a.timestamp.length).toBeGreaterThan(10);
  });

  test('persists events to the run_events table', () => {
    const { recorder, sql } = setup();
    recorder.emit('run-1', { type: 'run_start', agentId: 'a' });
    recorder.emit('run-1', { type: 'error', message: 'x' });
    const rows = sql<{ event_index: number; type: string }>`
      SELECT event_index, type FROM run_events WHERE run_id = 'run-1' ORDER BY event_index`;
    expect(rows.length).toBe(2);
    expect(rows[0].type).toBe('run_start');
    expect(rows[1].type).toBe('error');
  });
});

describe('RunEventRecorder.read', () => {
  test('returns events in eventIndex order', () => {
    const { recorder } = setup();
    for (let i = 0; i < 5; i++) {
      recorder.emit('run-1', { type: 'error', message: `t${i}` });
    }
    const out = recorder.read('run-1');
    expect(out.length).toBe(5);
    expect(out.map((e) => e.eventIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  test('honors since lower bound', () => {
    const { recorder } = setup();
    for (let i = 0; i < 5; i++) {
      recorder.emit('run-1', { type: 'error', message: `t${i}` });
    }
    const out = recorder.read('run-1', { since: 3 });
    expect(out.length).toBe(2);
    expect(out[0].eventIndex).toBe(3);
    expect(out[1].eventIndex).toBe(4);
  });

  test('honors limit', () => {
    const { recorder } = setup();
    for (let i = 0; i < 20; i++) {
      recorder.emit('run-1', { type: 'error', message: `t${i}` });
    }
    expect(recorder.read('run-1', { limit: 5 }).length).toBe(5);
  });

  test('run_end round-trips the terminal error text (the durable evidence trail)', () => {
    const { recorder } = setup();
    recorder.emit('run-1', { type: 'run_start', agentId: 'a' });
    recorder.emit('run-1', { type: 'run_end', reason: 'error', error: 'Bad Request: content parts must be text or image_url' });

    const events = recorder.read('run-1', { types: ['run_end'] });
    expect(events.length).toBe(1);
    const runEnd = events.find((event) => event.type === 'run_end');
    if (!runEnd) throw new Error('expected run_end event');
    expect(runEnd.reason).toBe('error');
    expect(runEnd.error).toBe('Bad Request: content parts must be text or image_url');
  });

  test('honors types filter', () => {
    const { recorder } = setup();
    recorder.emit('run-1', { type: 'run_start', agentId: 'a' });
    recorder.emit('run-1', { type: 'error', message: 'x' });
    recorder.emit('run-1', { type: 'error', message: 'y' });
    recorder.emit('run-1', { type: 'run_end' });

    const onlyText = recorder.read('run-1', { types: ['error'] });
    expect(onlyText.length).toBe(2);
    expect(onlyText.every((e) => e.type === 'error')).toBe(true);
  });
});

describe('RunEventRecorder.readSince', () => {
  test('returns events strictly after the given index — for SSE resume', () => {
    const { recorder } = setup();
    for (let i = 0; i < 5; i++) {
      recorder.emit('run-1', { type: 'error', message: `t${i}` });
    }
    const after2 = recorder.readSince('run-1', 2);
    expect(after2.length).toBe(2);
    expect(after2[0].eventIndex).toBe(3);
  });

  test('returns empty when no events after', () => {
    const { recorder } = setup();
    recorder.emit('run-1', { type: 'run_end' });
    expect(recorder.readSince('run-1', 100).length).toBe(0);
  });
});

describe('RunEventRecorder.observe', () => {
  test('fans out new events to subscribers', () => {
    const { recorder } = setup();
    const seen: RunEvent[] = [];
    const unsub = recorder.observe((e) => seen.push(e));
    recorder.emit('run-1', { type: 'error', message: 'x' });
    recorder.emit('run-1', { type: 'error', message: 'y' });
    expect(seen.length).toBe(2);
    unsub();
    recorder.emit('run-1', { type: 'error', message: 'z' });
    expect(seen.length).toBe(2); // no more after unsub
  });
});

describe('RunEventRecorder.listRunsBefore / runSeq / count', () => {
  test('groups distinct runs, newest write first', () => {
    const { recorder } = setup();
    recorder.emit('run-A', { type: 'run_start', agentId: 'a' });
    recorder.emit('run-A', { type: 'run_end' });
    recorder.emit('run-B', { type: 'run_start', agentId: 'a' });

    const runs = recorder.listRunsBefore(null, 10);
    expect(runs.map((r) => r.runId)).toEqual(['run-B', 'run-A']);
    expect(runs.map((r) => r.eventCount)).toEqual([1, 2]);
  });

  test('runs whose latest events share a timestamp still have a decidable window', () => {
    const { recorder, sql } = setup();
    // The defect this ordering replaced: `ORDER BY MAX(ts) DESC` with no
    // tiebreak over a TEXT column. When two runs' latest events carry the same
    // stamp there is no answer to which one a LIMIT 1 contains, so a two-page
    // walk could deliver one of them twice and the other never. Written
    // directly, because the recorder cannot be made to collide on purpose.
    const same = '2026-08-17T00:00:00.000Z';
    for (const runId of ['run-A', 'run-B', 'run-C']) {
      void sql`INSERT INTO run_events (run_id, event_index, type, payload, ts)
        VALUES (${runId}, 0, 'error', '{}', ${same})`;
    }

    const first = recorder.listRunsBefore(null, 1);
    expect(first.map((r) => r.runId)).toEqual(['run-C']);
    const second = recorder.listRunsBefore(recorder.runSeq('run-C'), 1);
    expect(second.map((r) => r.runId)).toEqual(['run-B']);
    const third = recorder.listRunsBefore(recorder.runSeq('run-B'), 10);
    expect(third.map((r) => r.runId)).toEqual(['run-A']);
  });

  test('runSeq answers null for a run the log does not hold', () => {
    const { recorder } = setup();
    recorder.emit('run-A', { type: 'run_start', agentId: 'a' });
    expect(recorder.runSeq('run-A')).toBeGreaterThan(0);
    expect(recorder.runSeq('never-existed')).toBeNull();
  });

  test('count returns total events per run', () => {
    const { recorder } = setup();
    for (let i = 0; i < 7; i++) {
      recorder.emit('run-1', { type: 'error', message: `t${i}` });
    }
    expect(recorder.count('run-1')).toBe(7);
    expect(recorder.count('no-such')).toBe(0);
  });

  /**
   * Two changes met here, and carrying either one alone is silent.
   *
   * The window became `listRunsBefore(before, count)` ordered by MAX(rowid) — a
   * decidable page. Independently, the reserved {@link WORKSPACE_RUN_ID} became
   * the place a model call made BETWEEN runs is filed, and it is not a run.
   * Keeping the new signature without the exclusion breaks no type and passes
   * every gate: the only symptom is a fabricated run at the top of the owner's
   * history. Keeping the exclusion without the ordering brings back an
   * undecidable window. So both are asserted in one place.
   *
   * A real run sits beside the pseudo-run on purpose: an assertion that the list
   * is EMPTY would read the same whether the clause worked or the query blew up.
   */
  test('the workspace bucket is filed but never listed as a run', () => {
    const { recorder } = setup();
    recorder.emit('run-A', { type: 'run_start', agentId: 'a' });
    recorder.emit(WORKSPACE_RUN_ID, { type: 'model_call', source: 'judge', usage: { input: 5 } });
    recorder.emit('run-B', { type: 'run_start', agentId: 'a' });
    recorder.emit(WORKSPACE_RUN_ID, { type: 'model_call', source: 'fast', usage: { input: 7 } });

    // Listed: the real runs, newest write first. NOT listed: the bucket, even
    // though its rows are the most recently written in the log.
    expect(recorder.listRunsBefore(null, 10).map((r) => r.runId)).toEqual(['run-B', 'run-A']);

    // Excluded from the LIST, not from the log: every reader that names the
    // bucket still gets its rows, which is how the spend read-model reaches them.
    expect(recorder.count(WORKSPACE_RUN_ID)).toBe(2);
    expect(recorder.read(WORKSPACE_RUN_ID).map((e) => e.type)).toEqual(['model_call', 'model_call']);

    // And the exclusion does not perturb the page anchor: the bucket's rows are
    // dropped before the grouping, so each real run's MAX(rowid) is its own and a
    // one-per-page walk still reaches both exactly once.
    const first = recorder.listRunsBefore(null, 1);
    expect(first.map((r) => r.runId)).toEqual(['run-B']);
    expect(recorder.listRunsBefore(recorder.runSeq('run-B'), 10).map((r) => r.runId))
      .toEqual(['run-A']);

    // The bucket has a position like anything else — it is a run id to `runSeq`,
    // which is keyed explicitly and therefore not the list's business.
    expect(recorder.runSeq(WORKSPACE_RUN_ID)).toBeGreaterThan(recorder.runSeq('run-B')!);
  });
});

describe('integration: after restart, indices resume correctly', () => {
  test('a fresh recorder backed by the same DB continues monotonic indices', () => {
    const db = new Database(':memory:');
    initRunEventTables(makeExecRaw(db));
    const sql = makeSql(db);
    const r1 = new RunEventRecorder(sql);
    r1.emit('run-1', { type: 'run_start', agentId: 'a' });
    r1.emit('run-1', { type: 'error', message: 'x' });

    // Simulate process restart — new recorder, same SQLite.
    const r2 = new RunEventRecorder(sql);
    const next = r2.emit('run-1', { type: 'turn_end', turnIndex: 0 });
    expect(next.eventIndex).toBe(2);
  });
});

describe('RunEventRecorder.readRecentByType', () => {
  test('spans runs, filters in SQL, and returns oldest first', () => {
    const { recorder } = setup();
    recorder.emit('run-1', { type: 'step_finish', stepIndex: 1 });
    recorder.emit('run-1', { type: 'turn_end', turnIndex: 0 });
    recorder.emit('run-2', { type: 'step_finish', stepIndex: 1 });
    const steps = recorder.readRecentByType('step_finish');
    expect(steps.map((e) => e.runId)).toEqual(['run-1', 'run-2']);
    expect(steps.every((e) => e.type === 'step_finish')).toBe(true);
  });

  test('limit is a real bound, keeping the NEWEST rows', () => {
    // The distinction that matters for a percentile: a post-filter slice of a
    // fetch window can come back short, or hold the oldest rows instead.
    const { recorder } = setup();
    for (let i = 0; i < 10; i++) {
      recorder.emit('run-1', { type: 'turn_start', turnIndex: i });
      recorder.emit('run-1', { type: 'step_finish', stepIndex: i });
    }
    const steps = recorder.readRecentByType('step_finish', 3);
    expect(steps).toHaveLength(3);
    expect(steps.map((e) => (e.type === 'step_finish' ? e.stepIndex : -1))).toEqual([7, 8, 9]);
  });

  test('a type nothing was recorded under reads empty, not stale', () => {
    const { recorder } = setup();
    recorder.emit('run-1', { type: 'turn_start', turnIndex: 0 });
    expect(recorder.readRecentByType('step_finish')).toEqual([]);
  });

  test('round-trips the usage and context a step carries', () => {
    const { recorder } = setup();
    recorder.emit('run-1', {
      type: 'step_finish',
      stepIndex: 1,
      usage: { input: 900, cacheRead: 700, output: 40 },
      usd: 0.001,
      context: {
        segments: [{ plane: 'system', label: 'Soul', chars: 400, items: 1 }],
        measuredChars: 400,
        charsPerToken: 4,
        estimatedTokens: 100,
      },
    });
    const [step] = recorder.readRecentByType('step_finish');
    expect(step?.type === 'step_finish' && step.usage?.cacheRead).toBe(700);
    expect(step?.type === 'step_finish' && step.context?.measuredChars).toBe(400);
  });
});
