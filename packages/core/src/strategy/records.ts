/**
 * The records store — §5.2's leaderboard, and the writer it did not have.
 *
 * `PUBLICATION_SURFACES` has enumerated `records` since the seal was restated over a
 * SET of surfaces, and nothing wrote it. That is what made the whole surface
 * per-invocation: `carry` admitted candidates at the settle barrier and they persisted
 * nowhere, so no run started from what an earlier run reached and there was no
 * leaderboard to read. {@link ExplorationRecord} was the declared row all along; this
 * file is its store.
 *
 * FOUR RULES, all of them already stated elsewhere in the tree and none of them
 * re-derived here:
 *
 * 1. THE SEAL IS CHECKED HERE. {@link admitsPublication} gates every write, over the
 *    `records` member of the enumeration, and a breached run writes NOTHING. Checked
 *    in the writer rather than trusted to the caller for §4.4's own reason: the hole
 *    that made the seal a true theorem about a false property was a publication path
 *    that called itself separate and unchanged. `admitCarry` checks it too, and that
 *    is not a duplicate gate — it is the barrier deciding admission and this deciding
 *    a write, and either one alone would leave the other reachable.
 *
 * 2. THE KEY CARRIES THE FLOOR. A row is identified by the objective's identity
 *    TOGETHER WITH the floor digest, never by `objectiveId` alone. A floor-blind key
 *    collapses a corrected floor and a wrong one, which is the entire reason
 *    {@link ExplorationRecord.floorDigest} exists: without it, correcting a floor
 *    makes every prior entry's validity unknowable rather than merely stale.
 *
 * 3. A CELL'S BEST NEVER FALLS. A re-record that would lower the value stored for a
 *    row is REFUSED — `cause: 'not-better'` — and the stored measurement stands. A
 *    nondeterministic verifier re-measuring the same artifact worse is the exact
 *    defect that made §5.2's monotone invariant false, and the choice between
 *    refusing and silently ignoring is made here rather than left to a reader:
 *    ignoring it is the silent no-op this repository refuses everywhere else, so the
 *    writer returns a verdict the caller can disclose. Since rows are never deleted
 *    and no row's value ever falls, `best(cell)` — a maximum in the objective's
 *    direction over the cell's rows — is monotone as a consequence rather than as a
 *    second rule that could disagree with the first.
 *
 * 4. `isBetter` IS THE COMPARISON. Not `>`, not `<`, and not a direction-aware
 *    expression written again: that function's own docstring names displacement,
 *    eviction and a cell's best as the three sites that must move in lockstep, and
 *    two of them are here.
 *
 * WHY A DERIVED `record_key` COLUMN, given that the declared row has no such field.
 * The identity is `(objectiveId, floorDigest, descriptor, artifactDigest)` and two of
 * those four are NULLABLE — `descriptor` for an objective with no partition,
 * `floorDigest` for one with no floor. SQLite treats NULLs as DISTINCT inside a
 * UNIQUE index, so a composite primary key over those columns would let one cell's
 * unpartitioned row be inserted twice and enforce nothing at all. The key is
 * therefore a digest over the four with their nulls intact, which is a storage
 * detail and not a reported field: every declared column of
 * {@link ExplorationRecord} is present, and none of them is a fabricated sentinel
 * standing in for absent.
 */
import * as v from 'valibot';
import { argumentDigest, sha256Hex } from '../safety/argument-digest';
import {
  admitsPublication, isBetter,
  type ExplorationRecord, type Floor, type ObjectiveDirection, type ObjectiveIdentity,
  type PublicationState, type VerifierSpec,
} from './objective';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';

/**
 * Every column NULLable that {@link ExplorationRecord} declares nullable, and none
 * carrying a default — the discipline `heads/schema.ts` states: NULL means the run
 * reported nothing, which is not the claim that it reported zero. `DEFAULT 0` on
 * `cost_tokens` would record a run whose spend nobody measured as having spent none.
 *
 * `displacements` is the one counter with a default, and 0 is its correct initial
 * value rather than an absence: a freshly written row has genuinely seen its cell's
 * best move zero times.
 */
const EXPLORATION_RECORDS_DDL = `CREATE TABLE IF NOT EXISTS exploration_records (
  record_key        TEXT PRIMARY KEY,
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
  displacements     INTEGER NOT NULL DEFAULT 0
)`;

export function initExplorationRecordsTable(execRaw: RawSqlExec): void {
  execRaw(EXPLORATION_RECORDS_DDL);
  // The comparable set is the identity AND the floor, and every read below is scoped
  // by both, so the index is too — a floor-blind index would serve a query nothing
  // here asks.
  execRaw('CREATE INDEX IF NOT EXISTS idx_er_cell ON exploration_records'
    + '(objective_id, floor_digest, descriptor, value)');
}

/**
 * The comparability key, as a digest over {@link ObjectiveIdentity}.
 *
 * Fields named one at a time rather than spread, so a field joining the identity is a
 * deliberate edit here instead of a silent change to every objectiveId ever written.
 */
export function objectiveIdOf(identity: ObjectiveIdentity): string {
  return argumentDigest({
    metric: identity.metric,
    unit: identity.unit,
    direction: identity.direction,
    scale: identity.scale,
    verifierDigest: identity.verifierDigest,
  });
}

/**
 * The instrument's half of the identity: the SPEC and the CODE it resolved to.
 *
 * `argumentDigest({kind, spec})` alone is what `verifier-registry.ts` says is not
 * enough — two runs whose `kind` resolved to different implementations are not
 * comparable and that digest cannot tell — so {@link ResolvedVerifier.implementation}
 * is the missing half and it is folded in here rather than at each caller.
 */
export function verifierDigestOf(spec: VerifierSpec, implementation: string): string {
  return argumentDigest({ kind: spec.kind, spec: spec.spec, implementation });
}

/** The WHOLE bound as a digest, or null when the objective declared none — which is
 *  not the same claim as a floor of zero. */
export function floorDigestOf(floor: Floor | null): string | null {
  if (floor === null) return null;
  return argumentDigest({
    value: floor.value,
    proof: floor.proof,
    kind: floor.kind,
    bestKnownHonest: floor.bestKnownHonest,
  });
}

/**
 * What a caller knows about one measurement it wants recorded.
 *
 * Deliberately NOT {@link ExplorationRecord}: three of that row's fields belong to the
 * STORE and a caller supplying them could get them wrong. `objectiveId` is derived
 * from the identity, `artifactDigest` from the artifact's own bytes,
 * `firstRecordedAt` is set once on insert and never moved, and `displacements` is
 * counted by the store because only the store sees the cell.
 *
 * `floor` is the bound itself rather than its digest, so `floorDigest`, `floorValue`
 * and `floorProof` are null TOGETHER by construction instead of by a rule someone has
 * to remember.
 */
export interface ExplorationWrite {
  readonly identity: ObjectiveIdentity;
  /** The archive cell, or null for an objective with no descriptor partition. */
  readonly descriptor: string | null;
  readonly artifact: string;
  /** RAW, in the objective's unit. Never the normalised score: two runs with
   *  different baselines have incomparable normalised scores and comparable raw ones. */
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

/**
 * What happened to a write, as a value.
 *
 * A refusal rather than a throw for {@link PublicationVerdict}'s reason: the caller's
 * next move is to DISCLOSE the suppression, and a thrown seal is indistinguishable
 * from a store that broke.
 */
export type RecordVerdict =
  | {
      readonly kind: 'recorded';
      readonly recordKey: string;
      /** Whether this write MOVED the cell's best. False for the cell's first row —
       *  there was no incumbent to displace — and false for a new population member
       *  that did not beat the incumbent. */
      readonly displaced: boolean;
    }
  | { readonly kind: 'refused'; readonly cause: 'sealed' | 'not-better' };

/**
 * What one run did with the records store, as DATA — §3.5's rule that every consumer
 * reads fields and nothing downstream couples to how a disclosure is rendered.
 *
 * The two halves answer the two questions the store exists to make answerable: did
 * this run START from what an earlier one reached, and did what it reached SURVIVE.
 * A store with a writer and no reader is a store nobody starts from, and a run that
 * reports only what it wrote cannot say which of those two it was.
 */
export interface ExplorationRecordsReport {
  /** Rows this run read out of the store before expanding anything, under its own
   *  identity and floor. Zero for the first run of an objective. */
  readonly carriedIn: number;
  /** The best RAW value those rows held, in the objective's unit, or null when there
   *  were none. Null rather than the direction's worst: no incumbent is not a bad one. */
  readonly carriedInBest: number | null;
  /**
   * Distinct CELLS those rows spanned — the coverage this run started from.
   *
   * `carriedIn` counts rows and cannot answer it: an archive that collapsed onto one
   * cell carries in as many rows as one that filled twenty, and reporting only the row
   * count is how a collapsed archive goes on "still reporting coverage" (Rainbow
   * Teaming, self-BLEU 0.42 → 0.79). One for a run with no descriptor partition that
   * read anything, zero when it read nothing.
   */
  readonly carriedInCells: number;
  /** Rows this run wrote or updated. */
  readonly written: number;
  /**
   * Writes the monotone rule refused — a re-record that would have lowered what the
   * store already holds for that artifact.
   *
   * Reported rather than swallowed, because a run that wrote nothing because nothing
   * beat the incumbent is a DIFFERENT run from one that wrote nothing because it was
   * sealed or because it found nothing, and the three are indistinguishable from
   * `written: 0` alone.
   */
  readonly notBetter: number;
  /**
   * Writes the archive's novelty test refused — a candidate too close to an occupant
   * of the cell it was binned into.
   *
   * Beside {@link notBetter} for that field's own reason, one cause further out: a run
   * that archived nothing because every candidate duplicated an occupant is a
   * DIFFERENT run from one that archived nothing because nothing beat an incumbent,
   * and the first is the one that says the search stopped covering new ground. Always
   * zero for a run with no archive, which has no admission test to refuse with.
   */
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

/** A corrupt `measured_json` THROWS rather than decoding to null: a row that cannot be
 *  read is not a row that measured nothing, and the store must not manufacture the
 *  second from the first. */
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

/** The identity a read or a write is scoped by: the objective AND the floor it was
 *  published under. Never one without the other. */
export interface RecordScope {
  readonly identity: ObjectiveIdentity;
  readonly floor: Floor | null;
}

/**
 * One cell of the store, which is what `best(cell)` and `displacements` are stated
 * over: the comparable set narrowed to one descriptor partition.
 */
export interface CellScope extends RecordScope {
  readonly descriptor: string | null;
}

/**
 * Every row under this identity and this floor, best FIRST.
 *
 * `IS` rather than `=` on the two nullable key columns, because `NULL = NULL` is
 * unknown in SQL and the unpartitioned cell would then match nothing — the same trap
 * that makes a composite NULLable primary key useless here.
 *
 * Two literal queries rather than one with an interpolated direction: the direction
 * inverts the ordering, a tagged template cannot parameterise `ASC`/`DESC`, and
 * assembling the clause as a string is how a store starts accepting SQL from its
 * arguments.
 */
export function recordsFor(sql: SqlExecutor, scope: RecordScope): readonly ExplorationRecord[] {
  const objectiveId = objectiveIdOf(scope.identity);
  const floorDigest = floorDigestOf(scope.floor);
  const rows = scope.identity.direction === 'minimise'
    ? sql<Row>`SELECT * FROM exploration_records
        WHERE objective_id = ${objectiveId} AND floor_digest IS ${floorDigest}
        ORDER BY value ASC, first_recorded_at ASC`
    : sql<Row>`SELECT * FROM exploration_records
        WHERE objective_id = ${objectiveId} AND floor_digest IS ${floorDigest}
        ORDER BY value DESC, first_recorded_at ASC`;
  return rows.map(decode);
}

/** This cell's incumbent, or null when the cell is empty. */
export function bestInCell(sql: SqlExecutor, scope: CellScope): ExplorationRecord | null {
  const objectiveId = objectiveIdOf(scope.identity);
  const floorDigest = floorDigestOf(scope.floor);
  const rows = scope.identity.direction === 'minimise'
    ? sql<Row>`SELECT * FROM exploration_records
        WHERE objective_id = ${objectiveId} AND floor_digest IS ${floorDigest}
          AND descriptor IS ${scope.descriptor}
        ORDER BY value ASC, first_recorded_at ASC LIMIT 1`
    : sql<Row>`SELECT * FROM exploration_records
        WHERE objective_id = ${objectiveId} AND floor_digest IS ${floorDigest}
          AND descriptor IS ${scope.descriptor}
        ORDER BY value DESC, first_recorded_at ASC LIMIT 1`;
  const row = rows[0];
  return row ? decode(row) : null;
}

/**
 * This cell's whole POPULATION, best first — the occupancy read an archive admits
 * against.
 *
 * {@link bestInCell} cannot serve it and the difference is the whole reason a cell holds
 * a population rather than an incumbent (`ExplorationRecord`'s own docstring, and
 * FunSearch's program database behind it): an archive's admission test compares a
 * candidate against EVERY occupant, because a candidate that duplicates the third-best
 * program in a cell adds no coverage however far it sits from the best one. A test
 * written against the incumbent alone would let a cell fill with near-copies of its
 * runners-up while reporting the filter as enforced.
 *
 * Same two-literal-query discipline as the reads above, and `LIMIT 1` is deliberately
 * absent rather than raised to a number: the population's bound is the archive's
 * admission test, not a row cap this store invents.
 */
export function cellOccupants(sql: SqlExecutor, scope: CellScope): readonly ExplorationRecord[] {
  const objectiveId = objectiveIdOf(scope.identity);
  const floorDigest = floorDigestOf(scope.floor);
  const rows = scope.identity.direction === 'minimise'
    ? sql<Row>`SELECT * FROM exploration_records
        WHERE objective_id = ${objectiveId} AND floor_digest IS ${floorDigest}
          AND descriptor IS ${scope.descriptor}
        ORDER BY value ASC, first_recorded_at ASC`
    : sql<Row>`SELECT * FROM exploration_records
        WHERE objective_id = ${objectiveId} AND floor_digest IS ${floorDigest}
          AND descriptor IS ${scope.descriptor}
        ORDER BY value DESC, first_recorded_at ASC`;
  return rows.map(decode);
}

/**
 * Write one measurement to the records store, or refuse and say why.
 *
 * The order of the two refusals is the order of what they protect. The SEAL comes
 * first and before anything is read, because a breached run must not so much as
 * inspect the store it may not write. The MONOTONE rule comes second, because it is a
 * question about a row that exists and there is no such question under a seal.
 */
export function recordExploration(
  sql: SqlExecutor,
  input: { readonly publication: PublicationState; readonly write: ExplorationWrite },
): RecordVerdict {
  const { write } = input;
  if (admitsPublication(input.publication, 'records').kind === 'refused') {
    return { kind: 'refused', cause: 'sealed' };
  }

  const objectiveId = objectiveIdOf(write.identity);
  const floorDigest = floorDigestOf(write.floor);
  // The CONTENT digest, computed from the bytes rather than accepted from a caller:
  // identity within a cell is what the artifact IS, and a supplied digest is a claim
  // that can be wrong in exactly the way that duplicates an elite.
  const artifactDigest = sha256Hex(write.artifact);
  const recordKey = argumentDigest({ objectiveId, floorDigest, descriptor: write.descriptor, artifactDigest });
  const direction: ObjectiveDirection = write.identity.direction;

  const existing = sql<Row>`
    SELECT * FROM exploration_records WHERE record_key = ${recordKey} LIMIT 1`[0];
  if (existing && !isBetter(write.value, existing.value, direction)) {
    // The whole rule, and note that a TIE lands here: `isBetter` is strict, a tie
    // carries no signal, and re-recording an unchanged elite moved nothing.
    return { kind: 'refused', cause: 'not-better' };
  }

  const incumbent = bestInCell(sql, {
    identity: write.identity, floor: write.floor, descriptor: write.descriptor,
  });
  const measuredJson = write.measured === null ? null : JSON.stringify(write.measured);

  if (existing) {
    // `first_recorded_at` is untouched: it is when this artifact first entered the
    // store, not when it was last measured.
    void sql`UPDATE exploration_records SET
        artifact = ${write.artifact}, value = ${write.value}, detail = ${write.detail},
        measured_json = ${measuredJson}, preset = ${write.preset}, label = ${write.label},
        root_id = ${write.rootId}, config_digest = ${write.configDigest},
        depth = ${write.depth}, branches = ${write.branches},
        floor_value = ${write.floor?.value ?? null}, floor_proof = ${write.floor?.proof ?? null},
        cost_usd = ${write.costUsd}, cost_tokens = ${write.costTokens}
      WHERE record_key = ${recordKey}`;
  } else {
    void sql`INSERT INTO exploration_records (
        record_key, objective_id, floor_digest, descriptor, artifact_digest, artifact,
        value, detail, measured_json, preset, label, root_id, config_digest, depth,
        branches, floor_value, floor_proof, cost_usd, cost_tokens, first_recorded_at,
        displacements
      ) VALUES (
        ${recordKey}, ${objectiveId}, ${floorDigest}, ${write.descriptor}, ${artifactDigest},
        ${write.artifact}, ${write.value}, ${write.detail}, ${measuredJson}, ${write.preset},
        ${write.label}, ${write.rootId}, ${write.configDigest}, ${write.depth},
        ${write.branches}, ${write.floor?.value ?? null}, ${write.floor?.proof ?? null},
        ${write.costUsd}, ${write.costTokens}, ${write.at}, 0
      )`;
  }

  const displaced = incumbent !== null && isBetter(write.value, incumbent.value, direction);
  if (displaced) {
    // Counted on the OTHER rows, which is what the field says: how many times this
    // cell's best has moved since THIS row was written. The row that did the moving
    // has seen no movement since it landed.
    void sql`UPDATE exploration_records SET displacements = displacements + 1
      WHERE objective_id = ${objectiveId} AND floor_digest IS ${floorDigest}
        AND descriptor IS ${write.descriptor} AND record_key <> ${recordKey}`;
  }
  return { kind: 'recorded', recordKey, displaced };
}
