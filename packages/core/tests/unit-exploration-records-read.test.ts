// The record read models, over real SQLite rows written by the real writer.
//
// WHY REAL ROWS AND A REAL WRITER. Every defect these reads exist to prevent is
// SQL-shaped or writer-shaped, and none of them is reachable against a fake:
//
//   - `NULL = NULL` is unknown, so an objective with no floor and the cell of an
//     objective with no descriptor partition both match NOTHING under `=`. A map
//     standing in for a database compares them with `===` and passes.
//   - `COUNT(DISTINCT descriptor)` skips NULLs, so the no-partition cell counts as zero
//     cells unless it is added back — a set that covers one cell reporting coverage of
//     none.
//   - A cursor that seeks on `value` alone loses exactly the boundary row when the
//     boundary falls inside a tie, and a suite whose page never crosses a tie cannot see
//     it. Every walk below crosses one.
//   - The identity columns are only worth reading if they cannot disagree with the
//     digest beside them, and that is a property of what the WRITER writes.
//
// The identity re-hash test is the one that turns a future divergence into a failure:
// it takes a stored row's four displayed identity fields plus the verifier digest, hashes
// them with the store's own `objectiveIdOf`, and requires the result to be that row's own
// `objective_id`. A column that drifts from the key is then red here instead of being a
// leaderboard captioned with the wrong unit.
//
// Specified by docs/EXPLORATION.md — "The records store", "The archive" and
// "Comparability"; the population bound the paging answers is
// `lean/Proteus/Exploration/ArchiveAdmission.lean — separated_cells_are_unboundedly_large`.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw } from './helpers';
import {
  cellOccupants, describeObjective, initExplorationRecordsTable, objectiveIdOf,
  recordExploration, recordHandleOf, verifierDigestOf,
  type ExplorationWrite, type RecordObjectiveHandle,
} from '../src/strategy/records';
import {
  listRecordCells, listRecordObjectives, readRecordCell,
} from '../src/read-models/exploration-records';
import { StaleCursorError, type Page, type SeekCursor } from '../src/read-models/page';
import type { Floor, ObjectiveIdentity, PublicationState } from '../src/strategy/objective';
import type { SqlExecutor } from '../src/types/primitives';

const OPEN: PublicationState = { kind: 'open' };

/** MINIMISE, and published under NO FLOOR — so its `floor_digest` is NULL and every
 *  read of it is a live test of `IS` over `=`. */
const CALLS: ObjectiveIdentity = {
  metric: 'oracle_calls',
  unit: 'oracle calls',
  direction: 'minimise',
  scale: 'log',
  verifierDigest: verifierDigestOf(
    { kind: 'exec-ratio', spec: { params: { n: 24 } } }, 'exec-ratio@abc123',
  ),
};

/** MAXIMISE, under a floor, and partitioned — the archive-shaped objective. Its
 *  direction is the OPPOSITE of the one above, so a read that hardcodes either one is
 *  red on the other. */
const PASS: ObjectiveIdentity = {
  metric: 'pass_rate',
  unit: 'fraction of held-out tasks',
  direction: 'maximise',
  scale: 'linear',
  verifierDigest: verifierDigestOf({ kind: 'exec-ratio', spec: { params: { n: 8 } } }, 'suite@f00d'),
};

const FLOOR: Floor = {
  value: 0.4,
  kind: 'certificate',
  bestKnownHonest: 0.62,
  proof: 'The held-out suite admits no solution below the reference implementation.',
};

const T0 = 1_700_000_000_000;

function store(): SqlExecutor {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  initExplorationRecordsTable(makeExecRaw(db), sql);
  return sql;
}

function write(over: Partial<ExplorationWrite>): ExplorationWrite {
  return {
    identity: CALLS,
    descriptor: null,
    artifact: 'export function solve() { return 1; }',
    value: 23,
    detail: '23 oracle calls',
    measured: null,
    preset: 'optimise',
    label: null,
    rootId: 'root-1',
    configDigest: 'cfg-1',
    depth: 5,
    branches: 3,
    floor: null,
    costUsd: null,
    costTokens: null,
    at: T0,
    ...over,
  };
}

const CALLS_HANDLE: RecordObjectiveHandle = recordHandleOf({ identity: CALLS, floor: null });
const PASS_HANDLE: RecordObjectiveHandle = recordHandleOf({ identity: PASS, floor: FLOOR });

/**
 * The seeded workspace every read below is asked about. Two comparable sets:
 *
 *   CALLS — no floor, NO descriptor partition, 3 rows in its one cell.
 *   PASS  — under FLOOR, partitioned across THREE cells; the `len=short` cell holds
 *           FIVE occupants, three of them TIED on value and two of those three sharing
 *           `first_recorded_at`, so a page boundary inside the tie is reachable.
 */
function seeded(): SqlExecutor {
  const sql = store();
  for (const [index, value] of [41, 23, 88].entries()) {
    recordExploration(sql, {
      publication: OPEN,
      write: write({ artifact: `calls-${String(index)}`, value, at: T0 + index }),
    });
  }
  const partitioned: ReadonlyArray<readonly [string, number, number]> = [
    ['len=short', 0.71, T0 + 10],
    ['len=short', 0.5, T0 + 11],
    ['len=short', 0.5, T0 + 11],
    ['len=short', 0.5, T0 + 12],
    ['len=short', 0.44, T0 + 13],
    ['len=medium', 0.66, T0 + 14],
    ['len=long', 0.6, T0 + 15],
    ['len=long', 0.58, T0 + 16],
  ];
  for (const [index, [descriptor, value, at]] of partitioned.entries()) {
    recordExploration(sql, {
      publication: OPEN,
      write: write({
        identity: PASS, floor: FLOOR, descriptor, value, at,
        artifact: `pass artifact ${String(index)} unique tokens ${String(index)}`,
      }),
    });
  }
  return sql;
}

/** Walk a paged read to exhaustion, asserting the walk TERMINATES and returning every
 *  item in order. The step cap is the guard against a cursor that never advances: an
 *  infinite walk would otherwise hang the suite rather than fail it. */
function walk<Item>(read: (cursor: SeekCursor | null) => Page<Item>): readonly Item[] {
  const items: Item[] = [];
  let cursor: SeekCursor | null = null;
  for (let step = 0; step < 50; step += 1) {
    const page: Page<Item> = read(cursor);
    items.push(...page.items);
    if (page.status === 'end') return items;
    cursor = page.next;
  }
  throw new Error('the walk did not reach `end` in 50 pages');
}

describe('a stored identity cannot disagree with the digest beside it', () => {
  test("every row's stored identity re-hashes to its own objective_id", () => {
    // THE RED DIRECTION: drop any of the five identity columns from the INSERT in
    // `recordExploration`, or write a constant in place of one, and this goes red — the
    // re-hash no longer lands on the key. That is what makes the denormalisation safe to
    // read rather than a second copy that has to be trusted.
    const sql = seeded();
    const rows = sql<{
      objective_id: string; metric: string; unit: string;
      direction: string; scale: string; verifier_digest: string;
    }>`SELECT objective_id, metric, unit, direction, scale, verifier_digest
         FROM exploration_records`;
    // The denominator: a re-hash test over zero rows passes while proving nothing.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toHaveLength(11);
    for (const row of rows) {
      expect(objectiveIdOf({
        metric: row.metric,
        unit: row.unit,
        // Cast-free: `objectiveIdOf` hashes the strings it is given, and a stored value
        // outside the union would hash to something other than the key — which is the
        // failure this asserts, not a type to be asserted away.
        direction: row.direction === 'minimise' ? 'minimise' : 'maximise',
        scale: row.scale === 'log' ? 'log' : 'linear',
        verifierDigest: row.verifier_digest,
      })).toBe(row.objective_id);
    }
    // And both directions are actually present, so the ternaries above are not both
    // taking one branch.
    expect(new Set(rows.map((row) => row.direction))).toEqual(new Set(['minimise', 'maximise']));
  });

  test('a re-record of a row written before the identity columns existed fills them', () => {
    // The only backfill available, and it is derived rather than guessed: the writer
    // holds the identity that hashes to the row's own key. Simulated by blanking the
    // columns, which is exactly the state `reconcileColumns` leaves an old row in.
    const sql = store();
    recordExploration(sql, { publication: OPEN, write: write({ value: 40 }) });
    void sql`UPDATE exploration_records SET metric = NULL, unit = NULL, direction = NULL,
               scale = NULL, verifier_digest = NULL`;
    expect(describeObjective(sql, CALLS_HANDLE)).toEqual({ identity: null, rows: 1 });

    // A BETTER value, because the monotone rule refuses anything else — the backfill
    // rides the write that was going to happen, not a repair pass nobody triggers.
    expect(recordExploration(sql, { publication: OPEN, write: write({ value: 12 }) }).kind)
      .toBe('recorded');
    expect(describeObjective(sql, CALLS_HANDLE)).toEqual({ identity: CALLS, rows: 1 });
  });
});

describe('listRecordObjectives — the discovery read the store had none of', () => {
  test('both comparable sets, each saying what it MEASURED', () => {
    const page = listRecordObjectives(seeded());
    expect(page.status).toBe('end');
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.map((item) => [item.metric, item.unit, item.direction, item.scale])).toEqual([
      // Most recently written first: PASS's last row is at T0+16, CALLS's at T0+2.
      ['pass_rate', 'fraction of held-out tasks', 'maximise', 'linear'],
      ['oracle_calls', 'oracle calls', 'minimise', 'log'],
    ]);
    const [pass, calls] = page.items;
    expect(pass?.objectiveId).toBe(PASS_HANDLE.objectiveId);
    expect(pass?.floorDigest).toBe(PASS_HANDLE.floorDigest);
    expect(calls?.floorDigest).toBeNull();
  });

  test('`cells` counts the NO-PARTITION cell as one cell, not as none', () => {
    // THE RED DIRECTION: drop the `unpartitioned > 0` term and CALLS reports 0 cells
    // while holding 3 rows — a set that covers a cell reporting coverage of nothing.
    // `COUNT(DISTINCT descriptor)` skips NULLs, so this is the SQL's default behaviour
    // and not a hypothetical.
    const items = listRecordObjectives(seeded()).items;
    expect(items.length).toBeGreaterThan(0);
    const byMetric = new Map(items.map((item) => [item.metric, item]));
    expect(byMetric.get('oracle_calls')?.cells).toBe(1);
    expect(byMetric.get('oracle_calls')?.rows).toBe(3);
    expect(byMetric.get('pass_rate')?.cells).toBe(3);
    expect(byMetric.get('pass_rate')?.rows).toBe(8);
  });

  test("`best` is each set's best in ITS OWN direction, across every cell", () => {
    // The two sets disagree about which way better is, so a read that hardcoded one
    // reports the worst row of the other as its leader.
    const items = listRecordObjectives(seeded()).items;
    expect(items.length).toBeGreaterThan(0);
    const byMetric = new Map(items.map((item) => [item.metric, item]));
    expect(byMetric.get('oracle_calls')?.best?.value).toBe(23);
    expect(byMetric.get('pass_rate')?.best?.value).toBe(0.71);
    expect(byMetric.get('pass_rate')?.lastRecordedAt).toBe(T0 + 16);
  });

  test('a set whose rows predate the identity columns is not listed', () => {
    // THE RED DIRECTION: remove the `HAVING MAX(metric) IS NOT NULL` and this set is
    // listed — which means choosing a direction to sort a column of unlabelled reals by.
    // The listing must not invent one; see the module header.
    const sql = seeded();
    void sql`UPDATE exploration_records SET metric = NULL, unit = NULL, direction = NULL,
               scale = NULL, verifier_digest = NULL
             WHERE objective_id = ${CALLS_HANDLE.objectiveId}`;
    const items = listRecordObjectives(sql).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.map((item) => item.metric)).toEqual(['pass_rate']);
  });

  test('asking about such a set DIRECTLY raises rather than answering "no rows"', () => {
    // A populated set reported as empty is the one answer a caller acts on by doing
    // nothing. Rows that exist and cannot be described are a fault, and an unknown
    // handle is an empty page — the two must not look alike.
    const sql = seeded();
    void sql`UPDATE exploration_records SET metric = NULL, direction = NULL
             WHERE objective_id = ${CALLS_HANDLE.objectiveId}`;
    expect(() => listRecordCells(sql, CALLS_HANDLE)).toThrow(/before the store recorded/);
    expect(() => readRecordCell(sql, { ...CALLS_HANDLE, descriptor: null }))
      .toThrow(/before the store recorded/);
    // …and a handle the store genuinely holds nothing under is an empty page.
    const unknown: RecordObjectiveHandle = { objectiveId: 'nope', floorDigest: null };
    expect(listRecordCells(sql, unknown)).toEqual({ status: 'end', items: [] });
    expect(readRecordCell(sql, { ...unknown, descriptor: null })).toEqual({ status: 'end', items: [] });
  });

  test('the walk pages without repeating or dropping a set', () => {
    const sql = seeded();
    const whole = listRecordObjectives(sql).items;
    expect(whole.length).toBeGreaterThan(1);
    const paged = walk((cursor) => listRecordObjectives(sql, cursor, 1));
    expect(paged.map((item) => item.objectiveId)).toEqual(whole.map((item) => item.objectiveId));
  });

  test('a cursor naming a set the store no longer holds RAISES', () => {
    const sql = seeded();
    const first = listRecordObjectives(sql, null, 1);
    expect(first.status).toBe('more');
    if (first.status !== 'more') return;
    void sql`DELETE FROM exploration_records WHERE objective_id = ${PASS_HANDLE.objectiveId}`;
    expect(() => listRecordObjectives(sql, first.next, 1)).toThrow(StaleCursorError);
    // A cursor that is not even parseable is stale too — an unreadable position must not
    // report everything behind it as exhausted.
    expect(() => listRecordObjectives(sql, { after: 'not json' }, 1)).toThrow(StaleCursorError);
  });
});

describe('listRecordCells — the grid, with the no-partition cell distinguished', () => {
  test("a partitioned set's cells, each with its own elite and occupancy", () => {
    const page = listRecordCells(seeded(), PASS_HANDLE);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.map((cell) => [cell.descriptor, cell.occupants, cell.elite?.value])).toEqual([
      ['len=long', 2, 0.6],
      ['len=medium', 1, 0.66],
      ['len=short', 5, 0.71],
    ]);
  });

  test('`descriptor: null` is the NO-PARTITION cell, and `\'\'` is a different cell', () => {
    // THE RED DIRECTION: change `descriptor IS` to `descriptor =` anywhere below and the
    // null cell vanishes entirely — `descriptor = NULL` is unknown for every row. The
    // empty-string cell is here because a delimited cursor would collapse the two, which
    // is why the cursor is JSON.
    const sql = seeded();
    recordExploration(sql, {
      publication: OPEN,
      write: write({ descriptor: '', artifact: 'unnamed cell artifact', value: 19, at: T0 + 3 }),
    });
    const cells = listRecordCells(sql, CALLS_HANDLE).items;
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.map((cell) => [cell.descriptor, cell.occupants])).toEqual([
      [null, 3],
      ['', 1],
    ]);
    // Each cell's elite is its own — the no-partition cell's best is not the '' cell's.
    expect(cells[0]?.elite?.value).toBe(23);
    expect(cells[1]?.elite?.value).toBe(19);
  });

  test('the walk pages across the null/named boundary without repeating or dropping', () => {
    // The boundary that matters here is the FIRST one: the no-partition cell sorts ahead
    // of every named cell, so a seek that compared descriptors directly would restart at
    // the null cell forever or skip past every named one.
    const sql = seeded();
    recordExploration(sql, {
      publication: OPEN,
      write: write({
        identity: PASS, floor: FLOOR, descriptor: null, value: 0.51,
        artifact: 'unpartitioned pass artifact', at: T0 + 17,
      }),
    });
    const whole = listRecordCells(sql, PASS_HANDLE).items;
    expect(whole.map((cell) => cell.descriptor)).toEqual([null, 'len=long', 'len=medium', 'len=short']);
    const paged = walk((cursor) => listRecordCells(sql, PASS_HANDLE, cursor, 1));
    expect(paged.map((cell) => cell.descriptor)).toEqual(whole.map((cell) => cell.descriptor));
    expect(paged.map((cell) => cell.occupants)).toEqual(whole.map((cell) => cell.occupants));
  });
});

describe('readRecordCell — an unbounded population, paged', () => {
  test("a cell's population comes back best first, in the objective's direction", () => {
    const sql = seeded();
    const page = readRecordCell(sql, { ...PASS_HANDLE, descriptor: 'len=short' });
    expect(page.status).toBe('end');
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.map((row) => row.value)).toEqual([0.71, 0.5, 0.5, 0.5, 0.44]);
    // The unpaged occupancy read the archive admits against agrees exactly, because both
    // are the same query body.
    expect(page.items.map((row) => row.artifactDigest)).toEqual(
      cellOccupants(sql, { identity: PASS, floor: FLOOR, descriptor: 'len=short' })
        .map((row) => row.artifactDigest),
    );
  });

  test('paging a cell CROSSES a tie and neither drops nor repeats the boundary row', () => {
    // THE DEFECT THIS EXISTS FOR: three of these five occupants are tied at 0.5 and two
    // of those share `first_recorded_at`, so pages of two put a boundary INSIDE the tie
    // — twice. A seek on `value` alone drops the rest of the tie; a non-strict seek
    // repeats the boundary row. A walk whose page never crosses a tie sees neither.
    const sql = seeded();
    const handle = { ...PASS_HANDLE, descriptor: 'len=short' };
    const whole = readRecordCell(sql, handle, null, 100).items;
    expect(whole).toHaveLength(5);
    const tied = whole.filter((row) => row.value === 0.5);
    expect(tied.length).toBeGreaterThan(1);

    for (const limit of [1, 2, 3, 4]) {
      const paged = walk((cursor) => readRecordCell(sql, handle, cursor, limit));
      const digests = paged.map((row) => row.artifactDigest);
      expect(digests).toEqual(whole.map((row) => row.artifactDigest));
      expect(new Set(digests).size).toBe(whole.length);
    }
  });

  test('a page that says `more` names its own resume point, and `end` cannot be faked', () => {
    const sql = seeded();
    const handle = { ...PASS_HANDLE, descriptor: 'len=short' };
    const first = readRecordCell(sql, handle, null, 2);
    expect(first.status).toBe('more');
    if (first.status !== 'more') return;
    // The cursor is the LAST DELIVERED row's identity, so the next page starts strictly
    // after it — not at it.
    expect(first.next.after).toBe(first.items[1]?.artifactDigest);
    const second = readRecordCell(sql, handle, first.next, 2);
    expect(second.items.map((row) => row.artifactDigest))
      .not.toContain(first.items[1]?.artifactDigest);
    // A FULL page is not an exhausted one: 5 occupants at 2 per page is 2 + 2 + 1, and
    // the second page is full. `seekPage` over-fetches by one, so `end` is only ever
    // reported about a query that ran off the end of the data.
    expect(second.status).toBe('more');
    if (second.status !== 'more') return;
    const third = readRecordCell(sql, handle, second.next, 2);
    expect(third.status).toBe('end');
    expect(third.items).toHaveLength(1);
  });

  test('a cursor for an occupant that left the cell RAISES', () => {
    const sql = seeded();
    const handle = { ...PASS_HANDLE, descriptor: 'len=short' };
    const first = readRecordCell(sql, handle, null, 2);
    if (first.status !== 'more') throw new Error('the fixture must page');
    void sql`DELETE FROM exploration_records WHERE artifact_digest = ${first.next.after}`;
    expect(() => readRecordCell(sql, handle, first.next, 2)).toThrow(StaleCursorError);
  });

  test('the unfloored set reads through `IS`, and the floored one is a different set', () => {
    // THE RED DIRECTION: `floor_digest = ${null}` matches no row at all, so CALLS — which
    // declared no floor — reads as empty everywhere. And the same objective under a floor
    // is a DIFFERENT comparable set, which is what keeps a corrected floor separable from
    // a wrong one.
    const sql = seeded();
    const unfloored = readRecordCell(sql, { ...CALLS_HANDLE, descriptor: null });
    expect(unfloored.items.length).toBeGreaterThan(0);
    expect(unfloored.items.map((row) => row.value)).toEqual([23, 41, 88]);

    const floored = recordHandleOf({ identity: CALLS, floor: FLOOR });
    expect(floored.floorDigest).not.toBeNull();
    expect(readRecordCell(sql, { ...floored, descriptor: null }))
      .toEqual({ status: 'end', items: [] });
  });
});
