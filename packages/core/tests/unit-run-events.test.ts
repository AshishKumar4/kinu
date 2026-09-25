
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  boundRunEventQuery, getRunEvents, initRunEventTables, RunEventRecorder,
  RUN_EVENT_LIMIT_DEFAULT, RUN_EVENT_LIMIT_MAX,
  USAGE_FIELDS, WORKSPACE_RUN_ID,
  type HeadFileChange, type RunEvent, type Usage,
} from '../src/index';
import { present, testActorHandle } from '@kinu.run/test-utils';
import { isBackgroundHandle } from '../src/jobs/threshold';
import { makeSql, makeExecRaw } from './helpers';
import { createRecordingLogger, setDiagnosticsSink } from '../src/obs/log';

function setup() {
  const db = new Database(':memory:');
  initRunEventTables(makeExecRaw(db));
  const sql = makeSql(db);
  const actor = testActorHandle(sql);

  return { recorder: new RunEventRecorder(sql, actor), sql, actor };
}

/** A bound is only visible when it cuts. */
function seededRun(count: number): RunEventRecorder {
  const { recorder } = setup();

  for (let i = 0; i < count; i++) recorder.emit('run-1', { type: 'error', message: `t${i}` });

  return recorder;
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
    const { recorder, sql, actor } = setup();
    recorder.emit('run-1', { type: 'run_start', agentId: 'a' });
    recorder.emit('run-1', { type: 'error', message: 'x' });

    const rows = sql<{ event_index: number; type: string }>`
      SELECT event_index, type FROM run_events
      WHERE actor_id = ${actor.actorId} AND run_id = 'run-1' ORDER BY event_index`;

    expect(rows.length).toBe(2);
    expect(rows[0].type).toBe('run_start');
    expect(rows[1].type).toBe('error');
  });
  test('a colliding index raises instead of replacing a live row', () => {
    const { recorder, sql, actor } = setup();
    recorder.emit('run-1', { type: 'error', message: 'first' });
    recorder.emit('run-1', { type: 'error', message: 'second' });
    const runId = 'run-1';
    const live = '{"type":"error","eventIndex":2,"runId":"run-1","timestamp":"2026-09-05T00:00:00.000Z","message":"live"}';
    const ts = '2026-09-05T00:00:00.000Z';
    void sql`INSERT INTO run_events (actor_id, run_id, event_index, type, payload, ts)
      VALUES (${actor.actorId}, ${runId}, 2, 'error', ${live}, ${ts})`;
    expect(() => recorder.emit('run-1', { type: 'error', message: 'collide' })).toThrow(/UNIQUE constraint failed: run_events/);

    const rows = sql<{ payload: string }>`
      SELECT payload FROM run_events
      WHERE actor_id = ${actor.actorId} AND run_id = ${runId} AND event_index = 2`;

    expect(rows.length).toBe(1);
    expect(rows[0]?.payload).toBe(live);
  });
});

describe('a tool result round-trips as the value the tool returned', () => {
  test("a detach handle read back off the ledger is still a handle", () => {
    const { recorder } = setup();

    // The ledger row must be the handle itself: `isBackgroundHandle` parses it to find the job id.
    const handle = { background: true, jobId: 'bgjob-probe', kind: 'run', message: 'Spawned; the settled result will wake you.' };
    recorder.emit('run-1', {
      type: 'tool_call_end', name: 'run', toolCallId: 'call-1',
      args: { command: 'sleep 45 && echo ok' }, result: handle, outcome: { success: true },
    });

    const [row] = recorder.read('run-1');

    if (row?.type !== 'tool_call_end') throw new Error('expected the tool_call_end row');

    expect(isBackgroundHandle(row.result)).toBe(true);
    expect(row.result).toEqual(handle);
  });

  test('a head_merge read back off the ledger keeps which changes carry no line counts', () => {
    const { recorder } = setup();

    const changes: HeadFileChange[] = [
      { path: 'build', status: 'removed', added: 0, removed: 0, directory: true },
      { path: 'locked.ts', status: 'changed', added: 0, removed: 0, unreadable: true },
    ];

    recorder.emit('run-1', {
      type: 'head_merge', rootId: 'root-1', headCount: 1, headsWithFindings: 1, mergedNarrative: 'merged',
      fileChanges: [{ id: 'head-1', changes }], blindSpots: [],
    });

    const [row] = recorder.read('run-1');

    if (row?.type !== 'head_merge') throw new Error('expected the head_merge row');

    // Stripped, both would read as a change of zero lines — a size nobody measured.
    expect(row.fileChanges[0]?.changes).toEqual(changes);
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

  // KINU-N019: `read` clamps every caller to a finite positive integer before SQL;
  // `boundRunEventQuery` owns the ceiling for untrusted callers at `getRunEvents`.
  describe('read admits only a finite positive integer limit', () => {
    test('a negative limit reads one row, never the whole run', () => {
      const recorder = seededRun(40);
      expect(recorder.read('run-1', { limit: -1 }).length).toBe(1);
      expect(recorder.read('run-1', { limit: -9999 }).length).toBe(1);
    });

    test('a negative limit stays bounded with a type filter too', () => {
      // The filtered path's fetch window derives from `limit`.
      const recorder = seededRun(40);
      expect(recorder.read('run-1', { limit: -1, types: ['error'] }).length).toBe(1);
    });

    test('zero raises to one row rather than reading an empty page', () => {
      expect(seededRun(40).read('run-1', { limit: 0 }).length).toBe(1);
    });

    test('a non-finite limit means unstated and takes the default', () => {
      const recorder = seededRun(400);
      expect(recorder.read('run-1', { limit: Number.NaN }).length).toBe(RUN_EVENT_LIMIT_DEFAULT);
      expect(recorder.read('run-1', { limit: Number.POSITIVE_INFINITY }).length)
        .toBe(RUN_EVENT_LIMIT_DEFAULT);
      expect(recorder.read('run-1', { limit: Number.NEGATIVE_INFINITY }).length)
        .toBe(RUN_EVENT_LIMIT_DEFAULT);
    });

    test('a fractional limit truncates instead of failing the query', () => {
      const recorder = seededRun(40);
      expect(recorder.read('run-1', { limit: 2.7 }).length).toBe(2);
      expect(recorder.read('run-1', { limit: 0.5 }).length).toBe(1);
    });

    test('an in-object window wider than the untrusted ceiling is honoured', () => {
      // `getRunSummaries` folds 1000 events into spend; a stranger's ceiling would truncate it.
      const recorder = seededRun(RUN_EVENT_LIMIT_MAX + 120);
      expect(recorder.read('run-1', { limit: 1000 }).length).toBe(RUN_EVENT_LIMIT_MAX + 120);
    });

    test('a non-finite or negative since reads from the start', () => {
      const recorder = seededRun(5);
      expect(recorder.read('run-1', { since: Number.NaN }).length).toBe(5);
      expect(recorder.read('run-1', { since: -1 }).length).toBe(5);
      expect(recorder.read('run-1', { since: 2.9 }).map((e) => e.eventIndex)).toEqual([2, 3, 4]);
    });
  });

  describe('getRunEvents is the boundary every untrusted caller crosses', () => {
    test('an oversized limit clamps to the untrusted ceiling', () => {
      const recorder = seededRun(RUN_EVENT_LIMIT_MAX + 120);
      expect(getRunEvents(recorder, 'run-1', { limit: 1e9 }).length).toBe(RUN_EVENT_LIMIT_MAX);
      expect(getRunEvents(recorder, 'run-1', { limit: Number.MAX_SAFE_INTEGER }).length)
        .toBe(RUN_EVENT_LIMIT_MAX);
      // The same value the in-object fold is trusted with is capped here.
      expect(getRunEvents(recorder, 'run-1', { limit: 1000 }).length).toBe(RUN_EVENT_LIMIT_MAX);
    });

    test('negative, non-finite and fractional limits stay bounded here too', () => {
      const recorder = seededRun(400);
      expect(getRunEvents(recorder, 'run-1', { limit: -1 }).length).toBe(1);
      expect(getRunEvents(recorder, 'run-1', { limit: Number.NaN }).length)
        .toBe(RUN_EVENT_LIMIT_DEFAULT);
      expect(getRunEvents(recorder, 'run-1', { limit: 2.7 }).length).toBe(2);
      expect(getRunEvents(recorder, 'run-1', { since: -3, limit: 3 }).map((e) => e.eventIndex))
        .toEqual([0, 1, 2]);
    });
  });

  describe('boundRunEventQuery is the one policy the boundary applies', () => {
    test('it closes the bounds and leaves the rest of the query alone', () => {
      expect(boundRunEventQuery({ limit: -1, since: -5, types: ['error'] }))
        .toEqual({ limit: 1, since: 0, types: ['error'] });
    });

    test('an empty query states nothing and takes both defaults', () => {
      expect(boundRunEventQuery()).toEqual({ since: 0, limit: RUN_EVENT_LIMIT_DEFAULT });
    });

    test('applying it twice changes nothing', () => {
      const once = boundRunEventQuery({ limit: 1e9, since: Number.NaN });
      expect(boundRunEventQuery(once)).toEqual(once);
    });
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
  test('sparse matches past the first fetch window still fill the limit', () => {
    // A fetch-one-window-and-slice read would return only the first match.
    const { recorder } = setup();
    recorder.emit('run-1', { type: 'error', message: 'match-0' });

    for (let i = 0; i < 100; i++) {
      recorder.emit('run-1', { type: 'turn_start', turnIndex: i });
    }

    for (let i = 1; i <= 5; i++) {
      recorder.emit('run-1', { type: 'error', message: `match-${i}` });
    }

    const out = recorder.read('run-1', { types: ['error'], limit: 5 });
    expect(out.length).toBe(5);
    expect(out.every((e) => e.type === 'error')).toBe(true);
    expect(out.map((e) => e.eventIndex)).toEqual([0, 101, 102, 103, 104]);
  });

  test('a filtered read past the last match ends at the run end', () => {
    const { recorder } = setup();
    recorder.emit('run-1', { type: 'error', message: 'match-0' });

    for (let i = 0; i < 30; i++) {
      recorder.emit('run-1', { type: 'turn_start', turnIndex: i });
    }

    recorder.emit('run-1', { type: 'error', message: 'match-1' });
    const out = recorder.read('run-1', { types: ['error'], limit: 10 });
    expect(out.map((e) => e.eventIndex)).toEqual([0, 31]);
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
  test('a negative limit reads one row, never the whole tail', () => {
    // `LIMIT -1` in SQLite means no limit.
    const { recorder } = setup();

    for (let i = 0; i < 40; i++) {
      recorder.emit('run-1', { type: 'error', message: `t${i}` });
    }

    expect(recorder.readSince('run-1', -1, -1).length).toBe(1);
    expect(recorder.readSince('run-1', 0, -9999).length).toBe(1);
  });

  test('a non-finite limit means unstated and takes the default', () => {
    const { recorder } = setup();

    for (let i = 0; i < 600; i++) {
      recorder.emit('run-1', { type: 'error', message: `t${i}` });
    }

    expect(recorder.readSince('run-1', -1, Number.NaN).length).toBe(500);
    expect(recorder.readSince('run-1', -1, Number.POSITIVE_INFINITY).length).toBe(500);
  });

  test('a fractional limit truncates instead of failing the query', () => {
    const { recorder } = setup();

    for (let i = 0; i < 40; i++) {
      recorder.emit('run-1', { type: 'error', message: `t${i}` });
    }

    expect(recorder.readSince('run-1', -1, 2.7).length).toBe(2);
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
  test('a negative count reads one run, never the whole log', () => {
    // `LIMIT -1` in SQLite means no limit.
    const { recorder } = setup();

    for (let i = 0; i < 5; i++) {
      recorder.emit(`run-${i}`, { type: 'run_start', agentId: 'a' });
    }

    expect(recorder.listRunsBefore(null, -1).length).toBe(1);
  });

  test('a non-finite count means unstated and takes the default', () => {
    const { recorder } = setup();

    for (let i = 0; i < 250; i++) {
      recorder.emit(`run-${i}`, { type: 'run_start', agentId: 'a' });
    }

    expect(recorder.listRunsBefore(null, Number.NaN).length).toBe(RUN_EVENT_LIMIT_DEFAULT);
  });

  test('a fractional count truncates instead of failing the query', () => {
    const { recorder } = setup();

    for (let i = 0; i < 5; i++) {
      recorder.emit(`run-${i}`, { type: 'run_start', agentId: 'a' });
    }

    expect(recorder.listRunsBefore(null, 2.7).length).toBe(2);
  });

  test('runs whose latest events share a timestamp still have a decidable window', () => {
    const { recorder, sql, actor } = setup();
    // Ties on the latest stamp must not let a two-page walk duplicate one run and skip another.
    // Written directly: the recorder cannot be made to collide.
    const same = '2026-08-17T00:00:00.000Z';

    for (const runId of ['run-A', 'run-B', 'run-C']) {
      void sql`INSERT INTO run_events (actor_id, run_id, event_index, type, payload, ts)
        VALUES (${actor.actorId}, ${runId}, 0, 'error', '{}', ${same})`;
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

  /** Ordering by MAX(rowid) and excluding {@link WORKSPACE_RUN_ID} are asserted together: dropping
     *  either is silent. A real run sits beside the bucket so an empty list cannot pass. */
  test('the workspace bucket is filed but never listed as a run', () => {
    const { recorder } = setup();
    recorder.emit('run-A', { type: 'run_start', agentId: 'a' });
    recorder.emit(WORKSPACE_RUN_ID, { type: 'model_call', source: 'judge', usage: { input: 5 } });
    recorder.emit('run-B', { type: 'run_start', agentId: 'a' });
    recorder.emit(WORKSPACE_RUN_ID, { type: 'model_call', source: 'fast', usage: { input: 7 } });

    // The bucket is not listed, even though its rows are newest.
    expect(recorder.listRunsBefore(null, 10).map((r) => r.runId)).toEqual(['run-B', 'run-A']);

    // Excluded from the list, not the log: the spend read-model still reaches its rows.
    expect(recorder.count(WORKSPACE_RUN_ID)).toBe(2);
    expect(recorder.read(WORKSPACE_RUN_ID).map((e) => e.type)).toEqual(['model_call', 'model_call']);

    // Dropped before grouping, so each run's MAX(rowid) anchor is its own.
    const first = recorder.listRunsBefore(null, 1);
    expect(first.map((r) => r.runId)).toEqual(['run-B']);
    expect(recorder.listRunsBefore(recorder.runSeq('run-B'), 10).map((r) => r.runId))
      .toEqual(['run-A']);

    expect(recorder.runSeq(WORKSPACE_RUN_ID)).toBeGreaterThan(present(recorder.runSeq('run-B'), "run-B's sequence"));
  });
});

describe('integration: after restart, indices resume correctly', () => {
  test('a fresh recorder backed by the same DB continues monotonic indices', () => {
    const db = new Database(':memory:');
    initRunEventTables(makeExecRaw(db));
    const sql = makeSql(db);
    const r1 = new RunEventRecorder(sql, testActorHandle(sql));
    r1.emit('run-1', { type: 'run_start', agentId: 'a' });
    r1.emit('run-1', { type: 'error', message: 'x' });

    // Simulate process restart — new recorder, same SQLite.
    const r2 = new RunEventRecorder(sql, testActorHandle(sql));
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
    // A post-filter slice can come back short or hold the oldest rows.
    const { recorder } = setup();

    for (let i = 0; i < 10; i++) {
      recorder.emit('run-1', { type: 'turn_start', turnIndex: i });
      recorder.emit('run-1', { type: 'step_finish', stepIndex: i });
    }

    const steps = recorder.readRecentByType('step_finish', 3);
    expect(steps).toHaveLength(3);
    expect(steps.map((e) => (e.type === 'step_finish' ? e.stepIndex : -1))).toEqual([7, 8, 9]);
  });
  test('a negative limit reads one row, never the whole log', () => {
    // `LIMIT -1` in SQLite means no limit.
    const { recorder } = setup();

    for (let i = 0; i < 40; i++) {
      recorder.emit('run-1', { type: 'step_finish', stepIndex: i });
    }

    expect(recorder.readRecentByType('step_finish', -1).length).toBe(1);
  });

  test('a non-finite limit means unstated and takes the default', () => {
    const { recorder } = setup();

    for (let i = 0; i < 250; i++) {
      recorder.emit('run-1', { type: 'step_finish', stepIndex: i });
    }

    expect(recorder.readRecentByType('step_finish', Number.NaN).length).toBe(200);
  });

  test('a fractional limit truncates instead of failing the query', () => {
    const { recorder } = setup();

    for (let i = 0; i < 40; i++) {
      recorder.emit('run-1', { type: 'step_finish', stepIndex: i });
    }

    expect(recorder.readRecentByType('step_finish', 2.7).length).toBe(2);
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

describe('RunEventRecorder.spendByProducer', () => {
  test('sums every row in the log, not a window of them', () => {
    const { recorder } = setup();

    // Past `readRecentByType`'s 200-row default: a total is a sum, not a sample.
    for (let i = 0; i < 450; i++) {
      recorder.emit('run-1', {
        type: 'step_finish', stepIndex: i, usage: { input: 10, output: 1 }, usd: 0.001,
      });
    }

    const agent = recorder.spendByProducer().get('agent');
    expect(agent).toMatchObject({ calls: 450, callsWithoutUsage: 0, unpricedCalls: 0 });
    expect(agent?.usage).toEqual({ input: 4_500, output: 450 });
    expect(agent?.usd).toBeCloseTo(0.45, 10);
  });

  test('step_finish is the turn loop; every other producer names itself', () => {
    const { recorder } = setup();
    recorder.emit('run-1', { type: 'step_finish', stepIndex: 0, usage: { input: 100, output: 10 } });
    recorder.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'judge', usage: { input: 20, output: 2 },
    });
    recorder.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'fast', usage: { input: 5, output: 1 },
    });
    // The lifecycle mirror of a direct call must not be counted again.
    recorder.emit(WORKSPACE_RUN_ID, {
      type: 'model_operation', operationId: 'op-1', source: 'fast', op: 'complete',
      phase: 'end', outcome: 'ok', usage: { input: 5, output: 1 },
    });

    const spend = recorder.spendByProducer();
    expect([...spend.keys()].sort()).toEqual(['agent', 'fast', 'judge']);
    expect(spend.get('agent')?.usage).toEqual({ input: 100, output: 10 });
    expect(spend.get('fast')).toMatchObject({ calls: 1 });
  });

  test('a hired agent\'s turns are in the workspace total, under the same producer as the root\'s', () => {
    // A hired agent writes under its own actor_id; the workspace total must include it.
    const { recorder, sql } = setup();
    const hired = new RunEventRecorder(sql, testActorHandle(sql, { actorId: 'task-12qzhx' }));
    recorder.emit('run-1', { type: 'step_finish', stepIndex: 0, usage: { input: 100, output: 10 }, usd: 0.01 });
    hired.emit('run-9', { type: 'step_finish', stepIndex: 0, usage: { input: 40, output: 4 }, usd: 0.004 });
    hired.emit(WORKSPACE_RUN_ID, { type: 'model_call', source: 'fast', usage: { input: 5, output: 1 } });

    const spend = recorder.spendByProducer();
    expect(spend.get('agent')).toMatchObject({ calls: 2, usage: { input: 140, output: 14 } });
    expect(spend.get('agent')?.usd).toBeCloseTo(0.014);
    expect(spend.get('fast')).toMatchObject({ calls: 1 });
    // The same total from either actor: it is the workspace's, not a view.
    expect(hired.spendByProducer().get('agent')).toMatchObject({ calls: 2 });
  });

  test('a field no call reported is absent from the sum, never a zero', () => {
    const { recorder } = setup();
    recorder.emit('run-1', { type: 'step_finish', stepIndex: 0, usage: { input: 100, output: 10 } });
    recorder.emit('run-1', { type: 'step_finish', stepIndex: 1, usage: { input: 200, output: 20 } });

    const agent = recorder.spendByProducer().get('agent');
    expect(agent?.usage).toEqual({ input: 300, output: 30 });
    // No cache report means no cache figure, distinct from reading zero from cache.
    expect('cacheRead' in (agent?.usage ?? {})).toBe(false);
    expect(agent?.usd).toBeUndefined();
  });

  test('every Usage field survives the sum', () => {
    const { recorder } = setup();

    // `json_extract` columns are unchecked; one call carrying every field catches a forgotten alias.
    const every: Required<Usage> = {
      input: 11, output: 7, cacheRead: 5, cacheWrite: 3, cacheWrite1h: 2, reasoning: 1,
      neurons: 0.5,
    };

    recorder.emit('run-1', { type: 'step_finish', stepIndex: 0, usage: every, usd: 0.02 });

    const agent = recorder.spendByProducer().get('agent');
    expect(agent?.usage).toEqual(every);
    expect(USAGE_FIELDS.filter((field) => agent?.usage[field] === undefined)).toEqual([]);
  });

  test('a silent provider is counted in calls and absent from tokens', () => {
    const { recorder } = setup();
    recorder.emit(WORKSPACE_RUN_ID, { type: 'model_call', source: 'platform' });
    recorder.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'platform', usage: { input: 0, output: 0 },
    });

    const platform = recorder.spendByProducer().get('platform');
    // Reported zeros are a report, not silence.
    expect(platform).toMatchObject({ calls: 2, callsWithoutUsage: 1, unpricedCalls: 1 });
    expect(platform?.usage).toEqual({ input: 0, output: 0 });
  });

  test('a priced call and an unpriced one are told apart', () => {
    const { recorder } = setup();
    recorder.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'judge', usage: { input: 100, output: 10 }, usd: 0.004,
    });
    recorder.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'judge', usage: { input: 200, output: 20 },
    });

    const judge = recorder.spendByProducer().get('judge');
    expect(judge).toMatchObject({ calls: 2, callsWithoutUsage: 0, unpricedCalls: 1 });
    // Dollars are a floor; tokens are not.
    expect(judge?.usd).toBeCloseTo(0.004, 10);
    expect(judge?.usage).toEqual({ input: 300, output: 30 });
  });

  test('an empty log has no producers at all', () => {
    expect(setup().recorder.spendByProducer().size).toBe(0);
  });
});

describe('completedWorkTurns — the auto-GEPA cadence source query', () => {
  test('counts completed non-plan turns after the boundary, across runs, and only those', () => {
    const { recorder, sql, actor } = setup();

    // 25 qualifying turns across 25 runs; the first ten sit below an explicit boundary (emit stamps
    // millisecond ISO times, so batches must not share one).
    for (let i = 0; i < 10; i++) {
      recorder.emit(`run-a${i}`, { type: 'turn_end', turnIndex: 0, workMode: 'build' });
    }

    void sql`UPDATE run_events SET ts = '2026-01-01T00:00:00.000Z'
      WHERE actor_id = ${actor.actorId} AND run_id LIKE 'run-a%'`;
    const boundary = '2026-06-01T00:00:00.000Z';

    for (let i = 0; i < 15; i++) {
      recorder.emit(`run-b${i}`, { type: 'turn_end', turnIndex: 0, workMode: 'build' });
    }

    // A plan turn answers with a plan; it never ticks the improvement lane.
    recorder.emit('run-plan', { type: 'turn_end', turnIndex: 0, workMode: 'plan' });
    // A turn_end with no mode counts nothing: absence never reads as build.
    recorder.emit('run-no-mode', { type: 'turn_end', turnIndex: 0 });

    expect(recorder.completedWorkTurns(null)).toBe(25);
    expect(recorder.completedWorkTurns(boundary)).toBe(15);
  });

  test('an empty log has a zero denominator', () => {
    expect(setup().recorder.completedWorkTurns(null)).toBe(0);
  });
});

describe('RunEventRecorder.latestRunHeader', () => {
  /** A run the person started, recorded as `processTurn` records a user turn: under its own id. */
  const asked = (text: string) => ({
    type: 'run_start' as const, agentId: 'a', userMessage: text,
    turn: { turnId: `turn-${text}`, messageId: `msg-${text}`, kind: 'user' as const, text },
  });

  test('the newest real run leads, over many intervening events and the reserved aggregate', () => {
    const { recorder } = setup();

    recorder.emit('run-older', asked('older task'));
    recorder.emit('run-older', { type: 'run_end', reason: 'completed' });
    recorder.emit('run-newest', asked('newest task'));

    // Rows between the boundaries exist to be skipped; skipping them is the cost claim.
    for (let i = 0; i < 400; i++) {
      recorder.emit('run-newest', { type: 'error', message: `noise ${i}` });
    }

    recorder.emit('run-newest', { type: 'run_end', reason: 'error' });
    // Written last so a newest-row read missing the exclusion would lead with it.
    recorder.emit(WORKSPACE_RUN_ID, { type: 'model_call', source: 'judge' });

    expect(recorder.latestRunHeader()).toEqual({ status: 'error', userMessage: 'newest task' });
  });

  test('an unsealed run reports no status rather than a guessed one', () => {
    const { recorder } = setup();

    recorder.emit('run-open', asked('still going'));

    expect(recorder.latestRunHeader()).toEqual({ status: null, userMessage: 'still going' });
  });

  test('an empty log has no header, and a run with no start has no task', () => {
    const { recorder } = setup();

    expect(recorder.latestRunHeader()).toBeNull();

    recorder.emit('run-bare', { type: 'run_end', reason: 'completed' });

    expect(recorder.latestRunHeader()).toEqual({ status: 'completed', userMessage: null });
  });

  test("a run the harness opened, or one recorded without a turn, never gives the person's words", () => {
    const { recorder } = setup();

    recorder.emit('run-person', asked('Sort the receipts'));
    recorder.emit('run-person', { type: 'run_end', reason: 'completed' });
    // As the inbox queues a signal: stamped the harness's and keyed `programmatic:`.
    recorder.emit('run-genesis', {
      type: 'run_start', agentId: 'a', caused_by: 'workspace_created', userMessage: 'This workspace has just been created.',
      turn: {
        turnId: 'programmatic:sig-1', messageId: 'msg-genesis', kind: 'programmatic', text: 'This workspace has just been created.',
        metadata: { kinuEvent: 'workspace_created', kinuAuthor: 'harness' },
      },
    });
    recorder.emit('run-genesis', { type: 'run_end', reason: 'error' });
    recorder.emit('run-side', { type: 'run_start', agentId: 'a', userMessage: 'a side lane' });

    expect(recorder.latestRunHeader()).toEqual({ status: null, userMessage: 'Sort the receipts' });
  });

  test("the person's words outlast any run of automation after them", () => {
    const { recorder } = setup();

    recorder.emit('run-person', asked('Reconcile March'));

    for (let index = 0; index < 120; index++) {
      const id = `drain-${String(index)}`;

      recorder.emit(`run-${id}`, {
        type: 'run_start', agentId: 'a', caused_by: 'background_jobs', userMessage: 'Two jobs finished.',
        turn: {
          turnId: `programmatic:${id}`, messageId: `msg-${id}`, kind: 'programmatic', text: 'Two jobs finished.',
          metadata: { kinuEvent: 'background_jobs', kinuAuthor: 'harness' },
        },
      });
    }

    expect(recorder.latestRunHeader()?.userMessage).toBe('Reconcile March');
  });
});

describe('RunEventRecorder.openTurn — the continuation ledger', () => {
  const turn = { turnId: 'turn-1', messageId: 'msg-1', kind: 'user' as const, text: 'go', pendingSendId: 'steer-a' };

  test('a run sealed by run_end is not open', () => {
    const { recorder } = setup();
    recorder.emit('run-1', { type: 'run_start', agentId: 'a', turn });
    recorder.emit('run-1', { type: 'run_end', reason: 'completed' });
    expect(recorder.openTurn()).toBeNull();
  });

  test('a run without a turn identity is a side lane, not a turn to re-open', () => {
    const { recorder } = setup();
    recorder.emit('run-1', { type: 'run_start', agentId: 'a' });
    expect(recorder.openTurn()).toBeNull();
  });

  test('an open run whose start row cannot be read is said so, by run id, not silently passed over', () => {
    const { recorder, sql, actor } = setup();
    const log = createRecordingLogger();
    const restore = setDiagnosticsSink(log);

    try {
      expect(sql`INSERT INTO run_events (actor_id, run_id, event_index, type, ts, payload)
          VALUES (${actor.actorId}, ${'run-unreadable'}, ${1}, ${'run_start'}, ${new Date().toISOString()}, ${'{"type":"run_start"'})`).toEqual([]);

      expect(() => recorder.openTurn()).toThrow();
    } finally {
      restore();
    }

    // A start row naming no turn is a side lane; the ledger says which run it passed over.
    const side = setup();
    const sideLog = createRecordingLogger();
    const restoreSide = setDiagnosticsSink(sideLog);

    try {
      side.recorder.emit('run-side', { type: 'run_start', agentId: 'a' });
      expect(side.recorder.openTurn()).toBeNull();
      expect(sideLog.emitted.map((line) => [line.event, line.fields.run])).toEqual([['run.open_without_turn', 'run-side']]);
    } finally {
      restoreSide();
    }
  });

  test('the open run answers its turn, the finished steps and the cut step\'s newest partial', () => {
    const { recorder } = setup();
    recorder.emit('run-1', { type: 'run_start', agentId: 'a', turn });
    recorder.emit('run-1', { type: 'step_partial', stepIndex: 1, text: 'thi', toolCalls: [] });
    recorder.emit('run-1', { type: 'step_finish', stepIndex: 1, messages: [{ role: 'assistant', content: 'think' }] });
    recorder.emit('run-1', { type: 'step_partial', stepIndex: 2, text: '', toolCalls: [{ toolCallId: 'c1', toolName: 'file', args: { path: 'a' } }] });
    recorder.emit('run-1', { type: 'step_partial', stepIndex: 2, text: 'and', toolCalls: [{ toolCallId: 'c1', toolName: 'file', args: { path: 'a' }, result: 'ok' }] });

    const open = recorder.openTurn();
    expect(open?.runId).toBe('run-1');
    expect(open?.turn).toEqual(turn);
    expect(open?.steps).toEqual([{ role: 'assistant', content: 'think' }]);
    expect(open?.partial).toMatchObject({ stepIndex: 2, text: 'and', toolCalls: [{ toolCallId: 'c1', result: 'ok' }] });
  });

  test('a partial the step then finished is superseded by the step row', () => {
    const { recorder } = setup();
    recorder.emit('run-1', { type: 'run_start', agentId: 'a', turn });
    recorder.emit('run-1', { type: 'step_partial', stepIndex: 1, text: 'par', toolCalls: [] });
    recorder.emit('run-1', { type: 'step_finish', stepIndex: 1, messages: [{ role: 'assistant', content: 'partial then done' }] });

    const open = recorder.openTurn();
    expect(open?.steps).toEqual([{ role: 'assistant', content: 'partial then done' }]);
    expect(open?.partial).toBeNull();
  });

  test('the newest open run wins when a dead process left more than one', () => {
    const { recorder } = setup();
    recorder.emit('run-1', { type: 'run_start', agentId: 'a', turn: { ...turn, turnId: 'older' } });
    recorder.emit('run-2', { type: 'run_start', agentId: 'a', turn: { ...turn, turnId: 'newer' } });
    expect(recorder.openTurn()?.turn.turnId).toBe('newer');
  });
});
