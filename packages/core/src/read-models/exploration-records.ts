/**
 * The exploration leaderboard, as something a surface can actually reach.
 *
 * `strategy/records.ts` had a writer and three reads, and every one of them is scoped
 * by an `ObjectiveIdentity` — the caller must ALREADY KNOW the objective, including the
 * digest of the verifier's own source. A UI cannot construct that, so the store had no
 * discovery read and no `@callable()` at all: runs accumulated rows nothing could list.
 * These three reads are that entry point, and they take the digests as OPAQUE HANDLES,
 * so a surface passes back what it was given instead of re-deriving a comparability key
 * from parts it could get wrong.
 *
 * ── What each read answers, and why it is not two ────────────────────────────
 *   listRecordObjectives  which comparable sets exist, and what each MEASURES
 *   listRecordCells       one set's cells, and each cell's elite
 *   readRecordCell        one cell's population, a page at a time
 *
 * The row-level SQL is NOT here. `recordsUnder` and `recordsInCell` in
 * `strategy/records.ts` are the one body per question, and `recordsFor`/`bestInCell`/
 * `cellOccupants` derive their handles and delegate to those same two — so the page a
 * leaderboard draws and the population the archive admits against cannot end up in two
 * orderings that must agree. What lives here is the aggregation: which sets, which
 * cells, how many of each.
 *
 * ── The unit is the point ────────────────────────────────────────────────────
 * A summary carries `metric`, `unit`, `direction` and `scale` because a leaderboard on a
 * bare `value REAL` shows a number that cannot be read. The register's own `25.4%` read
 * as a reward LEVEL when it was a DELTA — 3.1 points from the level for the same leader
 * — and a column of unlabelled reals is the same hazard with a sort applied. The store
 * now records what it measured (`EXPLORATION_RECORDS_IDENTITY_COLUMNS`), and these reads
 * report it rather than leaving a surface to caption a scalar.
 *
 * A set whose rows all predate those columns cannot say what it measured, and is
 * therefore NOT listed — the precedent `fork-runs.ts` states for legacy NULL-scoped
 * `search_nodes` rows, applied for a stronger reason: presenting such a set would mean
 * choosing a direction to sort it by, and there is no honest choice. Asking about one
 * DIRECTLY raises instead of answering with an empty page, because rows that exist and
 * cannot be described are a fault, not an absence.
 *
 * ── `descriptor: null` is the no-partition cell ──────────────────────────────
 * Not an unnamed cell, not the empty string. It is carried as `null` through the
 * summaries, the handles and the cursors, and every scoping predicate uses `IS` — a
 * `descriptor = NULL` matches nothing at all, which would make the one cell an
 * unpartitioned objective has invisible.
 */

import * as v from 'valibot';
import type { ExplorationRecord, ObjectiveDirection, ObjectiveScale } from '../strategy/objective';
import {
  describeObjective, recordsInCell, recordsUnder,
  type CellSeek, type RecordCellHandle, type RecordObjectiveHandle,
} from '../strategy/records';
import type { SqlExecutor } from '../types/primitives';
import { boundedInt } from '../utils/bounds';
import { mapPage, seekPage, StaleCursorError, type Page, type SeekCursor } from './page';

/**
 * One comparable set: an objective, under one floor, with what it measures spelled
 * out.
 *
 * `objectiveId` and `floorDigest` together are the handle the other two reads take.
 * Never `objectiveId` alone — a floor-blind key collapses a corrected floor and a wrong
 * one, which is why the store keys on both.
 */
export interface RecordObjectiveSummary {
  readonly objectiveId: string;
  /** NULL when the objective declared no floor, which is not a floor of zero. */
  readonly floorDigest: string | null;
  readonly metric: string;
  /** The unit the RAW values are in. What makes the leaderboard readable at all. */
  readonly unit: string;
  readonly direction: ObjectiveDirection;
  readonly scale: ObjectiveScale;
  /**
   * Distinct cells the set spans — its COVERAGE.
   *
   * `rows` cannot answer it: a set collapsed onto one cell holds as many rows as one
   * that filled twenty, and reporting only the row count is how a collapsed archive
   * goes on reporting coverage. ONE for a set with no descriptor partition that holds
   * anything, because the no-partition cell is a cell.
   */
  readonly cells: number;
  readonly rows: number;
  /** The set's best row across every cell, or null when it holds none. Null rather
   *  than the direction's worst: no incumbent is not a bad one. */
  readonly best: ExplorationRecord | null;
  /** When the set last gained a row. */
  readonly lastRecordedAt: number;
}

/** One cell of a comparable set, and its incumbent. */
export interface RecordCellSummary {
  /** NULL is the NO-PARTITION cell — the objective has no descriptor axis at all. A
   *  cell named `''` is a different cell and stays a different cell. */
  readonly descriptor: string | null;
  readonly occupants: number;
  /** The cell's best, by the objective's own direction. Null is unreachable for a
   *  listed cell — a cell is listed because it has occupants — and is in the type
   *  rather than asserted away, so no future empty-cell notion becomes a fabricated
   *  row. */
  readonly elite: ExplorationRecord | null;
}

/** Comparable sets per page. Twenty, matching the fork list. */
const DEFAULT_OBJECTIVE_PAGE = 20;
/** Cells per page. A grid is read as a whole; fifty is a screen of it. */
const DEFAULT_CELL_PAGE = 50;
/**
 * Occupants per page.
 *
 * The number matters here in a way it does not above: a cell's population is PROVABLY
 * unbounded (`ArchiveAdmission.lean — separated_cells_are_unboundedly_large`), so this
 * is the one read whose unpaged form is a scan with no ceiling.
 */
const DEFAULT_OCCUPANT_PAGE = 50;

/**
 * The ceiling on one leaderboard page. The run list's own ceiling: every entry
 * here is RPC-reachable, and a negative limit reads whole tables at `LIMIT -1`.
 */
const MAX_RECORD_PAGE = 200;

/**
 * Every comparable set the store holds, most recently written FIRST.
 *
 * Most-recent-first in both traversal and presentation, so a walker appends.
 *
 * ── Why the ordering key is COALESCEd and the scoping is not ─────────────────
 * `floor_digest` is nullable and `NULL < 'a'` is unknown, so a seek predicate on the raw
 * column silently drops every unfloored set at a page boundary. `floorDigestOf` returns
 * either NULL or a hex digest and never the empty string, so `''` is a value nothing can
 * collide with and it totalises the ORDERING key. The scoping predicates stay `IS`,
 * because there the NULL is the thing being matched.
 *
 * `HAVING MAX(metric) IS NOT NULL` excludes sets written entirely before the store
 * recorded what it measured. See the header: there is no honest direction to sort such a
 * set by.
 *
 * One `best` query per set IN THE PAGE, which is what keeps the cost the page rather
 * than the store: the alternative is a second best-expression written here, and a second
 * definition of `isBetter` that would have to keep agreeing with the store's about
 * direction and about ties.
 */
export function listRecordObjectives(
  sql: SqlExecutor,
  cursor: SeekCursor | null = null,
  limit = DEFAULT_OBJECTIVE_PAGE,
): Page<RecordObjectiveSummary> {
  const page = boundedInt(limit, DEFAULT_OBJECTIVE_PAGE, 1, MAX_RECORD_PAGE);
  const after = cursor === null ? null : objectiveAnchorOf(sql, cursor.after);
  const from = after === null ? 0 : 1;
  const at = after?.lastRecordedAt ?? 0;
  const objective = after?.objectiveId ?? '';
  const floor = after === null ? '' : after.floorDigest ?? '';
  const groups = sql<ObjectiveGroup>`
    SELECT objective_id,
           floor_digest,
           MAX(metric)                AS metric,
           MAX(unit)                  AS unit,
           MAX(direction)             AS direction,
           MAX(scale)                 AS scale,
           COUNT(*)                   AS row_count,
           COUNT(DISTINCT descriptor) AS named_cells,
           SUM(CASE WHEN descriptor IS NULL THEN 1 ELSE 0 END) AS unpartitioned,
           MAX(first_recorded_at)     AS last_recorded_at
      FROM exploration_records
     GROUP BY objective_id, floor_digest
    HAVING MAX(metric) IS NOT NULL
       AND (${from} = 0
            OR MAX(first_recorded_at) < ${at}
            OR (MAX(first_recorded_at) = ${at}
                AND (objective_id > ${objective}
                     OR (objective_id = ${objective}
                         AND COALESCE(floor_digest, '') > ${floor}))))
     ORDER BY last_recorded_at DESC, objective_id ASC, COALESCE(floor_digest, '') ASC
     LIMIT ${page + 1}`;

  return mapPage(seekPage(groups, page, objectiveCursor), (rows) => rows.map((row) => {
    const direction = asDirection(row.direction);
    const handle = { objectiveId: row.objective_id, floorDigest: row.floor_digest };
    return {
      ...handle,
      metric: row.metric,
      unit: row.unit,
      direction,
      scale: asScale(row.scale),
      // COUNT DISTINCT skips NULLs, so the no-partition cell is added back explicitly:
      // it is one cell, and counting it as none would report an unpartitioned set as
      // covering nothing.
      cells: row.named_cells + (row.unpartitioned > 0 ? 1 : 0),
      rows: row.row_count,
      best: recordsUnder(sql, handle, direction, 1)[0] ?? null,
      lastRecordedAt: row.last_recorded_at,
    };
  }));
}

interface ObjectiveGroup {
  readonly objective_id: string;
  readonly floor_digest: string | null;
  readonly metric: string;
  readonly unit: string;
  readonly direction: string;
  readonly scale: string;
  readonly row_count: number;
  readonly named_cells: number;
  readonly unpartitioned: number;
  readonly last_recorded_at: number;
}

/**
 * One set's cells: the no-partition cell first, then by descriptor.
 *
 * The elite comes from the store's own best-first cell read rather than a `MAX(value)`
 * written again here, for the reason above — one definition of best, not two.
 *
 * An empty page for a handle the store holds nothing under. A handle it holds
 * UNDESCRIBABLE rows under raises instead; see {@link directionOf}.
 */
export function listRecordCells(
  sql: SqlExecutor,
  handle: RecordObjectiveHandle,
  cursor: SeekCursor | null = null,
  limit = DEFAULT_CELL_PAGE,
): Page<RecordCellSummary> {
  const direction = directionOf(sql, handle);
  if (direction === null) return { status: 'end', items: [] };
  const page = boundedInt(limit, DEFAULT_CELL_PAGE, 1, MAX_RECORD_PAGE);
  const after = cursor === null ? null : cellAnchorOf(sql, handle, cursor.after);
  const from = after === null ? 0 : 1;
  const descriptor = after === null ? null : after.descriptor;
  const cells = sql<{ descriptor: string | null; occupants: number }>`
    SELECT descriptor, COUNT(*) AS occupants
      FROM exploration_records
     WHERE objective_id = ${handle.objectiveId} AND floor_digest IS ${handle.floorDigest}
       AND (${from} = 0
            OR (descriptor IS NOT NULL
                AND (${descriptor} IS NULL OR descriptor > ${descriptor})))
     GROUP BY descriptor
     ORDER BY CASE WHEN descriptor IS NULL THEN 0 ELSE 1 END ASC, descriptor ASC
     LIMIT ${page + 1}`;

  return mapPage(seekPage(cells, page, cellCursor), (rows) => rows.map((row) => ({
    descriptor: row.descriptor,
    occupants: row.occupants,
    elite: recordsInCell(sql, { ...handle, descriptor: row.descriptor }, direction, null, 1)[0] ?? null,
  })));
}

/**
 * One cell's population, best first, a page at a time.
 *
 * This is the read the Lean bound makes mandatory: separation bounds SIMILARITY, not
 * cardinality, so a cell can hold n mutually-novel occupants for every n and an unpaged
 * read of one is a scan with no ceiling. `cellOccupants` stays unpaged because ADMISSION
 * must compare against every occupant — a bound there would weaken the novelty test
 * rather than its cost — and this is where a partial answer is legitimate, because a
 * page that says `more` has not claimed to be the cell.
 */
export function readRecordCell(
  sql: SqlExecutor,
  handle: RecordCellHandle,
  cursor: SeekCursor | null = null,
  limit = DEFAULT_OCCUPANT_PAGE,
): Page<ExplorationRecord> {
  const direction = directionOf(sql, handle);
  if (direction === null) return { status: 'end', items: [] };
  const page = boundedInt(limit, DEFAULT_OCCUPANT_PAGE, 1, MAX_RECORD_PAGE);
  const seek = cursor === null ? null : occupantSeek(sql, handle, cursor.after);
  return seekPage(recordsInCell(sql, handle, direction, seek, page + 1), page,
    (record) => record.artifactDigest);
}

/**
 * The direction to read a handle's rows in, or null when it names nothing.
 *
 * The direction comes from the STORE, which is what the identity columns are for: a
 * digest handle carries no direction, and inverting one silently reverses a leaderboard.
 *
 * Rows that exist under a handle the store cannot describe RAISE. Answering `end` there
 * would report a populated cell as empty, and those two are exactly what a caller must
 * be able to tell apart.
 */
function directionOf(sql: SqlExecutor, handle: RecordObjectiveHandle): ObjectiveDirection | null {
  const described = describeObjective(sql, handle);
  if (described.identity !== null) return described.identity.direction;
  if (described.rows > 0) {
    throw new Error(
      `exploration_records holds ${described.rows} row(s) under objective ${handle.objectiveId}`
      + ' written before the store recorded what it measured: no unit and no direction, so'
      + ' they can be neither ordered nor presented.',
    );
  }
  return null;
}

/* ── cursors ───────────────────────────────────────────────────────────────── */

/**
 * A cursor is JSON here rather than the `${a}:${b}` the fork list uses, and the nullable
 * keys are why: `descriptor` is a free string a run chose, so `''` and NULL are both
 * possible values and a delimited encoding cannot tell them apart — which is precisely
 * the distinction that has to survive a page boundary. JSON carries `null` as itself.
 *
 * Every anchor is RESOLVED against the store before it is used, for the reason `page.ts`
 * gives: a position that no longer exists compares fine and silently yields nothing,
 * while an identity that no longer exists is a question with a `no` answer. That is what
 * makes a stale cursor raisable instead of indistinguishable from exhaustion.
 */
interface ObjectiveAnchor extends RecordObjectiveHandle {
  readonly lastRecordedAt: number;
}

/** The cell an anchor names. Its own type rather than an inline shape, because `null`
 *  here is the no-partition cell and not a missing field. */
interface CellAnchor {
  readonly descriptor: string | null;
}

const ObjectiveAnchorSchema: v.GenericSchema<RecordObjectiveHandle> = v.object({
  objectiveId: v.pipe(v.string(), v.nonEmpty()),
  floorDigest: v.nullable(v.string()),
});

const CellAnchorSchema: v.GenericSchema<CellAnchor> = v.object({
  descriptor: v.nullable(v.string()),
});

function objectiveCursor(row: ObjectiveGroup): string {
  return JSON.stringify({ objectiveId: row.objective_id, floorDigest: row.floor_digest });
}

function objectiveAnchorOf(sql: SqlExecutor, after: string): ObjectiveAnchor {
  const handle = parseAnchor('objective list', after, ObjectiveAnchorSchema);
  const row = sql<{ last_recorded_at: number | null }>`
    SELECT MAX(first_recorded_at) AS last_recorded_at FROM exploration_records
     WHERE objective_id = ${handle.objectiveId} AND floor_digest IS ${handle.floorDigest}`[0];
  if (!row || row.last_recorded_at === null) throw new StaleCursorError('objective list', after);
  return { ...handle, lastRecordedAt: row.last_recorded_at };
}

function cellCursor(row: CellAnchor): string {
  return JSON.stringify({ descriptor: row.descriptor });
}

function cellAnchorOf(sql: SqlExecutor, handle: RecordObjectiveHandle, after: string): CellAnchor {
  const anchor = parseAnchor('cell list', after, CellAnchorSchema);
  const present = sql<{ present: number }>`
    SELECT 1 AS present FROM exploration_records
     WHERE objective_id = ${handle.objectiveId} AND floor_digest IS ${handle.floorDigest}
       AND descriptor IS ${anchor.descriptor} LIMIT 1`;
  if (present.length === 0) throw new StaleCursorError('cell list', after);
  return anchor;
}

/**
 * Resolve an occupant cursor to its POSITION in the cell's order.
 *
 * The cursor carries the artifact digest — identity within a cell — and the value and
 * the time are read back rather than carried, so the position is whatever the store now
 * says it is. A carried value would seek from a place the row no longer occupies once a
 * re-record raised it.
 */
function occupantSeek(sql: SqlExecutor, handle: RecordCellHandle, after: string): CellSeek {
  const row = sql<{ value: number; first_recorded_at: number }>`
    SELECT value, first_recorded_at FROM exploration_records
     WHERE objective_id = ${handle.objectiveId} AND floor_digest IS ${handle.floorDigest}
       AND descriptor IS ${handle.descriptor} AND artifact_digest = ${after} LIMIT 1`[0];
  if (!row) throw new StaleCursorError('cell', after);
  return { value: row.value, firstRecordedAt: row.first_recorded_at, artifactDigest: after };
}

/**
 * A cursor is EXTERNAL input, so it is parsed at this boundary rather than narrowed by
 * inspection: a schema states the shape once, and `null` stays a value in it.
 *
 * A malformed cursor is a stale one as far as a caller is concerned — the walk restarts
 * either way, and answering an unreadable position with an empty page would report
 * everything behind it as exhausted. The parse failure travels as `cause` rather than
 * being discarded: an unreadable cursor and a cursor for a row that left are recovered
 * the same way and diagnosed differently.
 */
function parseAnchor<T>(what: string, after: string, schema: v.GenericSchema<T>): T {
  try {
    return v.parse(schema, JSON.parse(after));
  } catch (cause) {
    throw new StaleCursorError(what, after, { cause });
  }
}

/** A stored direction or scale outside its union is a corrupt row, and a corrupt row is
 *  not a row that measured nothing — the discipline `records.ts`'s `decode` applies to
 *  `measured_json`. */
function asDirection(stored: string): ObjectiveDirection {
  if (stored === 'minimise' || stored === 'maximise') return stored;
  throw new Error(`exploration_records.direction is ${JSON.stringify(stored)}, not a direction`);
}

function asScale(stored: string): ObjectiveScale {
  if (stored === 'linear' || stored === 'log') return stored;
  throw new Error(`exploration_records.scale is ${JSON.stringify(stored)}, not a scale`);
}
