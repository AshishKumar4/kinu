/**
 * Discovery reads over the exploration leaderboard; digests are opaque handles passed back as
 * given. Row-level SQL stays in `strategy/records.ts` so leaderboard and archive share one order.
 * Sets without a recorded unit/direction are unlisted, and raise when asked for directly.
 * `descriptor: null` is the no-partition cell; every scoping predicate must use `IS`.
 */

import * as v from 'valibot';
import type { ExplorationRecord, ObjectiveDirection, ObjectiveScale } from '../strategy/objective';
import {
  describeObjective, recordsInCell, recordsUnder,
  type CellSeek, type RecordCellHandle, type RecordObjectiveHandle,
} from '../strategy/records';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { boundedInt } from '../utils/bounds';
import { mapPage, seekPage, StaleCursorError, type Page, type SeekCursor } from '../session/page';

/** One comparable set. `objectiveId` + `floorDigest` is the handle; never `objectiveId` alone. */
export interface RecordObjectiveSummary {
  readonly objectiveId: string;
  readonly floorDigest: string | null;
  readonly metric: string;
  /** The unit the raw values are in. */
  readonly unit: string;
  readonly direction: ObjectiveDirection;
  readonly scale: ObjectiveScale;
  /** Distinct cells spanned (coverage); the no-partition cell counts as one. */
  readonly cells: number;
  readonly rows: number;
  readonly best: ExplorationRecord | null;
  readonly lastRecordedAt: number;
}

export interface RecordCellSummary {
  /** Null is the no-partition cell; `''` is a different cell. */
  readonly descriptor: string | null;
  readonly occupants: number;
  readonly elite: ExplorationRecord | null;
}

const DEFAULT_OBJECTIVE_PAGE = 20;

const DEFAULT_CELL_PAGE = 50;

/** A cell's population is provably unbounded
 *  (`ArchiveAdmission.lean — separated_cells_are_unboundedly_large`), so occupants must page. */
const DEFAULT_OCCUPANT_PAGE = 50;

const MAX_RECORD_PAGE = 200;

export interface RecordPageRequest {
  readonly cursor?: SeekCursor | null;
  readonly limit?: number;
}

/**
 * Every comparable set, most recently written first. The ordering key COALESCEs `floor_digest`
 * to `''` (never a real digest) so NULLs survive a seek; scoping predicates stay `IS`.
 */
export function listRecordObjectives(
  sql: SqlExecutor,
  actor: ActorHandle,
  cursor: SeekCursor | null = null,
  limit = DEFAULT_OBJECTIVE_PAGE,
): Page<RecordObjectiveSummary> {
  const page = boundedInt(limit, DEFAULT_OBJECTIVE_PAGE, 1, MAX_RECORD_PAGE);
  const after = cursor === null ? null : objectiveAnchorOf(sql, actor, cursor.after);
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
     WHERE actor_id = ${actor.actorId}
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
    const direction = storedMember('direction', OBJECTIVE_DIRECTIONS, row.direction);
    const handle = { objectiveId: row.objective_id, floorDigest: row.floor_digest };

    return {
      ...handle,
      metric: row.metric,
      unit: row.unit,
      direction,
      scale: storedMember('scale', OBJECTIVE_SCALES, row.scale),
      // COUNT DISTINCT skips NULLs; add the no-partition cell back.
      cells: row.named_cells + (row.unpartitioned > 0 ? 1 : 0),
      rows: row.row_count,
      best: recordsUnder(sql, actor, handle, { direction, limit: 1 })[0] ?? null,
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

/** One set's cells: the no-partition cell first, then by descriptor. */
export function listRecordCells(
  sql: SqlExecutor,
  actor: ActorHandle,
  handle: RecordObjectiveHandle,
  request: RecordPageRequest = {},
): Page<RecordCellSummary> {
  const direction = directionOf(sql, actor, handle);

  if (direction === null) return { status: 'end', items: [] };
  const page = boundedInt(request.limit, DEFAULT_CELL_PAGE, 1, MAX_RECORD_PAGE);
  const cursor = request.cursor ?? null;
  const after = cursor === null ? null : cellAnchorOf(sql, actor, handle, cursor.after);
  const from = after === null ? 0 : 1;
  const descriptor = after === null ? null : after.descriptor;

  const cells = sql<{ descriptor: string | null; occupants: number }>`
    SELECT descriptor, COUNT(*) AS occupants
      FROM exploration_records
     WHERE actor_id = ${actor.actorId} AND objective_id = ${handle.objectiveId}
       AND floor_digest IS ${handle.floorDigest}
       AND (${from} = 0
            OR (descriptor IS NOT NULL
                AND (${descriptor} IS NULL OR descriptor > ${descriptor})))
     GROUP BY descriptor
     ORDER BY CASE WHEN descriptor IS NULL THEN 0 ELSE 1 END ASC, descriptor ASC
     LIMIT ${page + 1}`;

  return mapPage(seekPage(cells, page, cellCursor), (rows) => rows.map((row) => ({
    descriptor: row.descriptor,
    occupants: row.occupants,
    elite: recordsInCell(sql, actor, { ...handle, descriptor: row.descriptor }, { direction, seek: null, limit: 1 })[0] ?? null,
  })));
}

/** One cell's population, best first, paged. `cellOccupants` stays unpaged: admission must
 *  compare against every occupant. */
export function readRecordCell(
  sql: SqlExecutor,
  actor: ActorHandle,
  handle: RecordCellHandle,
  request: RecordPageRequest = {},
): Page<ExplorationRecord> {
  const direction = directionOf(sql, actor, handle);

  if (direction === null) return { status: 'end', items: [] };
  const page = boundedInt(request.limit, DEFAULT_OCCUPANT_PAGE, 1, MAX_RECORD_PAGE);
  const cursor = request.cursor ?? null;
  const seek = cursor === null ? null : occupantSeek(sql, actor, handle, cursor.after);

  return seekPage(recordsInCell(sql, actor, handle, { direction, seek, limit: page + 1 }), page,
    (record) => record.artifactDigest);
}

/** The stored direction for a handle, or null when it names nothing. Rows the store cannot
 *  describe raise rather than read as empty. */
function directionOf(
  sql: SqlExecutor, actor: ActorHandle, handle: RecordObjectiveHandle,
): ObjectiveDirection | null {
  const described = describeObjective(sql, actor, handle);

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

/** Cursors are JSON so `''` and null descriptors stay distinct; every anchor is resolved against
 *  the store first so a stale cursor raises instead of reading as exhaustion. */
interface ObjectiveAnchor extends RecordObjectiveHandle {
  readonly lastRecordedAt: number;
}

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

function objectiveAnchorOf(sql: SqlExecutor, actor: ActorHandle, after: string): ObjectiveAnchor {
  const handle = parseAnchor('objective list', after, ObjectiveAnchorSchema);

  const row = sql<{ last_recorded_at: number | null }>`
    SELECT MAX(first_recorded_at) AS last_recorded_at FROM exploration_records
     WHERE actor_id = ${actor.actorId} AND objective_id = ${handle.objectiveId}
       AND floor_digest IS ${handle.floorDigest}`[0];

  if (!row || row.last_recorded_at === null) throw new StaleCursorError('objective list', after);

  return { ...handle, lastRecordedAt: row.last_recorded_at };
}

function cellCursor(row: CellAnchor): string {
  return JSON.stringify({ descriptor: row.descriptor });
}

function cellAnchorOf(
  sql: SqlExecutor, actor: ActorHandle, handle: RecordObjectiveHandle, after: string,
): CellAnchor {
  const anchor = parseAnchor('cell list', after, CellAnchorSchema);

  const present = sql<{ present: number }>`
    SELECT 1 AS present FROM exploration_records
     WHERE actor_id = ${actor.actorId} AND objective_id = ${handle.objectiveId}
       AND floor_digest IS ${handle.floorDigest}
       AND descriptor IS ${anchor.descriptor} LIMIT 1`;

  if (present.length === 0) throw new StaleCursorError('cell list', after);

  return anchor;
}

/** Value and time are read back, not carried: a re-record may have moved the row. */
function occupantSeek(
  sql: SqlExecutor, actor: ActorHandle, handle: RecordCellHandle, after: string,
): CellSeek {
  const row = sql<{ value: number; first_recorded_at: number }>`
    SELECT value, first_recorded_at FROM exploration_records
     WHERE actor_id = ${actor.actorId} AND objective_id = ${handle.objectiveId}
       AND floor_digest IS ${handle.floorDigest}
       AND descriptor IS ${handle.descriptor} AND artifact_digest = ${after} LIMIT 1`[0];

  if (!row) throw new StaleCursorError('cell', after);

  return { value: row.value, firstRecordedAt: row.first_recorded_at, artifactDigest: after };
}

/** A malformed cursor is treated as stale, with the parse failure as `cause`. */
function parseAnchor<T>(what: string, after: string, schema: v.GenericSchema<T>): T {
  try {
    return v.parse(schema, JSON.parse(after));
  } catch (cause) {
    throw new StaleCursorError(what, after, { cause });
  }
}

const OBJECTIVE_DIRECTIONS: readonly ObjectiveDirection[] = ['minimise', 'maximise'];

const OBJECTIVE_SCALES: readonly ObjectiveScale[] = ['linear', 'log'];

function storedMember<Member extends string>(column: string, admitted: readonly Member[], stored: string): Member {
  const member = admitted.find((candidate) => candidate === stored);

  if (member === undefined) throw new Error(`exploration_records.${column} is ${JSON.stringify(stored)}, not a ${column}`);

  return member;
}
