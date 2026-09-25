/**
 * The records store: the leaderboard and its writer. Rules:
 * 1. {@link admitsPublication} gates every write over `records`; a breached run writes nothing.
 * 2. A row's key carries the floor digest, never `objectiveId` alone.
 * 3. A cell's best never falls: a lowering re-record is refused as `not-better`.
 *    `RecordsStore.lean — best_never_falls, an_unguarded_write_lowers_the_best`.
 * 4. `isBetter` is the comparison. Its strictness is not what makes rule 3 hold:
 *    `RecordsStore.lean — the_tie_rule_is_not_what_makes_it_monotone`,
 *    `RecordsStore.lean — lenient_best_never_falls`.
 * `record_key` is a digest over the nullable identity columns, because SQLite treats
 * NULLs as distinct in a UNIQUE index.
 * Spec: docs/EXPLORATION.md "The records store", "The publication seal", "Comparability".
 */
import * as v from 'valibot';
import { argumentDigest, sha256Hex } from '../safety/argument-digest';
import {
  admitsPublication, FloorBreachSchema, isBetter,
  type FloorBreach,
  type ExplorationRecord, type Floor, type ObjectiveDirection, type ObjectiveIdentity,
  type PublicationState, type VerifierSpec,
} from './objective';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';

/**
 * The objective identity is denormalised beside `objective_id`, which is its digest,
 * so the two cannot disagree (a test re-hashes stored rows). Nullable columns carry no
 * default: NULL means the run reported nothing. `displacements` defaults to 0.
 */
const EXPLORATION_RECORDS_DDL = `CREATE TABLE IF NOT EXISTS exploration_records (
  actor_id          TEXT NOT NULL,
  record_key        TEXT NOT NULL,
  objective_id      TEXT NOT NULL,
  floor_digest      TEXT,
  descriptor        TEXT,
  artifact_digest   TEXT NOT NULL,
  artifact          TEXT NOT NULL,
  value             REAL NOT NULL,
  detail            TEXT NOT NULL,
  measured_json     TEXT,
  preset            TEXT NOT NULL,
  label             TEXT,
  root_id           TEXT NOT NULL,
  config_digest     TEXT NOT NULL,
  depth             INTEGER NOT NULL,
  branches          INTEGER NOT NULL,
  floor_value       REAL,
  floor_proof       TEXT,
  cost_usd          REAL,
  cost_tokens       INTEGER,
  first_recorded_at INTEGER NOT NULL,
  displacements     INTEGER NOT NULL DEFAULT 0,
  metric            TEXT,
  unit              TEXT,
  direction         TEXT,
  scale             TEXT,
  verifier_digest   TEXT,
  PRIMARY KEY (actor_id, record_key)
)`;

const EXPLORATION_SEALS_DDL = `CREATE TABLE IF NOT EXISTS exploration_seals (
  actor_id     TEXT NOT NULL,
  objective_id TEXT NOT NULL,
  floor_digest TEXT NOT NULL,
  breach_json  TEXT NOT NULL,
  sealed_at    INTEGER NOT NULL,
  PRIMARY KEY (actor_id, objective_id, floor_digest)
)`;

export function initExplorationRecordsTable(execRaw: RawSqlExec): void {
  execRaw(EXPLORATION_RECORDS_DDL);
  execRaw(EXPLORATION_SEALS_DDL);
  // Scoped by identity and floor, like every read below.
  execRaw('CREATE INDEX IF NOT EXISTS idx_er_cell ON exploration_records'
    + '(actor_id, objective_id, floor_digest, descriptor, value)');
}

/** Fields named one at a time so a new identity field is a deliberate edit here. */
export function objectiveIdOf(identity: ObjectiveIdentity): string {
  return argumentDigest({
    metric: identity.metric,
    unit: identity.unit,
    direction: identity.direction,
    scale: identity.scale,
    verifierDigest: identity.verifierDigest,
  });
}

/** The instrument's half of the identity: the spec and the code it resolved to. */
export function verifierDigestOf(spec: VerifierSpec, implementation: string): string {
  return argumentDigest({ kind: spec.kind, spec: spec.spec, implementation });
}

/** The whole bound as a digest, or null when none was declared (not a floor of zero). */
function floorDigestOf(floor: Floor | null): string | null {
  if (floor === null) return null;

  return argumentDigest({
    value: floor.value,
    proof: floor.proof,
    kind: floor.kind,
    bestKnownHonest: floor.bestKnownHonest,
  });
}

/**
 * What a caller knows about one measurement. Store-owned fields (`objectiveId`,
 * `artifactDigest`, `firstRecordedAt`, `displacements`) are derived, not supplied.
 */
export interface ExplorationWrite {
  readonly identity: ObjectiveIdentity;
  readonly descriptor: string | null;
  readonly artifact: string;
  /** Raw, in the objective's unit; normalised scores are incomparable across baselines. */
  readonly value: number;
  readonly detail: string;
  readonly measured: Readonly<Record<string, number>> | null;
  readonly preset: string;
  readonly label: string | null;
  readonly rootId: string;
  readonly configDigest: string;
  readonly depth: number;
  readonly branches: number;
  readonly floor: Floor | null;
  readonly costUsd: number | null;
  readonly costTokens: number | null;
  readonly at: number;
}

/** What happened to a write, as a value: a refusal the caller discloses, not a throw. */
export type RecordVerdict =
  | {
      readonly kind: 'recorded';
      readonly recordKey: string;
      /** Whether this write moved the cell's best; false for a cell's first row. */
      readonly displaced: boolean;
    }
  | { readonly kind: 'refused'; readonly cause: 'sealed' | 'not-better' };

/** What one run did with the records store: what it started from and what survived. */
export interface ExplorationRecordsReport {
  /** Rows read before expanding, under this run's identity and floor. */
  readonly carriedIn: number;
  /** Best raw value carried in, or null when none (no incumbent is not a bad one). */
  readonly carriedInBest: number | null;
  /** Distinct cells carried in; row count alone cannot show a collapsed archive. */
  readonly carriedInCells: number;
  readonly written: number;
  /** Writes the monotone rule refused. */
  readonly notBetter: number;
  /** Writes the archive's novelty test refused; zero for a run with no archive. */
  readonly tooClose: number;
}

interface Row {
  readonly record_key: string;
  readonly objective_id: string;
  readonly floor_digest: string | null;
  readonly descriptor: string | null;
  readonly artifact_digest: string;
  readonly artifact: string;
  readonly value: number;
  readonly detail: string;
  readonly measured_json: string | null;
  readonly preset: string;
  readonly label: string | null;
  readonly root_id: string;
  readonly config_digest: string;
  readonly depth: number;
  readonly branches: number;
  readonly floor_value: number | null;
  readonly floor_proof: string | null;
  readonly cost_usd: number | null;
  readonly cost_tokens: number | null;
  readonly first_recorded_at: number;
  readonly displacements: number;
}

const MeasuredSchema = v.record(v.string(), v.number());

/** A corrupt `measured_json` throws: an unreadable row is not a row that measured nothing. */
function decode(row: Row): ExplorationRecord {
  return {
    objectiveId: row.objective_id,
    descriptor: row.descriptor,
    artifactDigest: row.artifact_digest,
    artifact: row.artifact,
    value: row.value,
    detail: row.detail,
    measured: row.measured_json === null
      ? null
      : v.parse(MeasuredSchema, JSON.parse(row.measured_json)),
    preset: row.preset,
    label: row.label,
    rootId: row.root_id,
    configDigest: row.config_digest,
    depth: row.depth,
    branches: row.branches,
    floorDigest: row.floor_digest,
    floorValue: row.floor_value,
    floorProof: row.floor_proof,
    costUsd: row.cost_usd,
    costTokens: row.cost_tokens,
    firstRecordedAt: row.first_recorded_at,
    displacements: row.displacements,
  };
}

/** A read or write is scoped by the objective and the floor it was published under, never one alone. */
export interface RecordScope {
  readonly identity: ObjectiveIdentity;
  readonly floor: Floor | null;
}

/** One cell: the comparable set narrowed to one descriptor partition. */
export interface CellScope extends RecordScope {
  readonly descriptor: string | null;
}

/**
 * The opaque read handle for one comparable set; a surface passes it back rather than
 * re-deriving it. `floorDigest: null` (no floor) is required, not optional.
 */
export interface RecordObjectiveHandle {
  readonly objectiveId: string;
  readonly floorDigest: string | null;
}

/** `descriptor: null` is the no-partition cell, distinct from an empty-named cell. */
export interface RecordCellHandle extends RecordObjectiveHandle {
  readonly descriptor: string | null;
}

/** The one place an `ObjectiveIdentity` becomes the opaque handle a surface holds. */
export function recordHandleOf(scope: RecordScope): RecordObjectiveHandle {
  return { objectiveId: objectiveIdOf(scope.identity), floorDigest: floorDigestOf(scope.floor) };
}

/** Page boundary in a cell's best-first order; `artifactDigest` makes it unique. */
export interface CellSeek {
  readonly value: number;
  readonly firstRecordedAt: number;
  readonly artifactDigest: string;
}

/** SQLite's "no limit" for `LIMIT`, so paged and unpaged reads share one query. */
const NO_LIMIT = -1;

export interface RecordQuery {
  readonly direction: ObjectiveDirection;
  readonly limit: number;
}

export interface CellQuery extends RecordQuery {
  readonly seek: CellSeek | null;
}

/**
 * Every row under one comparable set, best first. `IS`, not `=`, on the nullable
 * key column; two literal queries because `ASC`/`DESC` cannot be parameterised.
 */
export function recordsUnder(
  sql: SqlExecutor,
  actor: ActorHandle,
  handle: RecordObjectiveHandle,
  query: RecordQuery,
): readonly ExplorationRecord[] {
  actor.assertCurrent();
  const actorId = actor.actorId;
  const { objectiveId, floorDigest } = handle;
  const { direction, limit } = query;

  const rows = direction === 'minimise'
    ? sql<Row>`SELECT * FROM exploration_records
        WHERE actor_id = ${actorId} AND objective_id = ${objectiveId}
          AND floor_digest IS ${floorDigest}
        ORDER BY value ASC, first_recorded_at ASC, artifact_digest ASC LIMIT ${limit}`
    : sql<Row>`SELECT * FROM exploration_records
        WHERE actor_id = ${actorId} AND objective_id = ${objectiveId}
          AND floor_digest IS ${floorDigest}
        ORDER BY value DESC, first_recorded_at ASC, artifact_digest ASC LIMIT ${limit}`;

  return rows.map(decode);
}

/**
 * One cell's population, best first, optionally past `seek`: one query for both the
 * archive's occupancy read and a leaderboard page. The seek comparison flips with the order.
 */
export function recordsInCell(
  sql: SqlExecutor,
  actor: ActorHandle,
  handle: RecordCellHandle,
  query: CellQuery,
): readonly ExplorationRecord[] {
  actor.assertCurrent();
  const actorId = actor.actorId;
  const { objectiveId, floorDigest, descriptor } = handle;
  const { direction, seek, limit } = query;
  const from = seek === null ? 0 : 1;
  const value = seek?.value ?? 0;
  const at = seek?.firstRecordedAt ?? 0;
  const artifact = seek?.artifactDigest ?? '';

  const rows = direction === 'minimise'
    ? sql<Row>`SELECT * FROM exploration_records
        WHERE actor_id = ${actorId} AND objective_id = ${objectiveId}
          AND floor_digest IS ${floorDigest}
          AND descriptor IS ${descriptor}
          AND (${from} = 0 OR value > ${value}
               OR (value = ${value} AND (first_recorded_at > ${at}
                   OR (first_recorded_at = ${at} AND artifact_digest > ${artifact}))))
        ORDER BY value ASC, first_recorded_at ASC, artifact_digest ASC LIMIT ${limit}`
    : sql<Row>`SELECT * FROM exploration_records
        WHERE actor_id = ${actorId} AND objective_id = ${objectiveId}
          AND floor_digest IS ${floorDigest}
          AND descriptor IS ${descriptor}
          AND (${from} = 0 OR value < ${value}
               OR (value = ${value} AND (first_recorded_at > ${at}
                   OR (first_recorded_at = ${at} AND artifact_digest > ${artifact}))))
        ORDER BY value DESC, first_recorded_at ASC, artifact_digest ASC LIMIT ${limit}`;

  return rows.map(decode);
}

/**
 * The identity the store holds for a handle, and its row count. `identity: null` with
 * `rows > 0` means rows of unknown unit/direction, which reads refuse. An out-of-union
 * stored `direction` or `scale` throws.
 */
export interface StoredObjective {
  readonly identity: ObjectiveIdentity | null;
  readonly rows: number;
}

const StoredIdentitySchema: v.GenericSchema<ObjectiveIdentity> = v.object({
  metric: v.string(),
  unit: v.string(),
  direction: v.picklist(['minimise', 'maximise']),
  scale: v.picklist(['linear', 'log']),
  verifierDigest: v.string(),
});

export function describeObjective(
  sql: SqlExecutor, actor: ActorHandle, handle: RecordObjectiveHandle,
): StoredObjective {
  actor.assertCurrent();

  const row = sql<{
    row_count: number; metric: string | null; unit: string | null;
    direction: string | null; scale: string | null; verifier_digest: string | null;
  }>`SELECT COUNT(*) AS row_count, MAX(metric) AS metric, MAX(unit) AS unit,
            MAX(direction) AS direction, MAX(scale) AS scale,
            MAX(verifier_digest) AS verifier_digest
       FROM exploration_records
       WHERE actor_id = ${actor.actorId} AND objective_id = ${handle.objectiveId}
         AND floor_digest IS ${handle.floorDigest}`[0];

  if (!row || row.row_count === 0) return { identity: null, rows: 0 };

  if (row.metric === null) return { identity: null, rows: row.row_count };

  return {
    identity: v.parse(StoredIdentitySchema, {
      metric: row.metric, unit: row.unit, direction: row.direction,
      scale: row.scale, verifierDigest: row.verifier_digest,
    }),
    rows: row.row_count,
  };
}

export function recordsFor(
  sql: SqlExecutor, actor: ActorHandle, scope: RecordScope,
): readonly ExplorationRecord[] {
  return recordsUnder(sql, actor, recordHandleOf(scope), { direction: scope.identity.direction, limit: NO_LIMIT });
}

/** This cell's incumbent (head of its best-first order), or null when empty. */
export function bestInCell(
  sql: SqlExecutor, actor: ActorHandle, scope: CellScope,
): ExplorationRecord | null {
  const handle = { ...recordHandleOf(scope), descriptor: scope.descriptor };

  return recordsInCell(sql, actor, handle, { direction: scope.identity.direction, seek: null, limit: 1 })[0] ?? null;
}

/**
 * This cell's whole population, best first; archive admission compares against every occupant.
 * Unbounded on purpose: `ArchiveAdmission.lean — separated_cells_are_unboundedly_large`;
 * a `LIMIT` would falsify `no_near_copy_is_reachable`. Paging belongs to the display read model.
 */
export function cellOccupants(
  sql: SqlExecutor, actor: ActorHandle, scope: CellScope,
): readonly ExplorationRecord[] {
  const handle = { ...recordHandleOf(scope), descriptor: scope.descriptor };

  return recordsInCell(sql, actor, handle, { direction: scope.identity.direction, seek: null, limit: NO_LIMIT });
}

export function sealRecords(
  sql: SqlExecutor,
  actor: ActorHandle,
  input: { readonly identity: ObjectiveIdentity; readonly breach: FloorBreach; readonly at: number },
): void {
  const { identity, breach, at } = input;
  actor.assertCurrent();
  void sql`INSERT INTO exploration_seals (actor_id, objective_id, floor_digest, breach_json, sealed_at)
    VALUES (${actor.actorId}, ${objectiveIdOf(identity)}, ${floorDigestOf(breach.floor)},
      ${JSON.stringify(breach)}, ${at})
    ON CONFLICT (actor_id, objective_id, floor_digest) DO NOTHING`;
}

/** The run's own seal, else the store's. */
export function publicationOf(
  sql: SqlExecutor, actor: ActorHandle, own: PublicationState, scope: RecordScope,
): PublicationState {
  const floorDigest = floorDigestOf(scope.floor);

  if (own.kind === 'sealed' || floorDigest === null) return own;

  const row = sql<{ breach_json: string }>`
    SELECT breach_json FROM exploration_seals
    WHERE actor_id = ${actor.actorId} AND objective_id = ${objectiveIdOf(scope.identity)}
      AND floor_digest = ${floorDigest}`[0];

  if (row === undefined) return own;

  return { kind: 'sealed', breach: v.parse(FloorBreachSchema, JSON.parse(row.breach_json)) };
}

/**
 * Write one measurement or refuse with a reason. The seal is checked before anything is
 * read; the monotone rule after.
 */
export function recordExploration(
  sql: SqlExecutor,
  actor: ActorHandle,
  input: { readonly publication: PublicationState; readonly write: ExplorationWrite },
): RecordVerdict {
  const { write } = input;

  if (admitsPublication(input.publication, 'records').kind === 'refused') {
    return { kind: 'refused', cause: 'sealed' };
  }

  // After the seal, before any read: neither a breached run nor a retired actor may inspect the store.
  actor.assertCurrent();

  if (admitsPublication(publicationOf(sql, actor, input.publication, write), 'records').kind === 'refused') {
    return { kind: 'refused', cause: 'sealed' };
  }

  const actorId = actor.actorId;

  const objectiveId = objectiveIdOf(write.identity);
  const floorDigest = floorDigestOf(write.floor);
  // Computed from the bytes, never accepted from a caller.
  const artifactDigest = sha256Hex(write.artifact);
  const recordKey = argumentDigest({ objectiveId, floorDigest, descriptor: write.descriptor, artifactDigest });
  const direction: ObjectiveDirection = write.identity.direction;

  const existing = sql<Row>`
    SELECT * FROM exploration_records
    WHERE actor_id = ${actorId} AND record_key = ${recordKey} LIMIT 1`[0];

  if (existing && !isBetter(write.value, existing.value, direction)) {
    // A tie lands here: `isBetter` is strict.
    return { kind: 'refused', cause: 'not-better' };
  }

  const incumbent = bestInCell(sql, actor, {
    identity: write.identity, floor: write.floor, descriptor: write.descriptor,
  });

  const measuredJson = write.measured === null ? null : JSON.stringify(write.measured);

  const identity = write.identity;

  if (existing) {
    // `first_recorded_at` is untouched. Identity columns are re-written (same values
        // on any row whose `record_key` matches).
    void sql`UPDATE exploration_records SET
        artifact = ${write.artifact}, value = ${write.value}, detail = ${write.detail},
        measured_json = ${measuredJson}, preset = ${write.preset}, label = ${write.label},
        root_id = ${write.rootId}, config_digest = ${write.configDigest},
        depth = ${write.depth}, branches = ${write.branches},
        floor_value = ${write.floor?.value ?? null}, floor_proof = ${write.floor?.proof ?? null},
        cost_usd = ${write.costUsd}, cost_tokens = ${write.costTokens},
        metric = ${identity.metric}, unit = ${identity.unit}, direction = ${identity.direction},
        scale = ${identity.scale}, verifier_digest = ${identity.verifierDigest}
      WHERE actor_id = ${actorId} AND record_key = ${recordKey}`;
  } else {
    void sql`INSERT INTO exploration_records (
        actor_id, record_key, objective_id, floor_digest, descriptor, artifact_digest, artifact,
        value, detail, measured_json, preset, label, root_id, config_digest, depth,
        branches, floor_value, floor_proof, cost_usd, cost_tokens, first_recorded_at,
        displacements, metric, unit, direction, scale, verifier_digest
      ) VALUES (
        ${actorId}, ${recordKey}, ${objectiveId}, ${floorDigest}, ${write.descriptor},
        ${artifactDigest},
        ${write.artifact}, ${write.value}, ${write.detail}, ${measuredJson}, ${write.preset},
        ${write.label}, ${write.rootId}, ${write.configDigest}, ${write.depth},
        ${write.branches}, ${write.floor?.value ?? null}, ${write.floor?.proof ?? null},
        ${write.costUsd}, ${write.costTokens}, ${write.at}, 0,
        ${identity.metric}, ${identity.unit}, ${identity.direction}, ${identity.scale},
        ${identity.verifierDigest}
      )`;
  }

  const displaced = incumbent !== null && isBetter(write.value, incumbent.value, direction);

  if (displaced) {
    // Counted on the other rows: moves of this cell's best since each row was written.
    void sql`UPDATE exploration_records SET displacements = displacements + 1
      WHERE actor_id = ${actorId} AND objective_id = ${objectiveId}
        AND floor_digest IS ${floorDigest}
        AND descriptor IS ${write.descriptor} AND record_key <> ${recordKey}`;
  }

  return { kind: 'recorded', recordKey, displaced };
}
