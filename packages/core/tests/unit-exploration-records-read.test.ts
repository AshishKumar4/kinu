// The record read models over real SQLite rows from the real writer: `NULL = NULL`,
// `COUNT(DISTINCT)` skipping NULLs, and cursors crossing ties are unreachable against a fake.
// Specified by docs/EXPLORATION.md — "The records store", "The archive" and
// "Comparability"; paging bound:
// `lean/Kinu/Exploration/ArchiveAdmission.lean — separated_cells_are_unboundedly_large`.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw } from './helpers';
import { createTestActors } from '@kinu.run/test-utils';
import type { ActorHandle } from '../src/identity/actor-handle';
import {
  cellOccupants, describeObjective, initExplorationRecordsTable, objectiveIdOf,
  recordExploration, recordHandleOf, verifierDigestOf,
  type ExplorationWrite, type RecordObjectiveHandle,
} from '../src/strategy/records';
import {
  listRecordCells, listRecordObjectives, readRecordCell,
} from '../src/read-models/exploration-records';
import { StaleCursorError, type Page, type SeekCursor } from '../src/session/page';
import type { Floor, ObjectiveIdentity, PublicationState } from '../src/strategy/objective';
import type { SqlExecutor } from '../src/types/primitives';

const OPEN: PublicationState = { kind: 'open' };

/** Minimise, no floor: `floor_digest` is NULL, so every read tests `IS` over `=`. */
const CALLS: ObjectiveIdentity = {
  metric: 'oracle_calls',
  unit: 'oracle calls',
  direction: 'minimise',
  scale: 'log',
  verifierDigest: verifierDigestOf(
    { kind: 'exec-ratio', spec: { params: { n: 24 } } }, 'exec-ratio@abc123',
  ),
};

/** Maximise, floored, partitioned: the opposite direction to {@link CALLS}. */
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

/** Records are keyed by actor, so seed and read must share one handle. */
interface RecordStore {
  readonly sql: SqlExecutor;
  readonly actor: ActorHandle;
}

function store(): RecordStore {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initExplorationRecordsTable(execRaw);

  return { sql, actor: createTestActors(sql, execRaw).main };
}

function spread(records: RecordStore): [SqlExecutor, ActorHandle] {
  return [records.sql, records.actor];
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
 * CALLS: no floor, no partition, 3 rows. PASS: floored, three cells; `len=short` holds five
 * occupants, three tied on value and two of those sharing `first_recorded_at`.
 */
function seeded(): RecordStore {
  const { sql, actor } = store();

  for (const [index, value] of [41, 23, 88].entries()) {
    recordExploration(sql, actor, {
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
    recordExploration(sql, actor, {
      publication: OPEN,
      write: write({
        identity: PASS, floor: FLOOR, descriptor, value, at,
        artifact: `pass artifact ${String(index)} unique tokens ${String(index)}`,
      }),
    });
  }

  return { sql, actor };
}

/** Walk a paged read to `end`; the step cap turns a non-advancing cursor into a failure, not a hang. */
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
    // Red if any identity column is dropped from, or constant in, the writer's INSERT.
    const { sql } = seeded();

    const rows = sql<{
      objective_id: string; metric: string; unit: string;
      direction: string; scale: string; verifier_digest: string;
    }>`SELECT objective_id, metric, unit, direction, scale, verifier_digest
         FROM exploration_records`;

    // Denominator: a re-hash over zero rows proves nothing.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toHaveLength(11);

    for (const row of rows) {
      expect(objectiveIdOf({
        metric: row.metric,
        unit: row.unit,
        // Cast-free: a stored value outside the union hashes off the key, which is the failure.
        direction: row.direction === 'minimise' ? 'minimise' : 'maximise',
        scale: row.scale === 'log' ? 'log' : 'linear',
        verifierDigest: row.verifier_digest,
      })).toBe(row.objective_id);
    }

    // Both directions present, so both ternary branches run.
    expect(new Set(rows.map((row) => row.direction))).toEqual(new Set(['minimise', 'maximise']));
  });

  test('a re-record fills blank identity columns from the writer-held identity', () => {
    const { sql, actor } = store();
    recordExploration(sql, actor, { publication: OPEN, write: write({ value: 40 }) });
    void sql`UPDATE exploration_records SET metric = NULL, unit = NULL, direction = NULL,
               scale = NULL, verifier_digest = NULL`;
    expect(describeObjective(sql, actor, CALLS_HANDLE)).toEqual({ identity: null, rows: 1 });

    // A better value, since the monotone rule refuses anything else: the backfill rides a real write.
    expect(recordExploration(sql, actor, { publication: OPEN, write: write({ value: 12 }) }).kind)
      .toBe('recorded');
    expect(describeObjective(sql, actor, CALLS_HANDLE)).toEqual({ identity: CALLS, rows: 1 });
  });
});

describe('listRecordObjectives — the discovery read the store had none of', () => {
  test('both comparable sets, each saying what it MEASURED', () => {
    const page = listRecordObjectives(...spread(seeded()));
    expect(page.status).toBe('end');
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.map((item) => [item.metric, item.unit, item.direction, item.scale])).toEqual([
      ['pass_rate', 'fraction of held-out tasks', 'maximise', 'linear'],
      ['oracle_calls', 'oracle calls', 'minimise', 'log'],
    ]);
    const [pass, calls] = page.items;
    expect(pass?.objectiveId).toBe(PASS_HANDLE.objectiveId);
    expect(pass?.floorDigest).toBe(PASS_HANDLE.floorDigest);
    expect(calls?.floorDigest).toBeNull();
  });

  test('`cells` counts the NO-PARTITION cell as one cell, not as none', () => {
    // `COUNT(DISTINCT descriptor)` skips NULLs; without the `unpartitioned > 0` term CALLS reports 0 cells.
    const items = listRecordObjectives(...spread(seeded())).items;
    expect(items.length).toBeGreaterThan(0);
    const byMetric = new Map(items.map((item) => [item.metric, item]));
    expect(byMetric.get('oracle_calls')?.cells).toBe(1);
    expect(byMetric.get('oracle_calls')?.rows).toBe(3);
    expect(byMetric.get('pass_rate')?.cells).toBe(3);
    expect(byMetric.get('pass_rate')?.rows).toBe(8);
  });

  test("`best` is each set's best in ITS OWN direction, across every cell", () => {
    // A read that hardcoded one direction would lead with the other set's worst row.
    const items = listRecordObjectives(...spread(seeded())).items;
    expect(items.length).toBeGreaterThan(0);
    const byMetric = new Map(items.map((item) => [item.metric, item]));
    expect(byMetric.get('oracle_calls')?.best?.value).toBe(23);
    expect(byMetric.get('pass_rate')?.best?.value).toBe(0.71);
    expect(byMetric.get('pass_rate')?.lastRecordedAt).toBe(T0 + 16);
  });

  test('a set whose rows predate the identity columns is not listed', () => {
    // Without `HAVING MAX(metric) IS NOT NULL` the listing would have to invent a sort direction.
    const { sql, actor } = seeded();
    void sql`UPDATE exploration_records SET metric = NULL, unit = NULL, direction = NULL,
               scale = NULL, verifier_digest = NULL
             WHERE objective_id = ${CALLS_HANDLE.objectiveId}`;
    const items = listRecordObjectives(sql, actor).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.map((item) => item.metric)).toEqual(['pass_rate']);
  });

  test('asking about such a set DIRECTLY raises rather than answering "no rows"', () => {
    // Undescribable rows are a fault, distinct from an unknown handle's empty page.
    const { sql, actor } = seeded();
    void sql`UPDATE exploration_records SET metric = NULL, direction = NULL
             WHERE objective_id = ${CALLS_HANDLE.objectiveId}`;
    expect(() => listRecordCells(sql, actor, CALLS_HANDLE)).toThrow(/before the store recorded/);
    expect(() => readRecordCell(sql, actor, { ...CALLS_HANDLE, descriptor: null }))
      .toThrow(/before the store recorded/);
    const unknown: RecordObjectiveHandle = { objectiveId: 'nope', floorDigest: null };
    expect(listRecordCells(sql, actor, unknown)).toEqual({ status: 'end', items: [] });
    expect(readRecordCell(sql, actor, { ...unknown, descriptor: null })).toEqual({ status: 'end', items: [] });
  });

  test('the walk pages without repeating or dropping a set', () => {
    const { sql, actor } = seeded();
    const whole = listRecordObjectives(sql, actor).items;
    expect(whole.length).toBeGreaterThan(1);
    const paged = walk((cursor) => listRecordObjectives(sql, actor, cursor, 1));
    expect(paged.map((item) => item.objectiveId)).toEqual(whole.map((item) => item.objectiveId));
  });

  test('a cursor naming a set the store no longer holds RAISES', () => {
    const { sql, actor } = seeded();
    const first = listRecordObjectives(sql, actor, null, 1);
    expect(first.status).toBe('more');

    if (first.status !== 'more') return;
    void sql`DELETE FROM exploration_records WHERE objective_id = ${PASS_HANDLE.objectiveId}`;
    expect(() => listRecordObjectives(sql, actor, first.next, 1)).toThrow(StaleCursorError);
    // An unparseable cursor is stale too, not exhausted.
    expect(() => listRecordObjectives(sql, actor, { after: 'not json' }, 1)).toThrow(StaleCursorError);
  });
});

describe('listRecordCells — the grid, with the no-partition cell distinguished', () => {
  test("a partitioned set's cells, each with its own elite and occupancy", () => {
    const page = listRecordCells(...spread(seeded()), PASS_HANDLE);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.map((cell) => [cell.descriptor, cell.occupants, cell.elite?.value])).toEqual([
      ['len=long', 2, 0.6],
      ['len=medium', 1, 0.66],
      ['len=short', 5, 0.71],
    ]);
  });

  test('`descriptor: null` is the NO-PARTITION cell, and `\'\'` is a different cell', () => {
    // `descriptor =` would drop the null cell; `''` is distinct, which is why the cursor is JSON.
    const { sql, actor } = seeded();
    recordExploration(sql, actor, {
      publication: OPEN,
      write: write({ descriptor: '', artifact: 'unnamed cell artifact', value: 19, at: T0 + 3 }),
    });
    const cells = listRecordCells(sql, actor, CALLS_HANDLE).items;
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.map((cell) => [cell.descriptor, cell.occupants])).toEqual([
      [null, 3],
      ['', 1],
    ]);
    expect(cells[0]?.elite?.value).toBe(23);
    expect(cells[1]?.elite?.value).toBe(19);
  });

  test('the walk pages across the null/named boundary without repeating or dropping', () => {
    // The null cell sorts ahead of every named cell; a direct descriptor seek restarts or skips.
    const { sql, actor } = seeded();
    recordExploration(sql, actor, {
      publication: OPEN,
      write: write({
        identity: PASS, floor: FLOOR, descriptor: null, value: 0.51,
        artifact: 'unpartitioned pass artifact', at: T0 + 17,
      }),
    });
    const whole = listRecordCells(sql, actor, PASS_HANDLE).items;
    expect(whole.map((cell) => cell.descriptor)).toEqual([null, 'len=long', 'len=medium', 'len=short']);
    const paged = walk((cursor) => listRecordCells(sql, actor, PASS_HANDLE, { cursor: cursor, limit: 1 }));
    expect(paged.map((cell) => cell.descriptor)).toEqual(whole.map((cell) => cell.descriptor));
    expect(paged.map((cell) => cell.occupants)).toEqual(whole.map((cell) => cell.occupants));
  });
});

describe('readRecordCell — an unbounded population, paged', () => {
  test("a cell's population comes back best first, in the objective's direction", () => {
    const { sql, actor } = seeded();
    const page = readRecordCell(sql, actor, { ...PASS_HANDLE, descriptor: 'len=short' });
    expect(page.status).toBe('end');
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.map((row) => row.value)).toEqual([0.71, 0.5, 0.5, 0.5, 0.44]);
    expect(page.items.map((row) => row.artifactDigest)).toEqual(
      cellOccupants(sql, actor, { identity: PASS, floor: FLOOR, descriptor: 'len=short' })
        .map((row) => row.artifactDigest),
    );
  });

  test('paging a cell CROSSES a tie and neither drops nor repeats the boundary row', () => {
    // Pages put a boundary inside the tie: a `value`-only seek drops rows, a non-strict seek repeats one.
    const { sql, actor } = seeded();
    const handle = { ...PASS_HANDLE, descriptor: 'len=short' };
    const whole = readRecordCell(sql, actor, handle, { cursor: null, limit: 100 }).items;
    expect(whole).toHaveLength(5);
    const tied = whole.filter((row) => row.value === 0.5);
    expect(tied.length).toBeGreaterThan(1);

    for (const limit of [1, 2, 3, 4]) {
      const paged = walk((cursor) => readRecordCell(sql, actor, handle, { cursor: cursor, limit: limit }));
      const digests = paged.map((row) => row.artifactDigest);
      expect(digests).toEqual(whole.map((row) => row.artifactDigest));
      expect(new Set(digests).size).toBe(whole.length);
    }
  });

  test('a page that says `more` names its own resume point, and `end` cannot be faked', () => {
    const { sql, actor } = seeded();
    const handle = { ...PASS_HANDLE, descriptor: 'len=short' };
    const first = readRecordCell(sql, actor, handle, { cursor: null, limit: 2 });
    expect(first.status).toBe('more');

    if (first.status !== 'more') return;
    // The cursor is the last delivered row, so the next page starts strictly after it.
    expect(first.next.after).toBe(first.items[1]?.artifactDigest);
    const second = readRecordCell(sql, actor, handle, { cursor: first.next, limit: 2 });
    expect(second.items.map((row) => row.artifactDigest))
      .not.toContain(first.items[1]?.artifactDigest);
    // A full page is not an exhausted one: `seekPage` over-fetches by one.
    expect(second.status).toBe('more');

    if (second.status !== 'more') return;
    const third = readRecordCell(sql, actor, handle, { cursor: second.next, limit: 2 });
    expect(third.status).toBe('end');
    expect(third.items).toHaveLength(1);
  });

  test('a cursor for an occupant that left the cell RAISES', () => {
    const { sql, actor } = seeded();
    const handle = { ...PASS_HANDLE, descriptor: 'len=short' };
    const first = readRecordCell(sql, actor, handle, { cursor: null, limit: 2 });

    if (first.status !== 'more') throw new Error('the fixture must page');
    void sql`DELETE FROM exploration_records WHERE artifact_digest = ${first.next.after}`;
    expect(() => readRecordCell(sql, actor, handle, { cursor: first.next, limit: 2 })).toThrow(StaleCursorError);
  });

  test('the unfloored set reads through `IS`, and the floored one is a different set', () => {
    // `floor_digest = NULL` matches nothing; the floored objective is a different comparable set.
    const { sql, actor } = seeded();
    const unfloored = readRecordCell(sql, actor, { ...CALLS_HANDLE, descriptor: null });
    expect(unfloored.items.length).toBeGreaterThan(0);
    expect(unfloored.items.map((row) => row.value)).toEqual([23, 41, 88]);

    const floored = recordHandleOf({ identity: CALLS, floor: FLOOR });
    expect(floored.floorDigest).not.toBeNull();
    expect(readRecordCell(sql, actor, { ...floored, descriptor: null }))
      .toEqual({ status: 'end', items: [] });
  });
});
