// The records store and the archive over it, on real SQLite rows: the invariants are SQL-shaped
// (`NULL = NULL` is unknown; NULLs are distinct in a UNIQUE index). The run-level wiring is in
// `unit-swarm-depth.test.ts`. Spec: docs/EXPLORATION.md "The records store", "The archive".
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw } from './helpers';
import { createTestActorsOver } from '@kinu.run/test-utils';
import {
  bestInCell, initExplorationRecordsTable, objectiveIdOf, recordExploration, recordsFor,
  sealRecords, verifierDigestOf,
  type ExplorationWrite,
} from '../src/strategy/records';
import {
  admitToArchive, archiveCellOf, noveltyDistance, type ArchiveWrite,
} from '../src/strategy/archive';
import type {
  Floor, FloorBreach, ObjectiveIdentity, PublicationState,
} from '../src/strategy/objective';
import type { SqlExecutor } from '../src/types/primitives';
import type { ActorHandle } from '../src/identity/actor-handle';

/** One records store and the actor whose rows it holds; every read is scoped by `actor_id`. */
interface Store {
  readonly sql: SqlExecutor;
  readonly actor: ActorHandle;
}

function store(): Store {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  initExplorationRecordsTable(makeExecRaw(db));

  return { sql, actor: createTestActorsOver(db).main };
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

const FLOOR: Floor = {
  value: 12,
  kind: 'certificate',
  bestKnownHonest: 23,
  proof: 'Every token must appear in at least one comparison and a comparison touches two.',
};

/** The same objective under a corrected bound. */
const CORRECTED: Floor = { ...FLOOR, value: 23, proof: 'A call touches one token, not two.' };

const OPEN: PublicationState = { kind: 'open' };

const BREACH: FloorBreach = {
  floor: FLOOR,
  measured: { kind: 'measured', value: 8, detail: '8 oracle calls' },
  margin: (23 - 12) / 23,
  hypotheses: ['floor_wrong', 'verifier_gameable'],
};

const SEALED: PublicationState = { kind: 'sealed', breach: BREACH };

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
    // Red if `recordExploration` drops its `admitsPublication` call; the barrier's gate is a second, independent check.
    const { sql, actor } = store();
    expect(recordExploration(sql, actor, { publication: SEALED, write: write() }))
      .toEqual({ kind: 'refused', cause: 'sealed' });
    expect(recordsFor(sql, actor, { identity: CHEAPER, floor: FLOOR })).toHaveLength(0);
  });

  test('a re-derived floor publishes under its own key while the breached floor stays sealed', () => {
    const { sql, actor } = store();
    sealRecords(sql, actor, { identity: CHEAPER, breach: BREACH, at: 0 });
    expect(recordExploration(sql, actor, { publication: OPEN, write: write() }))
      .toEqual({ kind: 'refused', cause: 'sealed' });
    expect(recordExploration(sql, actor, { publication: OPEN, write: write({ floor: CORRECTED }) }).kind)
      .toBe('recorded');
    expect(recordsFor(sql, actor, { identity: CHEAPER, floor: CORRECTED })).toHaveLength(1);
  });

  test('an open run writes, so the two tests above are not passing on a store that never writes', () => {
    const { sql, actor } = store();
    expect(recordExploration(sql, actor, { publication: OPEN, write: write() }).kind).toBe('recorded');
    expect(recordsFor(sql, actor, { identity: CHEAPER, floor: FLOOR })).toHaveLength(1);
  });
});

describe("a cell's best never falls, and the store says which way it refused", () => {
  test('THE NONDETERMINISTIC VERIFIER: re-recording one artifact worse is refused and changes nothing', () => {
    // A worse re-measurement of the same artifact must not lower the cell's best, and is refused rather than ignored.
    const { sql, actor } = store();
    expect(recordExploration(sql, actor, { publication: OPEN, write: write() }).kind).toBe('recorded');

    const verdict = recordExploration(sql, actor, { publication: OPEN, write: write({ value: 40 }) });
    expect(verdict).toEqual({ kind: 'refused', cause: 'not-better' });

    // Asserted over the row: a writer that refused and wrote anyway would pass the verdict check.
    expect(bestInCell(sql, actor, { identity: CHEAPER, floor: FLOOR, descriptor: null })?.value).toBe(23);
    expect(recordsFor(sql, actor, { identity: CHEAPER, floor: FLOOR })).toHaveLength(1);
  });

  test('a TIE does not displace: `isBetter` is strict and a re-record of the same number moved nothing', () => {
    const { sql, actor } = store();
    recordExploration(sql, actor, { publication: OPEN, write: write() });
    expect(recordExploration(sql, actor, { publication: OPEN, write: write() }))
      .toEqual({ kind: 'refused', cause: 'not-better' });
    expect(recordsFor(sql, actor, { identity: CHEAPER, floor: FLOOR })).toHaveLength(1);
  });

  test('a BETTER re-record of the same artifact updates it and keeps its first-recorded time', () => {
    const { sql, actor } = store();
    recordExploration(sql, actor, { publication: OPEN, write: write() });

    const verdict = recordExploration(sql, actor, {
      publication: OPEN, write: write({ value: 20, at: 1_700_000_999_999 }),
    });

    expect(verdict.kind).toBe('recorded');
    const best = bestInCell(sql, actor, { identity: CHEAPER, floor: FLOOR, descriptor: null });
    expect(best?.value).toBe(20);
    // Identity within a cell is the artifact's bytes, so this is an UPDATE of one row.
    expect(recordsFor(sql, actor, { identity: CHEAPER, floor: FLOOR })).toHaveLength(1);
    expect(best?.firstRecordedAt).toBe(1_700_000_000_000);
  });

  test('a worse NEW artifact joins the population without lowering the best', () => {
    // A cell holds a population, not one incumbent: a worse program is admitted and `best(cell)` is a maximum.
    const { sql, actor } = store();
    recordExploration(sql, actor, { publication: OPEN, write: write() });

    const verdict = recordExploration(sql, actor, {
      publication: OPEN, write: write({ artifact: 'export function solve() { return 2; }', value: 40 }),
    });

    expect(verdict).toEqual({ kind: 'recorded', recordKey: expect.any(String), displaced: false });
    expect(recordsFor(sql, actor, { identity: CHEAPER, floor: FLOOR })).toHaveLength(2);
    expect(bestInCell(sql, actor, { identity: CHEAPER, floor: FLOOR, descriptor: null })?.value).toBe(23);
  });

  test('the DIRECTION decides which way is better, so a maximise objective is not silently inverted', () => {
    const { sql, actor } = store();
    recordExploration(sql, actor, { publication: OPEN, write: write({ identity: HIGHER, value: 0.6 }) });
    // Refused here; under a minimise identity the same pair would be an improvement.
    expect(recordExploration(sql, actor, { publication: OPEN, write: write({ identity: HIGHER, value: 0.4 }) }))
      .toEqual({ kind: 'refused', cause: 'not-better' });
    expect(recordExploration(sql, actor, { publication: OPEN, write: write({ identity: HIGHER, value: 0.9 }) }).kind)
      .toBe('recorded');
    expect(bestInCell(sql, actor, { identity: HIGHER, floor: FLOOR, descriptor: null })?.value).toBe(0.9);
  });
});

describe("displacements count what happened to a cell's best after a row was written", () => {
  test("every earlier row in the cell is bumped when the best moves, and the mover is not", () => {
    const { sql, actor } = store();
    recordExploration(sql, actor, { publication: OPEN, write: write({ artifact: 'a', value: 23 }) });
    recordExploration(sql, actor, { publication: OPEN, write: write({ artifact: 'b', value: 40 }) });
    const moved = recordExploration(sql, actor, { publication: OPEN, write: write({ artifact: 'c', value: 20 }) });
    expect(moved).toEqual({ kind: 'recorded', recordKey: expect.any(String), displaced: true });

    const byArtifact = new Map(
      recordsFor(sql, actor, { identity: CHEAPER, floor: FLOOR }).map((row) => [row.artifact, row]),
    );

    expect(byArtifact.get('a')?.displacements).toBe(1);
    expect(byArtifact.get('b')?.displacements).toBe(1);
    expect(byArtifact.get('c')?.displacements).toBe(0);
  });

  test('a refused write bumps nothing — a displacement is a movement, not an attempt', () => {
    const { sql, actor } = store();
    recordExploration(sql, actor, { publication: OPEN, write: write({ artifact: 'a', value: 23 }) });
    recordExploration(sql, actor, { publication: OPEN, write: write({ artifact: 'a', value: 40 }) });
    recordExploration(sql, actor, { publication: SEALED, write: write({ artifact: 'z', value: 1 }) });
    expect(recordsFor(sql, actor, { identity: CHEAPER, floor: FLOOR })[0]?.displacements).toBe(0);
  });

  test('a worse new member does not bump: the best did not move', () => {
    const { sql, actor } = store();
    recordExploration(sql, actor, { publication: OPEN, write: write({ artifact: 'a', value: 23 }) });
    recordExploration(sql, actor, { publication: OPEN, write: write({ artifact: 'b', value: 40 }) });

    const byArtifact = new Map(
      recordsFor(sql, actor, { identity: CHEAPER, floor: FLOOR }).map((row) => [row.artifact, row]),
    );

    expect(byArtifact.get('a')?.displacements).toBe(0);
    expect(byArtifact.get('b')?.displacements).toBe(0);
  });
});

describe('the key carries the floor, and the two nullable halves of it behave', () => {
  test('A CORRECTED FLOOR DOES NOT COLLAPSE ONTO THE WRONG ONE', () => {
    // `floorDigest` keeps rows admitted under different bounds separate.
    const { sql, actor } = store();
    recordExploration(sql, actor, { publication: OPEN, write: write({ floor: FLOOR }) });
    recordExploration(sql, actor, { publication: OPEN, write: write({ floor: CORRECTED }) });
    const underWrong = recordsFor(sql, actor, { identity: CHEAPER, floor: FLOOR });
    const underCorrected = recordsFor(sql, actor, { identity: CHEAPER, floor: CORRECTED });
    expect(underWrong).toHaveLength(1);
    expect(underCorrected).toHaveLength(1);
    expect(underWrong[0]?.floorValue).toBe(12);
    expect(underCorrected[0]?.floorValue).toBe(23);
    expect(underWrong[0]?.floorDigest).not.toBe(underCorrected[0]?.floorDigest);
  });

  test('NO FLOOR is its own comparable set, and null is not a floor of zero', () => {
    const { sql, actor } = store();
    recordExploration(sql, actor, { publication: OPEN, write: write({ floor: null }) });
    recordExploration(sql, actor, { publication: OPEN, write: write({ floor: FLOOR }) });
    expect(recordsFor(sql, actor, { identity: CHEAPER, floor: null })).toHaveLength(1);
    const [unbounded] = recordsFor(sql, actor, { identity: CHEAPER, floor: null });
    expect(unbounded?.floorDigest).toBeNull();
    expect(unbounded?.floorValue).toBeNull();
    expect(unbounded?.floorProof).toBeNull();
  });

  test('the UNPARTITIONED, FLOORLESS cell is one row and not two — `IS` rather than `=`', () => {
    // Both nullable key columns at once: SQLite treats NULLs as distinct in a UNIQUE index.
    const { sql, actor } = store();
    expect(recordExploration(sql, actor, {
      publication: OPEN, write: write({ floor: null, descriptor: null }),
    }).kind).toBe('recorded');
    expect(recordExploration(sql, actor, {
      publication: OPEN, write: write({ floor: null, descriptor: null }),
    })).toEqual({ kind: 'refused', cause: 'not-better' });
    expect(recordsFor(sql, actor, { identity: CHEAPER, floor: null })).toHaveLength(1);
    expect(bestInCell(sql, actor, { identity: CHEAPER, floor: null, descriptor: null })?.value).toBe(23);
  });

  test('two DESCRIPTOR cells hold the same program independently, each with its own best', () => {
    const { sql, actor } = store();
    recordExploration(sql, actor, { publication: OPEN, write: write({ descriptor: 'sorting', value: 23 }) });
    recordExploration(sql, actor, { publication: OPEN, write: write({ descriptor: 'hashing', value: 40 }) });
    expect(recordsFor(sql, actor, { identity: CHEAPER, floor: FLOOR })).toHaveLength(2);
    expect(bestInCell(sql, actor, { identity: CHEAPER, floor: FLOOR, descriptor: 'sorting' })?.value).toBe(23);
    expect(bestInCell(sql, actor, { identity: CHEAPER, floor: FLOOR, descriptor: 'hashing' })?.value).toBe(40);
    expect(bestInCell(sql, actor, { identity: CHEAPER, floor: FLOOR, descriptor: null })).toBeNull();
  });

  test('a different INSTRUMENT is a different objective, so nothing is pooled across it', () => {
    // Runs whose `kind` resolved to different code are not comparable; `argumentDigest({kind, spec})` cannot tell.
    const { sql, actor } = store();

    const other: ObjectiveIdentity = {
      ...CHEAPER,
      verifierDigest: verifierDigestOf(
        { kind: 'exec-ratio', spec: { params: { n: 24 } } }, 'exec-ratio@def456',
      ),
    };

    // Pinned digest: a change to the identity's shape fails here instead of re-keying every objective.
    expect(objectiveIdOf(other)).not.toBe(
      '26ce2d9c78bf36bec03eff2aac483340f6c7739d81ffd5eaa55a3e25a1e09cc4',
    );
    recordExploration(sql, actor, { publication: OPEN, write: write() });
    recordExploration(sql, actor, { publication: OPEN, write: write({ identity: other, value: 20 }) });
    expect(bestInCell(sql, actor, { identity: CHEAPER, floor: FLOOR, descriptor: null })?.value).toBe(23);
    expect(recordsFor(sql, actor, { identity: CHEAPER, floor: FLOOR })).toHaveLength(1);
  });
});

describe('a row reads back as what was written', () => {
  test('every declared field survives the round trip, and absent stays absent', () => {
    const { sql, actor } = store();
    recordExploration(sql, actor, { publication: OPEN, write: write({ measured: null, costTokens: null }) });
    const [row] = recordsFor(sql, actor, { identity: CHEAPER, floor: FLOOR });
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
    // NULL means the run reported nothing, never zero.
    expect(row?.measured).toBeNull();
    expect(row?.costTokens).toBeNull();
    expect(row?.costUsd).toBeNull();
  });

  test('the raw quantities a value was derived from come back as numbers', () => {
    const { sql, actor } = store();
    recordExploration(sql, actor, { publication: OPEN, write: write() });
    expect(recordsFor(sql, actor, { identity: CHEAPER, floor: FLOOR })[0]?.measured)
      .toEqual({ refOps: 276, candOps: 23 });
  });

  test('`recordsFor` orders best FIRST in the objective\'s own direction', () => {
    const { sql, actor } = store();

    for (const value of [40, 23, 31]) {
      recordExploration(sql, actor, { publication: OPEN, write: write({ artifact: `a${String(value)}`, value }) });
    }

    expect(recordsFor(sql, actor, { identity: CHEAPER, floor: FLOOR }).map((row) => row.value))
      .toEqual([23, 31, 40]);

    for (const value of [0.4, 0.9, 0.6]) {
      recordExploration(sql, actor, {
        publication: OPEN, write: write({ identity: HIGHER, artifact: `b${String(value)}`, value }),
      });
    }

    expect(recordsFor(sql, actor, { identity: HIGHER, floor: FLOOR }).map((row) => row.value))
      .toEqual([0.9, 0.6, 0.4]);
  });

  test('the table survives a second init — a store is opened on every run', () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    const execRaw = makeExecRaw(db);
    initExplorationRecordsTable(execRaw);
    const actor = createTestActorsOver(db).main;
    recordExploration(sql, actor, { publication: OPEN, write: write() });
    initExplorationRecordsTable(execRaw);
    expect(recordsFor(sql, actor, { identity: CHEAPER, floor: FLOOR })).toHaveLength(1);
  });
});

/** Written out rather than computed, so a change to the coordinate's shape fails here. */
const CELL = 'candOps=23';

const OCCUPANT = 'export function solve(input, oracle) { return input.tokens[0]; }';

/** One token away from {@link OCCUPANT}: distance 1/9. */
const NEAR = `${OCCUPANT} // tweak`;

const FAR = 'const answer = 42;';

function cellWrite(over?: Partial<ArchiveWrite>): ArchiveWrite {
  return { ...write(), descriptor: CELL, artifact: OCCUPANT, ...over };
}

describe('the cell coordinate is witnessed, not claimed', () => {
  test('a reported quantity becomes the cell, and the dimension travels with it', () => {
    // `<key>=<value>`: `key` is not part of the objective identity, so bare values from two grids would share one cell space.
    expect(archiveCellOf('candOps', { refOps: 276, candOps: 23 }))
      .toEqual({ kind: 'cell', descriptor: 'candOps=23' });
    expect(archiveCellOf('refOps', { refOps: 276, candOps: 23 }))
      .toEqual({ kind: 'cell', descriptor: 'refOps=276' });
  });

  test('a key no instrument reported is UNWITNESSED, and it names what was reported', () => {
    // No coordinate means no cell, distinct from the unpartitioned cell.
    expect(archiveCellOf('tactic', { refOps: 276, candOps: 23 }))
      .toEqual({ kind: 'unwitnessed', reported: ['candOps', 'refOps'] });
    expect(archiveCellOf('candOps', undefined)).toEqual({ kind: 'unwitnessed', reported: [] });
  });

  test('a non-finite coordinate does not identify a partition', () => {
    expect(archiveCellOf('candOps', { candOps: Number.NaN }).kind).toBe('unwitnessed');
    expect(archiveCellOf('candOps', { candOps: Number.POSITIVE_INFINITY }).kind).toBe('unwitnessed');
  });
});

describe('the novelty distance, in the direction the threshold reads it', () => {
  test('identical is 0, disjoint is 1, and it is symmetric', () => {
    // Pins both ends so a distance that returns similarity instead goes red.
    expect(noveltyDistance(OCCUPANT, OCCUPANT)).toBe(0);
    expect(noveltyDistance(OCCUPANT, FAR)).toBe(1);
    expect(noveltyDistance(OCCUPANT, NEAR)).toBeCloseTo(1 / 9, 10);
    expect(noveltyDistance(NEAR, OCCUPANT)).toBeCloseTo(1 / 9, 10);
  });

  test('two empty artifacts are the same artifact, not two novel ones', () => {
    expect(noveltyDistance('', '')).toBe(0);
    expect(noveltyDistance('', OCCUPANT)).toBe(1);
  });
});

describe('the archive admits by cell and refuses by novelty', () => {
  test('an empty cell admits — there is no occupant to be too close to', () => {
    const { sql, actor } = store();
    expect(admitToArchive(sql, actor, { publication: OPEN, write: cellWrite(), novelty: 0.5 }).kind)
      .toBe('recorded');
    expect(bestInCell(sql, actor, { identity: CHEAPER, floor: FLOOR, descriptor: CELL })?.artifact)
      .toBe(OCCUPANT);
  });

  test('A NEAR-COPY IS REFUSED, AND THE REFUSAL NAMES THE OCCUPANT IT COLLIDED WITH', () => {
    // Measures better and is still refused: a cell holds a behaviour, and the archive admits by rejection test, never by score.
    const { sql, actor } = store();
    admitToArchive(sql, actor, { publication: OPEN, write: cellWrite(), novelty: 0.5 });
    const occupant = bestInCell(sql, actor, { identity: CHEAPER, floor: FLOOR, descriptor: CELL });
    // The cell is occupied before the collision, so the digest below is a real row's.
    expect(occupant?.artifact).toBe(OCCUPANT);

    const verdict = admitToArchive(sql, actor, {
      publication: OPEN, write: cellWrite({ artifact: NEAR, value: 19 }), novelty: 0.5,
    });

    expect(verdict).toEqual({
      kind: 'refused',
      cause: 'too-close',
      occupant: occupant?.artifactDigest ?? '',
      distance: noveltyDistance(NEAR, OCCUPANT),
      novelty: 0.5,
    });
    expect(recordsFor(sql, actor, { identity: CHEAPER, floor: FLOOR })).toHaveLength(1);
  });

  test('a novel artifact joins the cell as a second occupant', () => {
    // Without this, an archive that refuses everything passes.
    const { sql, actor } = store();
    admitToArchive(sql, actor, { publication: OPEN, write: cellWrite(), novelty: 0.5 });
    expect(admitToArchive(sql, actor, {
      publication: OPEN, write: cellWrite({ artifact: FAR, value: 31 }), novelty: 0.5,
    }).kind).toBe('recorded');
    expect(recordsFor(sql, actor, { identity: CHEAPER, floor: FLOOR })).toHaveLength(2);
  });

  test('THE THRESHOLD IS READ AS A FLOOR: 0 admits the near-copy, 1 refuses the far one', () => {
    // Pins the comparison direction: at 0 nothing is too close; at 1 only a disjoint vocabulary clears.
    const { sql: permissive, actor } = store();
    admitToArchive(permissive, actor, { publication: OPEN, write: cellWrite(), novelty: 0 });
    expect(admitToArchive(permissive, actor, {
      publication: OPEN, write: cellWrite({ artifact: NEAR, value: 19 }), novelty: 0,
    }).kind).toBe('recorded');

    const { sql: strict } = store();
    admitToArchive(strict, actor, { publication: OPEN, write: cellWrite(), novelty: 1 });

    const verdict = admitToArchive(strict, actor, {
      publication: OPEN, write: cellWrite({ artifact: FAR, value: 31 }), novelty: 1,
    });

    // Distance exactly 1 clears a floor of 1.
    expect(verdict.kind).toBe('recorded');
    expect(admitToArchive(strict, actor, {
      publication: OPEN, write: cellWrite({ artifact: `${OCCUPANT} const answer = 42;`, value: 17 }),
      novelty: 1,
    })).toMatchObject({ kind: 'refused', cause: 'too-close' });
  });

  test('THE NEAREST occupant is named, not whichever one the cell was sorted on top', () => {
    // The refusal names the colliding occupant, not the best-scoring row of the cell.
    const { sql, actor } = store();
    admitToArchive(sql, actor, { publication: OPEN, write: cellWrite({ artifact: FAR, value: 11 }), novelty: 0.5 });
    admitToArchive(sql, actor, { publication: OPEN, write: cellWrite({ artifact: OCCUPANT, value: 40 }), novelty: 0.5 });
    expect(bestInCell(sql, actor, { identity: CHEAPER, floor: FLOOR, descriptor: CELL })?.artifact).toBe(FAR);

    const verdict = admitToArchive(sql, actor, {
      publication: OPEN, write: cellWrite({ artifact: NEAR, value: 19 }), novelty: 0.5,
    });

    expect(verdict).toMatchObject({
      cause: 'too-close',
      distance: noveltyDistance(NEAR, OCCUPANT),
    });
  });

  test('a cell is scoped: an occupant of ANOTHER cell is no reason to refuse', () => {
    // The admission test reads one NULL-safe partition, not the whole comparable set.
    const { sql, actor } = store();
    admitToArchive(sql, actor, { publication: OPEN, write: cellWrite(), novelty: 0.5 });
    expect(admitToArchive(sql, actor, {
      publication: OPEN, write: cellWrite({ descriptor: 'candOps=40', artifact: NEAR, value: 40 }),
      novelty: 0.5,
    }).kind).toBe('recorded');
    expect(bestInCell(sql, actor, { identity: CHEAPER, floor: FLOOR, descriptor: 'candOps=40' })?.artifact)
      .toBe(NEAR);
  });

  test('re-recording the SAME artifact is the monotone rule, never an admission question', () => {
    // The row being addressed is excluded, or every re-measurement would collide with itself.
    const { sql, actor } = store();
    admitToArchive(sql, actor, { publication: OPEN, write: cellWrite(), novelty: 0.5 });
    expect(admitToArchive(sql, actor, {
      publication: OPEN, write: cellWrite({ value: 23 }), novelty: 0.5,
    })).toEqual({ kind: 'refused', cause: 'not-better' });
    expect(admitToArchive(sql, actor, {
      publication: OPEN, write: cellWrite({ value: 11 }), novelty: 0.5,
    }).kind).toBe('recorded');
    expect(bestInCell(sql, actor, { identity: CHEAPER, floor: FLOOR, descriptor: CELL })?.value).toBe(11);
  });
});

describe('the seal gates the archive too, and it is checked BEFORE the cell is read', () => {
  test('a breached run is refused as SEALED even where a near occupant is sitting there', () => {
    // Red if `admitToArchive` drops its `admitsPublication` call: the cause must be the seal, not `too-close`.
    const { sql, actor } = store();
    admitToArchive(sql, actor, { publication: OPEN, write: cellWrite(), novelty: 0.5 });
    expect(admitToArchive(sql, actor, {
      publication: SEALED, write: cellWrite({ artifact: NEAR, value: 19 }), novelty: 0.5,
    })).toEqual({ kind: 'refused', cause: 'sealed' });
    expect(recordsFor(sql, actor, { identity: CHEAPER, floor: FLOOR })).toHaveLength(1);
  });

});
