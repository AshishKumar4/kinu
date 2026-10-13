/** A caller-supplied `limit` must never reach SQL unclamped: SQLite reads `LIMIT -1` as no limit,
 *  rejects NaN, and an empty page (`LIMIT 0`) means the history is exhausted. */

import { describe, test, expect } from 'bun:test';
import { BackgroundJobStore, initBackgroundJobsTable } from '../src/jobs/store';
import { boundedInt } from '../src/utils/bounds';
import { initRunEventTables, RunEventRecorder } from '../src/events/recorder';
import { getRunSummaries, listRuns } from '../src/read-models/runs';
import { getRunTimeline } from '../src/read-models/timeline';
import { initAllTables } from '../src/state/workspace-schema';
import { createTestActors, createTestSql } from '@kinu.run/test-utils';

function seededRuns(count: number) {
  const { sql, execRaw } = createTestSql();
  initAllTables(execRaw, sql);
  initRunEventTables(execRaw);
  initBackgroundJobsTable(execRaw);
  // Job store and run-event log are actor-scoped; the recorder writes under the actor the spine reads.
  const actor = createTestActors(sql, execRaw).main;
  const recorder = new RunEventRecorder(sql, actor);

  for (let i = 0; i < count; i++) {
    recorder.emit(`run-${String(i).padStart(4, '0')}`, { type: 'run_start', agentId: 'a' });
  }

  return { recorder, sql, actor };
}

describe('the run list page is closed against every caller value', () => {
  test('a negative limit yields a page, never the empty page that means exhausted', () => {
    const { recorder } = seededRuns(5);
    const page = listRuns(recorder, null, -1);
    // `-1 + 1` must not bind as `LIMIT 0` and answer "no runs".
    expect(page.items.length).toBe(1);
    expect(page.items.length).toBeGreaterThan(0);
  });

  test('an unparseable limit means unstated and takes the default', () => {
    const { recorder } = seededRuns(5);
    expect(listRuns(recorder, null, Number.NaN).items.length).toBe(5);
    expect(listRuns(recorder, null, Number.POSITIVE_INFINITY).items.length).toBe(5);
  });

  test('a fractional limit truncates instead of failing the query', () => {
    const { recorder } = seededRuns(5);
    expect(listRuns(recorder, null, 2.7).items.length).toBe(2);
    expect(listRuns(recorder, null, 0.5).items.length).toBe(1);
  });

  test('a bounded page still reports the rest of the history as reachable', () => {
    // A ceiling yields a page with `next`, not truncation: the remainder stays reachable.
    const { recorder } = seededRuns(205);
    const page = listRuns(recorder, null, 1e9);

    if (page.status !== 'more') throw new Error('expected runs behind a clamped page');
    const rest = listRuns(recorder, page.next, 1e9);
    expect(page.items.length + rest.items.length).toBe(205);
  });

  test('a page holding the whole history says end, and has no cursor to read', () => {
    const { recorder } = seededRuns(5);
    const page = listRuns(recorder, null, 50);
    expect(page.status).toBe('end');
    expect(page.items.length).toBe(5);
  });

  test('summaries inherit the same bound, being the same window folded', () => {
    const { recorder } = seededRuns(205);
    expect(getRunSummaries(recorder, null, -1).items.length).toBe(1);
  });
});

describe('the merged timeline is closed against every caller value', () => {
  function timelineDeps(runs: number) {
    const { recorder, sql, actor } = seededRuns(1);

    for (let i = 0; i < runs; i++) {
      recorder.emit('run-0000', { type: 'error', message: `e${i}` });
      void sql`INSERT INTO evolution_events (actor_id, id, type, message, created_at)
        VALUES (${actor.actorId}, ${`ev-${i}`}, ${'note'}, ${`m${i}`}, ${1000 + i})`;
    }

    return {
      deps: {
        sql, actor, events: recorder, jobs: new BackgroundJobStore(sql, actor), currentRunId: 'run-0000',
      },
      recorder,
    };
  }

  test('a negative limit does not read whole tables, nor invert the tail slice', () => {
    const { deps } = timelineDeps(12);
    // `spans.slice(-limit)` with -1 becomes `slice(1)`, dropping spans off the front.
    const spans = getRunTimeline(deps, { limit: -1 });
    expect(spans.length).toBe(1);
  });

  test('an unparseable or fractional limit does not fail the query', () => {
    const { deps } = timelineDeps(12);
    expect(getRunTimeline(deps, { limit: Number.NaN }).length).toBeGreaterThan(0);
    expect(getRunTimeline(deps, { limit: 3 }).length).toBe(3);
    expect(getRunTimeline(deps, { limit: 2.7 }).length).toBe(2);
  });

  test('an oversized limit clamps rather than merging four unbounded reads', () => {
    const seeded = 450;
    const { deps } = timelineDeps(seeded);
    const spans = getRunTimeline(deps, { limit: 1e9 });
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.length).toBeLessThan(seeded * 2);
  });

  test('the recorded widest legitimate ask is still honoured exactly', () => {
    const { deps } = timelineDeps(300);
    expect(getRunTimeline(deps, { limit: 250 })).toHaveLength(250);
  });
});

describe('boundedInt is the one shape a row bound may take', () => {
  test('absent and non-finite both mean unstated', () => {
    expect(boundedInt(undefined, 7, 1, 10)).toBe(7);
    expect(boundedInt(Number.NaN, 7, 1, 10)).toBe(7);
    expect(boundedInt(Number.POSITIVE_INFINITY, 7, 1, 10)).toBe(7);
    expect(boundedInt(Number.NEGATIVE_INFINITY, 7, 1, 10)).toBe(7);
  });

  test('a stated value clamps into range', () => {
    expect(boundedInt(-5, 7, 1, 10)).toBe(1);
    expect(boundedInt(0, 7, 1, 10)).toBe(1);
    expect(boundedInt(99, 7, 1, 10)).toBe(10);
    expect(boundedInt(5, 7, 1, 10)).toBe(5);
  });

  test('a fraction truncates toward zero, then clamps', () => {
    expect(boundedInt(2.9, 7, 1, 10)).toBe(2);
    expect(boundedInt(0.5, 7, 1, 10)).toBe(1);
    expect(boundedInt(-0.5, 7, 1, 10)).toBe(1);
  });

  test('the fallback itself is clamped, so no surface can default out of range', () => {
    expect(boundedInt(undefined, 99, 1, 10)).toBe(10);
    expect(boundedInt(undefined, -3, 1, 10)).toBe(1);
  });
});
