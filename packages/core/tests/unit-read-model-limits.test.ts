/**
 * Limit bounds on the two run-log read models that a caller can reach without
 * passing through the run-events HTTP route: the run LIST page (`listRuns`,
 * `getRunSummaries`) and the merged TIMELINE (`getRunTimeline`, a `@callable`).
 *
 * The shared defect: a caller-supplied `limit` reached `LIMIT` binds unclosed.
 * SQLite reads `LIMIT -1` as no limit and rejects a fraction or `NaN` as a
 * datatype mismatch, so the same value could either read a whole table or 500
 * the request. The run list had a third failure mode of its own — `limit + 1`
 * reaching SQL as `LIMIT 0`, and an empty page is how this read model says the
 * history behind the cursor is EXHAUSTED.
 */

import { describe, test, expect } from 'bun:test';
// Imported per module rather than through `../src/index`: this suite is about
// four specific read models, and the barrel drags in every unrelated module
// being edited beside them.
import { BackgroundJobStore, initBackgroundJobsTable } from '../src/jobs/store';
import { boundedInt } from '../src/utils/bounds';
import { initRunEventTables, RunEventRecorder } from '../src/events/recorder';
import { getRunSummaries, listRuns } from '../src/read-models/runs';
import { getRunTimeline } from '../src/read-models/timeline';
import { initAllTables } from '../src/identity/schema';
import { createTestSql } from '@kinu.run/test-utils';

/** `count` distinct runs in the log, one event each, so a page bound is
 *  observable as a row count. */
function seededRuns(count: number) {
  const { sql, execRaw } = createTestSql();
  initAllTables(execRaw, sql);
  initRunEventTables(execRaw);
  initBackgroundJobsTable(execRaw);
  const recorder = new RunEventRecorder(sql);
  for (let i = 0; i < count; i++) {
    recorder.emit(`run-${String(i).padStart(4, '0')}`, { type: 'run_start', agentId: 'a' });
  }
  return { recorder, sql };
}

describe('the run list page is closed against every caller value', () => {
  test('a negative limit yields a page, never the empty page that means exhausted', () => {
    const { recorder } = seededRuns(5);
    const page = listRuns(recorder, null, -1);
    // The defect: `-1 + 1` bound as `LIMIT 0`, so this read answered "no runs"
    // for a workspace holding five.
    expect(page.items.length).toBe(1);
    expect(page.items.length).toBeGreaterThan(0);
  });

  test('an unparseable limit means unstated and takes the default', () => {
    const { recorder } = seededRuns(5);
    // `Number('abc')` is NaN. The route used to compute Math.max(1, NaN), which
    // is NaN, and bind it — a datatype mismatch rather than a page.
    expect(listRuns(recorder, null, Number.NaN).items.length).toBe(5);
    expect(listRuns(recorder, null, Number.POSITIVE_INFINITY).items.length).toBe(5);
  });

  test('a fractional limit truncates instead of failing the query', () => {
    const { recorder } = seededRuns(5);
    expect(listRuns(recorder, null, 2.7).items.length).toBe(2);
    expect(listRuns(recorder, null, 0.5).items.length).toBe(1);
  });

  test('an oversized limit clamps to the ceiling the route already enforced', () => {
    const { recorder } = seededRuns(205);
    expect(listRuns(recorder, null, 1e9).items.length).toBe(200);
    expect(listRuns(recorder, null, Number.MAX_SAFE_INTEGER).items.length).toBe(200);
  });

  test('a bounded page still reports the rest of the history as reachable', () => {
    // Why a ceiling here is a page and not the truncation a prior decision
    // rejected: the remainder stays reachable. `Page` is a variant on `status`
    // precisely so `next` cannot be read without observing which state this is,
    // which is what stops a caller mistaking a full page for the end of the log.
    const { recorder } = seededRuns(205);
    const page = listRuns(recorder, null, 1e9);
    if (page.status !== 'more') throw new Error('expected runs behind a clamped page');
    expect(page.items.length).toBe(200);
    expect(page.next.after).toBeTruthy();
  });

  test('a page holding the whole history says end, and has no cursor to read', () => {
    const { recorder } = seededRuns(5);
    const page = listRuns(recorder, null, 50);
    expect(page.status).toBe('end');
    expect(page.items.length).toBe(5);
  });

  test('summaries inherit the same bound, being the same window folded', () => {
    const { recorder } = seededRuns(205);
    expect(getRunSummaries(recorder, null, 1e9).items.length).toBe(200);
    expect(getRunSummaries(recorder, null, -1).items.length).toBe(1);
    expect(getRunSummaries(recorder, null, Number.NaN).items.length).toBe(30);
  });
});

describe('the merged timeline is closed against every caller value', () => {
  /** The four spines the timeline merges, each seeded so a bound is visible in
   *  the span count rather than only in the SQL. */
  function timelineDeps(runs: number) {
    const { recorder, sql } = seededRuns(1);
    for (let i = 0; i < runs; i++) {
      recorder.emit('run-0000', { type: 'error', message: `e${i}` });
      void sql`INSERT INTO evolution_events (id, type, message, created_at)
        VALUES (${`ev-${i}`}, ${'note'}, ${`m${i}`}, ${1000 + i})`;
    }
    return {
      deps: {
        sql, events: recorder, jobs: new BackgroundJobStore(sql), currentRunId: 'run-0000',
      },
      recorder,
    };
  }

  test('a negative limit does not read whole tables, nor invert the tail slice', () => {
    const { deps } = timelineDeps(12);
    // Two failures at once: `LIMIT -1` on evolution_events and search_nodes read
    // everything, and `spans.slice(-limit)` with limit -1 becomes `slice(1)`,
    // dropping spans off the FRONT of the merged spine.
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
    const { deps } = timelineDeps(450);
    // 450 run events + 450 evolution rows would merge to 900 spans unbounded.
    expect(getRunTimeline(deps, { limit: 1e9 }).length).toBe(400);
  });

  test('the recorded widest legitimate ask is still honoured exactly', () => {
    // The chat seed's removed `getRunTimeline({ limit: 250 })` is the widest ask
    // the product ever made of this surface; the ceiling must not cut it.
    const { deps } = timelineDeps(300);
    expect(getRunTimeline(deps, { limit: 250 }).length).toBe(250);
  });

  test('an absent limit takes the default', () => {
    const { deps } = timelineDeps(300);
    expect(getRunTimeline(deps).length).toBe(200);
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

  test('an inverted range throws instead of silently answering the max', () => {
    expect(() => boundedInt(5, 5, 10, 1)).toThrow('boundedInt: min 10 exceeds max 1');
  });
});
