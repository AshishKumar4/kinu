// The records store and the archive over it, on real SQLite rows.
//
// WHY THIS SUITE IS AT THE STORE AND NOT AT THE RUN. Rules the writer holds cannot be
// reached from a run at all: a run cannot re-measure one artifact twice under a
// nondeterministic verifier, cannot correct a floor mid-flight, cannot seal itself and
// then find a near occupant already sitting in the cell it was about to write, and cannot
// vary its own novelty threshold to pin the direction the comparison reads it in.
// Asserting those through `runSwarm` would assert whichever subset the engine happens to
// exercise, which is the shape of coverage that lets an invariant become false without a
// red test. The wiring — that the barrier's admissions actually reach this store, that
// `advance:'archive'` bins a real measurement into a real cell, and that a later run
// reads what an earlier one wrote — is proven end to end in `unit-swarm-depth.test.ts`,
// where the real run lives.
//
// AND IT IS OVER REAL ROWS, never a fake. The monotone rule is a SELECT, a comparison
// and either an UPDATE or a refusal, and the two things most likely to be wrong are
// SQL-shaped: `NULL = NULL` is unknown, so a cell with no descriptor matches nothing
// under `=`, and NULLs are DISTINCT inside a SQLite UNIQUE index, so a key with a
// nullable column enforces nothing. Neither failure is reachable against an in-memory
// map standing in for a database.
//
// Specified by docs/EXPLORATION.md — "The records store", "The archive", "The publication
// seal" and "Comparability".
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw } from './helpers';
import {
  bestInCell, initExplorationRecordsTable, objectiveIdOf, recordExploration, recordsFor,
  verifierDigestOf,
  type ExplorationWrite,
} from '../src/strategy/records';
import {
  admitToArchive, archiveCellOf, noveltyDistance, type ArchiveWrite,
} from '../src/strategy/archive';
import type {
  Floor, FloorBreach, ObjectiveIdentity, PublicationState,
} from '../src/strategy/objective';
import type { SqlExecutor } from '../src/types/primitives';

function store(): SqlExecutor {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  initExplorationRecordsTable(makeExecRaw(db), sql);
  return sql;
}

const CHEAPER: ObjectiveIdentity = {
  metric: 'oracle_calls',
  unit: 'oracle calls',
  direction: 'minimise',
  scale: 'log',
  verifierDigest: verifierDigestOf(
    { kind: 'exec-ratio', spec: { params: { n: 24 } } }, 'exec-ratio@abc123',
  ),
};

const HIGHER: ObjectiveIdentity = { ...CHEAPER, metric: 'pass_rate', direction: 'maximise' };

/** The bound as first stated. Its own value is what a later correction changes, which is
 *  what the floor digest exists to keep separable. */
const FLOOR: Floor = {
  value: 12,
  kind: 'certificate',
  bestKnownHonest: 23,
  proof: 'Every token must appear in at least one comparison and a comparison touches two.',
};

/** The SAME objective under a CORRECTED bound — the majority-vote defect repaired, one
 *  token per call rather than two. */
const CORRECTED: Floor = { ...FLOOR, value: 23, proof: 'A call touches one token, not two.' };

const OPEN: PublicationState = { kind: 'open' };

const BREACH: FloorBreach = {
  floor: FLOOR,
  measured: { kind: 'measured', value: 8, detail: '8 oracle calls' },
  margin: (23 - 12) / 23,
  hypotheses: ['floor_wrong', 'verifier_gameable'],
};

const SEALED: PublicationState = { kind: 'sealed', breach: BREACH, clearedBy: null };

const REDERIVED: PublicationState = {
  kind: 'sealed',
  breach: BREACH,
  clearedBy: {
    floor: CORRECTED,
    adjudication: 'the bound counted one token per call where a call touches two; H1 held',
    at: 1_700_000_000_000,
  },
};

function write(over?: Partial<ExplorationWrite>): ExplorationWrite {
  return {
    identity: CHEAPER,
    descriptor: null,
    artifact: 'export function solve() { return 1; }',
    value: 23,
    detail: "23 oracle calls against the reference's 276",
    measured: { refOps: 276, candOps: 23 },
    preset: 'optimise',
    label: null,
    rootId: 'root-1',
    configDigest: 'cfg-1',
    depth: 5,
    branches: 3,
    floor: FLOOR,
    costUsd: null,
    costTokens: 4_096,
    at: 1_700_000_000_000,
    ...over,
  };
}

describe('the seal gates the write, checked in the writer and not assumed of the caller', () => {
  test('a breached run writes NOTHING, and the refusal names the seal', () => {
    // THE RED DIRECTION: delete the `admitsPublication` call at the top of
    // `recordExploration` and this goes red on both halves — the verdict becomes
    // `recorded` and the row appears. That is *The publication seal* at this surface,
    // and it is stated here rather than at the barrier because the barrier's own gate is
    // a SECOND check: either one alone leaves the other path reachable.
    const sql = store();
    expect(recordExploration(sql, { publication: SEALED, write: write() }))
      .toEqual({ kind: 'refused', cause: 'sealed' });
    expect(recordsFor(sql, { identity: CHEAPER, floor: FLOOR })).toHaveLength(0);
  });

  test('a seal is not a boolean: a RECORDED re-derivation publishes again', () => {
    // The one edge out of a seal that *The publication seal* allows, and the reason the
    // writer asks `admitsPublication` rather than testing `kind === 'sealed'` itself. A
    // writer that read the tag would refuse this row forever, which is retroactive
    // publication silently deleted.
    const sql = store();
    const verdict = recordExploration(sql, { publication: REDERIVED, write: write() });
    expect(verdict.kind).toBe('recorded');
    expect(recordsFor(sql, { identity: CHEAPER, floor: FLOOR })).toHaveLength(1);
  });

  test('an open run writes, so the two tests above are not passing on a store that never writes', () => {
    const sql = store();
    expect(recordExploration(sql, { publication: OPEN, write: write() }).kind).toBe('recorded');
    expect(recordsFor(sql, { identity: CHEAPER, floor: FLOOR })).toHaveLength(1);
  });
});

describe("a cell's best never falls, and the store says which way it refused", () => {
  test('THE NONDETERMINISTIC VERIFIER: re-recording one artifact worse is refused and changes nothing', () => {
    // The exact defect that made *The records store*'s monotone invariant false. One
    // artifact, measured 23 and then 40 by the same instrument on a different day — the
    // second measurement is not evidence the program got worse, and writing it would
    // lower this cell's best for every run that comes after.
    //
    // REFUSED rather than ignored, which is the choice this test pins: a silent no-op
    // leaves the caller unable to tell "nothing moved" from "the write happened".
    const sql = store();
    expect(recordExploration(sql, { publication: OPEN, write: write() }).kind).toBe('recorded');

    const verdict = recordExploration(sql, { publication: OPEN, write: write({ value: 40 }) });
    expect(verdict).toEqual({ kind: 'refused', cause: 'not-better' });

    // And the stored measurement STANDS. Asserted over the row rather than over the
    // verdict, because a writer that refused and wrote anyway would satisfy the line above.
    expect(bestInCell(sql, { identity: CHEAPER, floor: FLOOR, descriptor: null })?.value).toBe(23);
    expect(recordsFor(sql, { identity: CHEAPER, floor: FLOOR })).toHaveLength(1);
  });

  test('a TIE does not displace: `isBetter` is strict and a re-record of the same number moved nothing', () => {
    const sql = store();
    recordExploration(sql, { publication: OPEN, write: write() });
    expect(recordExploration(sql, { publication: OPEN, write: write() }))
      .toEqual({ kind: 'refused', cause: 'not-better' });
    expect(recordsFor(sql, { identity: CHEAPER, floor: FLOOR })).toHaveLength(1);
  });

  test('a BETTER re-record of the same artifact updates it and keeps its first-recorded time', () => {
    const sql = store();
    recordExploration(sql, { publication: OPEN, write: write() });
    const verdict = recordExploration(sql, {
      publication: OPEN, write: write({ value: 20, at: 1_700_000_999_999 }),
    });
    expect(verdict.kind).toBe('recorded');
    const best = bestInCell(sql, { identity: CHEAPER, floor: FLOOR, descriptor: null });
    expect(best?.value).toBe(20);
    // Identity within a cell is the artifact's own bytes, so this is an UPDATE and there
    // is one row — a second row would make the cell hold the same program twice.
    expect(recordsFor(sql, { identity: CHEAPER, floor: FLOOR })).toHaveLength(1);
    // When the artifact FIRST entered the store, not when it was last measured.
    expect(best?.firstRecordedAt).toBe(1_700_000_000_000);
  });

  test('a worse NEW artifact joins the population without lowering the best', () => {
    // The store holds a bounded population per cell rather than one incumbent — that is
    // FunSearch's program database, and a single incumbent is its own "W/O Evolution"
    // arm. So a worse program is ADMITTED, and `best(cell)` is a maximum over the rows
    // rather than the last thing written.
    const sql = store();
    recordExploration(sql, { publication: OPEN, write: write() });
    const verdict = recordExploration(sql, {
      publication: OPEN, write: write({ artifact: 'export function solve() { return 2; }', value: 40 }),
    });
    expect(verdict).toEqual({ kind: 'recorded', recordKey: expect.any(String), displaced: false });
    expect(recordsFor(sql, { identity: CHEAPER, floor: FLOOR })).toHaveLength(2);
    expect(bestInCell(sql, { identity: CHEAPER, floor: FLOOR, descriptor: null })?.value).toBe(23);
  });

  test('the DIRECTION decides which way is better, so a maximise objective is not silently inverted', () => {
    const sql = store();
    recordExploration(sql, { publication: OPEN, write: write({ identity: HIGHER, value: 0.6 }) });
    // Lower is WORSE here, so this is the refusal — and on a minimise identity the same
    // pair would have been an improvement, which is what makes this test load-bearing.
    expect(recordExploration(sql, { publication: OPEN, write: write({ identity: HIGHER, value: 0.4 }) }))
      .toEqual({ kind: 'refused', cause: 'not-better' });
    expect(recordExploration(sql, { publication: OPEN, write: write({ identity: HIGHER, value: 0.9 }) }).kind)
      .toBe('recorded');
    expect(bestInCell(sql, { identity: HIGHER, floor: FLOOR, descriptor: null })?.value).toBe(0.9);
  });
});

describe("displacements count what happened to a cell's best after a row was written", () => {
  test("every earlier row in the cell is bumped when the best moves, and the mover is not", () => {
    const sql = store();
    recordExploration(sql, { publication: OPEN, write: write({ artifact: 'a', value: 23 }) });
    recordExploration(sql, { publication: OPEN, write: write({ artifact: 'b', value: 40 }) });
    const moved = recordExploration(sql, { publication: OPEN, write: write({ artifact: 'c', value: 20 }) });
    expect(moved).toEqual({ kind: 'recorded', recordKey: expect.any(String), displaced: true });

    const byArtifact = new Map(
      recordsFor(sql, { identity: CHEAPER, floor: FLOOR }).map((row) => [row.artifact, row]),
    );
    // Both rows that were already there have seen the cell's best move once.
    expect(byArtifact.get('a')?.displacements).toBe(1);
    expect(byArtifact.get('b')?.displacements).toBe(1);
    // The row that did the moving has seen nothing move since it landed.
    expect(byArtifact.get('c')?.displacements).toBe(0);
  });

  test('a refused write bumps nothing — a displacement is a movement, not an attempt', () => {
    const sql = store();
    recordExploration(sql, { publication: OPEN, write: write({ artifact: 'a', value: 23 }) });
    recordExploration(sql, { publication: OPEN, write: write({ artifact: 'a', value: 40 }) });
    recordExploration(sql, { publication: SEALED, write: write({ artifact: 'z', value: 1 }) });
    expect(recordsFor(sql, { identity: CHEAPER, floor: FLOOR })[0]?.displacements).toBe(0);
  });

  test('a worse new member does not bump: the best did not move', () => {
    const sql = store();
    recordExploration(sql, { publication: OPEN, write: write({ artifact: 'a', value: 23 }) });
    recordExploration(sql, { publication: OPEN, write: write({ artifact: 'b', value: 40 }) });
    const byArtifact = new Map(
      recordsFor(sql, { identity: CHEAPER, floor: FLOOR }).map((row) => [row.artifact, row]),
    );
    expect(byArtifact.get('a')?.displacements).toBe(0);
    expect(byArtifact.get('b')?.displacements).toBe(0);
  });
});

describe('the key carries the floor, and the two nullable halves of it behave', () => {
  test('A CORRECTED FLOOR DOES NOT COLLAPSE ONTO THE WRONG ONE', () => {
    // The reason `floorDigest` exists. Both rows are the same objective and the same
    // program; they were admitted under DIFFERENT bounds, and a floor-blind key would
    // have made the second displace the first — after which nobody could say which
    // numbers had trusted the wrong bound.
    const sql = store();
    recordExploration(sql, { publication: OPEN, write: write({ floor: FLOOR }) });
    recordExploration(sql, { publication: OPEN, write: write({ floor: CORRECTED }) });
    const underWrong = recordsFor(sql, { identity: CHEAPER, floor: FLOOR });
    const underCorrected = recordsFor(sql, { identity: CHEAPER, floor: CORRECTED });
    expect(underWrong).toHaveLength(1);
    expect(underCorrected).toHaveLength(1);
    // And a reader need not resolve a digest to see what was claimed.
    expect(underWrong[0]?.floorValue).toBe(12);
    expect(underCorrected[0]?.floorValue).toBe(23);
    expect(underWrong[0]?.floorDigest).not.toBe(underCorrected[0]?.floorDigest);
  });

  test('NO FLOOR is its own comparable set, and null is not a floor of zero', () => {
    const sql = store();
    recordExploration(sql, { publication: OPEN, write: write({ floor: null }) });
    recordExploration(sql, { publication: OPEN, write: write({ floor: FLOOR }) });
    expect(recordsFor(sql, { identity: CHEAPER, floor: null })).toHaveLength(1);
    // NULL together, by construction rather than by a rule someone remembers: the writer
    // is handed the bound, not three fields it could set inconsistently.
    const [unbounded] = recordsFor(sql, { identity: CHEAPER, floor: null });
    expect(unbounded?.floorDigest).toBeNull();
    expect(unbounded?.floorValue).toBeNull();
    expect(unbounded?.floorProof).toBeNull();
  });

  test('the UNPARTITIONED, FLOORLESS cell is one row and not two — `IS` rather than `=`', () => {
    // Both nullable key columns at once, which is the case a composite NULLable primary
    // key would have failed silently: SQLite treats NULLs as distinct inside a UNIQUE
    // index, so the same program would have been insertable forever, and every read
    // scoped with `= NULL` would have returned nothing.
    const sql = store();
    expect(recordExploration(sql, {
      publication: OPEN, write: write({ floor: null, descriptor: null }),
    }).kind).toBe('recorded');
    expect(recordExploration(sql, {
      publication: OPEN, write: write({ floor: null, descriptor: null }),
    })).toEqual({ kind: 'refused', cause: 'not-better' });
    expect(recordsFor(sql, { identity: CHEAPER, floor: null })).toHaveLength(1);
    expect(bestInCell(sql, { identity: CHEAPER, floor: null, descriptor: null })?.value).toBe(23);
  });

  test('two DESCRIPTOR cells hold the same program independently, each with its own best', () => {
    const sql = store();
    recordExploration(sql, { publication: OPEN, write: write({ descriptor: 'sorting', value: 23 }) });
    recordExploration(sql, { publication: OPEN, write: write({ descriptor: 'hashing', value: 40 }) });
    expect(recordsFor(sql, { identity: CHEAPER, floor: FLOOR })).toHaveLength(2);
    expect(bestInCell(sql, { identity: CHEAPER, floor: FLOOR, descriptor: 'sorting' })?.value).toBe(23);
    expect(bestInCell(sql, { identity: CHEAPER, floor: FLOOR, descriptor: 'hashing' })?.value).toBe(40);
    // The unpartitioned cell is a THIRD thing and holds neither.
    expect(bestInCell(sql, { identity: CHEAPER, floor: FLOOR, descriptor: null })).toBeNull();
  });

  test('a different INSTRUMENT is a different objective, so nothing is pooled across it', () => {
    // The identity *Comparability* requires, completed: two runs whose `kind` resolved
    // to different code are not comparable, and `argumentDigest({kind, spec})` cannot tell.
    const sql = store();
    const other: ObjectiveIdentity = {
      ...CHEAPER,
      verifierDigest: verifierDigestOf(
        { kind: 'exec-ratio', spec: { params: { n: 24 } } }, 'exec-ratio@def456',
      ),
    };
    expect(objectiveIdOf(other)).not.toBe(objectiveIdOf(CHEAPER));
    recordExploration(sql, { publication: OPEN, write: write() });
    recordExploration(sql, { publication: OPEN, write: write({ identity: other, value: 20 }) });
    // The better number under the other instrument does not become this one's best.
    expect(bestInCell(sql, { identity: CHEAPER, floor: FLOOR, descriptor: null })?.value).toBe(23);
    expect(recordsFor(sql, { identity: CHEAPER, floor: FLOOR })).toHaveLength(1);
  });
});

describe('a row reads back as what was written', () => {
  test('every declared field survives the round trip, and absent stays absent', () => {
    const sql = store();
    recordExploration(sql, { publication: OPEN, write: write({ measured: null, costTokens: null }) });
    const [row] = recordsFor(sql, { identity: CHEAPER, floor: FLOOR });
    expect(row).toMatchObject({
      objectiveId: objectiveIdOf(CHEAPER),
      descriptor: null,
      value: 23,
      detail: "23 oracle calls against the reference's 276",
      preset: 'optimise',
      label: null,
      rootId: 'root-1',
      configDigest: 'cfg-1',
      depth: 5,
      branches: 3,
      floorValue: 12,
      displacements: 0,
    });
    // NULL means the run reported nothing, never that it reported zero.
    expect(row?.measured).toBeNull();
    expect(row?.costTokens).toBeNull();
    expect(row?.costUsd).toBeNull();
  });

  test('the raw quantities a value was derived from come back as numbers', () => {
    const sql = store();
    recordExploration(sql, { publication: OPEN, write: write() });
    expect(recordsFor(sql, { identity: CHEAPER, floor: FLOOR })[0]?.measured)
      .toEqual({ refOps: 276, candOps: 23 });
  });

  test('`recordsFor` orders best FIRST in the objective\'s own direction', () => {
    const sql = store();
    for (const value of [40, 23, 31]) {
      recordExploration(sql, { publication: OPEN, write: write({ artifact: `a${String(value)}`, value }) });
    }
    expect(recordsFor(sql, { identity: CHEAPER, floor: FLOOR }).map((row) => row.value))
      .toEqual([23, 31, 40]);
    for (const value of [0.4, 0.9, 0.6]) {
      recordExploration(sql, {
        publication: OPEN, write: write({ identity: HIGHER, artifact: `b${String(value)}`, value }),
      });
    }
    expect(recordsFor(sql, { identity: HIGHER, floor: FLOOR }).map((row) => row.value))
      .toEqual([0.9, 0.6, 0.4]);
  });

  test('the table survives a second init — a store is opened on every run', () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    const execRaw = makeExecRaw(db);
    initExplorationRecordsTable(execRaw, sql);
    recordExploration(sql, { publication: OPEN, write: write() });
    initExplorationRecordsTable(execRaw, sql);
    expect(recordsFor(sql, { identity: CHEAPER, floor: FLOOR })).toHaveLength(1);
  });
});

/* ── The archive, over the same rows ──────────────────────────────────────── */

// THE SAME REASON THIS FILE EXISTS, one layer up. `advance:'archive'` runs end to end in
// `unit-swarm-depth.test.ts`, where a real instrument witnesses real descriptors — and
// three of the things the admission test decides cannot be reached from a run at all: a
// run cannot seal itself and then find a near occupant already sitting in the cell it was
// about to write, cannot vary its own threshold mid-flight, and cannot put two artifacts
// with one vocabulary in two different cells to prove the cell scoping. Asserting those
// through `runSwarm` would assert whichever subset the engine happens to exercise.

/** A cell coordinate as `archiveCellOf` builds one: the declared key, and the value the
 *  instrument reported for it. Written out rather than computed so a change to the
 *  coordinate's SHAPE fails here instead of silently re-binning every cell. */
const CELL = 'candOps=23';

/** The occupant every test below admits first. Its vocabulary is what the near-duplicate
 *  shares and the far answer does not. */
const OCCUPANT = 'export function solve(input, oracle) { return input.tokens[0]; }';

/** ONE token away from {@link OCCUPANT} — the near-copy an archive exists to refuse.
 *  Distance 1/9: eight tokens shared, nine in the union. */
const NEAR = `${OCCUPANT} // tweak`;

/** Nothing in common with it, so the admission test must let it in at any threshold
 *  below 1. */
const FAR = 'const answer = 42;';

function cellWrite(over?: Partial<ArchiveWrite>): ArchiveWrite {
  return { ...write(), descriptor: CELL, artifact: OCCUPANT, ...over };
}

describe('the cell coordinate is witnessed, not claimed', () => {
  test('a reported quantity becomes the cell, and the dimension travels with it', () => {
    // `<key>=<value>` and not the bare value: `key` is not part of the objective's
    // identity, so two runs binning the same objective on different dimensions would
    // otherwise write coordinates from two grids into one cell space.
    expect(archiveCellOf('candOps', { refOps: 276, candOps: 23 }))
      .toEqual({ kind: 'cell', descriptor: 'candOps=23' });
    expect(archiveCellOf('refOps', { refOps: 276, candOps: 23 }))
      .toEqual({ kind: 'cell', descriptor: 'refOps=276' });
  });

  test('a key no instrument reported is UNWITNESSED, and it names what was reported', () => {
    // Not a cell called "undefined", and not the unpartitioned cell either: a candidate
    // with no coordinate has no cell, and the two are the distinction `descriptor`'s
    // nullability keeps.
    expect(archiveCellOf('tactic', { refOps: 276, candOps: 23 }))
      .toEqual({ kind: 'unwitnessed', reported: ['candOps', 'refOps'] });
    expect(archiveCellOf('candOps', undefined)).toEqual({ kind: 'unwitnessed', reported: [] });
  });

  test('a non-finite coordinate does not identify a partition', () => {
    // Otherwise every candidate whose descriptor could not be computed shares one cell
    // called "NaN" and the archive reports coverage over it.
    expect(archiveCellOf('candOps', { candOps: Number.NaN }).kind).toBe('unwitnessed');
    expect(archiveCellOf('candOps', { candOps: Number.POSITIVE_INFINITY }).kind).toBe('unwitnessed');
  });
});

describe('the novelty distance, in the direction the threshold reads it', () => {
  test('identical is 0, disjoint is 1, and it is symmetric', () => {
    // THE MUTATION CHECK, at the measure rather than at the comparison: a distance
    // silently returning the SIMILARITY instead passes any suite that only ever asserts
    // "something was refused", because every threshold then admits exactly the set it
    // should have refused. Pinning both ends is what makes that inversion red.
    expect(noveltyDistance(OCCUPANT, OCCUPANT)).toBe(0);
    expect(noveltyDistance(OCCUPANT, FAR)).toBe(1);
    expect(noveltyDistance(OCCUPANT, NEAR)).toBeCloseTo(1 / 9, 10);
    expect(noveltyDistance(NEAR, OCCUPANT)).toBe(noveltyDistance(OCCUPANT, NEAR));
  });

  test('two empty artifacts are the same artifact, not two novel ones', () => {
    expect(noveltyDistance('', '')).toBe(0);
    expect(noveltyDistance('', OCCUPANT)).toBe(1);
  });
});

describe('the archive admits by cell and refuses by novelty', () => {
  test('an empty cell admits — there is no occupant to be too close to', () => {
    const sql = store();
    expect(admitToArchive(sql, { publication: OPEN, write: cellWrite(), novelty: 0.5 }).kind)
      .toBe('recorded');
    expect(bestInCell(sql, { identity: CHEAPER, floor: FLOOR, descriptor: CELL })?.artifact)
      .toBe(OCCUPANT);
  });

  test('A NEAR-COPY IS REFUSED, AND THE REFUSAL NAMES THE OCCUPANT IT COLLIDED WITH', () => {
    // The whole admission test. The second artifact measures BETTER and is still refused:
    // a cell holds a behaviour, and a better way of writing the same answer adds no
    // coverage. That is what an archive is FOR — ten variants of one exploit are one
    // finding — and an archive with no rejection test collapses onto one answer per cell
    // while still reporting coverage, which is why *The archive* admits by a rejection
    // test and never by a score.
    const sql = store();
    admitToArchive(sql, { publication: OPEN, write: cellWrite(), novelty: 0.5 });
    const occupant = bestInCell(sql, { identity: CHEAPER, floor: FLOOR, descriptor: CELL });
    // The cell IS occupied before the collision, so the digest below is a real row's and
    // not an `undefined` matching an absent field.
    expect(occupant?.artifact).toBe(OCCUPANT);
    const verdict = admitToArchive(sql, {
      publication: OPEN, write: cellWrite({ artifact: NEAR, value: 19 }), novelty: 0.5,
    });
    expect(verdict).toEqual({
      kind: 'refused',
      cause: 'too-close',
      occupant: occupant?.artifactDigest ?? '',
      distance: noveltyDistance(NEAR, OCCUPANT),
      novelty: 0.5,
    });
    // And nothing landed: a refusal that still wrote the row would report coverage it did
    // not have.
    expect(recordsFor(sql, { identity: CHEAPER, floor: FLOOR })).toHaveLength(1);
  });

  test('a novel artifact joins the cell as a second occupant', () => {
    // NOT VACUOUS: without this the test above passes on an archive that refuses
    // everything, which is the other half of the inverted threshold.
    const sql = store();
    admitToArchive(sql, { publication: OPEN, write: cellWrite(), novelty: 0.5 });
    expect(admitToArchive(sql, {
      publication: OPEN, write: cellWrite({ artifact: FAR, value: 31 }), novelty: 0.5,
    }).kind).toBe('recorded');
    expect(recordsFor(sql, { identity: CHEAPER, floor: FLOOR })).toHaveLength(2);
  });

  test('THE THRESHOLD IS READ AS A FLOOR: 0 admits the near-copy, 1 refuses the far one', () => {
    // THE MUTATION CHECK at the comparison. `distance < novelty` refuses and
    // `distance > novelty` would too — both look plausible, and both are green against a
    // suite that only ever asserts one threshold. These two ends disagree under the
    // inversion: at 0 nothing can be too close, and at 1 only an answer sharing no
    // vocabulary at all clears the floor.
    const permissive = store();
    admitToArchive(permissive, { publication: OPEN, write: cellWrite(), novelty: 0 });
    expect(admitToArchive(permissive, {
      publication: OPEN, write: cellWrite({ artifact: NEAR, value: 19 }), novelty: 0,
    }).kind).toBe('recorded');

    const strict = store();
    admitToArchive(strict, { publication: OPEN, write: cellWrite(), novelty: 1 });
    const verdict = admitToArchive(strict, {
      publication: OPEN, write: cellWrite({ artifact: FAR, value: 31 }), novelty: 1,
    });
    // Distance exactly 1 CLEARS a floor of 1 — the candidate has to reach the floor, not
    // beat it — so the far answer is the one thing a threshold of 1 still admits.
    expect(verdict.kind).toBe('recorded');
    expect(admitToArchive(strict, {
      publication: OPEN, write: cellWrite({ artifact: `${OCCUPANT} const answer = 42;`, value: 17 }),
      novelty: 1,
    })).toMatchObject({ kind: 'refused', cause: 'too-close' });
  });

  test('THE NEAREST occupant is named, not whichever one the cell was sorted on top', () => {
    // A cell is read best-first, so refusing on the first failure would report the
    // best-scoring collision and leave an exact duplicate two rows down unmentioned. The
    // occupant a refusal names has to be a fact about the candidate rather than about the
    // sort: here the far answer scores BEST and the near-copy is what the refusal is
    // actually about.
    const sql = store();
    admitToArchive(sql, { publication: OPEN, write: cellWrite({ artifact: FAR, value: 11 }), novelty: 0.5 });
    admitToArchive(sql, { publication: OPEN, write: cellWrite({ artifact: OCCUPANT, value: 40 }), novelty: 0.5 });
    expect(bestInCell(sql, { identity: CHEAPER, floor: FLOOR, descriptor: CELL })?.artifact).toBe(FAR);
    const verdict = admitToArchive(sql, {
      publication: OPEN, write: cellWrite({ artifact: NEAR, value: 19 }), novelty: 0.5,
    });
    expect(verdict).toMatchObject({
      cause: 'too-close',
      distance: noveltyDistance(NEAR, OCCUPANT),
    });
  });

  test('a cell is scoped: an occupant of ANOTHER cell is no reason to refuse', () => {
    // `NULL`-safe, cell-scoped SQL is what this asserts — the same trap the reads above
    // are written against. An admission test that read the whole comparable set instead of
    // one partition would make the archive a leaderboard with extra steps: covering a new
    // behaviour would be refused for resembling an answer in a different cell.
    const sql = store();
    admitToArchive(sql, { publication: OPEN, write: cellWrite(), novelty: 0.5 });
    expect(admitToArchive(sql, {
      publication: OPEN, write: cellWrite({ descriptor: 'candOps=40', artifact: NEAR, value: 40 }),
      novelty: 0.5,
    }).kind).toBe('recorded');
    expect(bestInCell(sql, { identity: CHEAPER, floor: FLOOR, descriptor: 'candOps=40' })?.artifact)
      .toBe(NEAR);
  });

  test('re-recording the SAME artifact is the monotone rule, never an admission question', () => {
    // Distance to itself is 0, so an admission test that did not exclude the row it is
    // addressing would refuse every re-measurement as a duplicate of itself — and the
    // monotone rule, which is the thing that decides a re-record, would become
    // unreachable through the archive.
    const sql = store();
    admitToArchive(sql, { publication: OPEN, write: cellWrite(), novelty: 0.5 });
    expect(admitToArchive(sql, {
      publication: OPEN, write: cellWrite({ value: 23 }), novelty: 0.5,
    })).toEqual({ kind: 'refused', cause: 'not-better' });
    expect(admitToArchive(sql, {
      publication: OPEN, write: cellWrite({ value: 11 }), novelty: 0.5,
    }).kind).toBe('recorded');
    expect(bestInCell(sql, { identity: CHEAPER, floor: FLOOR, descriptor: CELL })?.value).toBe(11);
  });
});

describe('the seal gates the archive too, and it is checked BEFORE the cell is read', () => {
  test('a breached run is refused as SEALED even where a near occupant is sitting there', () => {
    // THE RED DIRECTION: delete the `admitsPublication` call at the top of
    // `admitToArchive` and this goes red — the verdict becomes
    // `{cause:'too-close', occupant}`, because the archive read the cell it may not write
    // and answered a question about proximity. The row still would not land (the store
    // checks the seal as well), which is exactly why the CAUSE is the assertion: a sealed
    // run refused for duplicating something is told the wrong thing about itself, and the
    // remedy it names — write something more novel — is not the one that clears a seal.
    const sql = store();
    admitToArchive(sql, { publication: OPEN, write: cellWrite(), novelty: 0.5 });
    expect(admitToArchive(sql, {
      publication: SEALED, write: cellWrite({ artifact: NEAR, value: 19 }), novelty: 0.5,
    })).toEqual({ kind: 'refused', cause: 'sealed' });
    expect(recordsFor(sql, { identity: CHEAPER, floor: FLOOR })).toHaveLength(1);
  });

  test('a recorded re-derivation admits again, so the gate is the verdict and not the tag', () => {
    const sql = store();
    expect(admitToArchive(sql, { publication: REDERIVED, write: cellWrite(), novelty: 0.5 }).kind)
      .toBe('recorded');
    expect(recordsFor(sql, { identity: CHEAPER, floor: FLOOR })).toHaveLength(1);
  });
});
