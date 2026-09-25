#!/usr/bin/env bun
/**
 * The proofs behind the test census lock. A locked tautology suspect is a relational check
 * (`f(a) !== f(b)`, `f(x) === f(x)`) kept because it is the honest form of a determinism or
 * sensitivity test; its entry names the plants that show it catches something. Each plant is a
 * defect in the code the test covers, and this program runs the test by its title three ways: as
 * the tree holds it (green), under each plant (red), and restored.
 *
 * A plant whose `from` text no longer occurs exactly once is stale and fails, so a refactor of the
 * planted code forces the proof to be re-made rather than silently skipped.
 *
 * Its ladder row is keyed by the lock, each planted file, and each planted test with the module
 * graph it runs (`plantedInputs`).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';

const root = new URL('..', import.meta.url).pathname;

const LOCK = 'scripts/test-census.lock.json';

const PlantSchema = v.object({
  defect: v.string(),
  file: v.string(),
  edits: v.pipe(v.array(v.tuple([v.string(), v.string()])), v.minLength(1)),
});

export type Plant = v.InferOutput<typeof PlantSchema>;

const CensusLockSchema = v.object({
  measured: v.string(),
  entries: v.array(v.object({ key: v.string(), count: v.number(), plants: v.optional(v.array(PlantSchema)) })),
});

export type CensusLock = v.InferOutput<typeof CensusLockSchema>;

export const parseLock = (lock: string): CensusLock => v.parse(CensusLockSchema, JSON.parse(lock));

/** The committed lock. */
export const readCensusLock = (): CensusLock => parseLock(readFileSync(join(root, LOCK), 'utf8'));

/** The test a lock key names: its file, and its title as `bun test -t` matches it. */
function keyedTest(key: string) {
  const [, file = '', title = ''] = key.split(' :: ');

  return { file, title };
}

/**
 * The roots one ladder row each proves: a planted suite under `scripts/` often reaches the corpus
 * (a gate test reads the tree it governs), which would key the `packages/` proofs to every change.
 */
export const PROOF_ROOTS = ['packages/', 'scripts/'] as const;

export type ProofRoot = (typeof PROOF_ROOTS)[number];

const plantedUnder = (lock: CensusLock, under: ProofRoot): CensusLock['entries'] =>
  lock.entries.filter((entry) => (entry.plants ?? []).length > 0 && keyedTest(entry.key).file.startsWith(under));

/** What one root's proofs run and read: each planted test, as a suite whose graph is walked, and
 *  the lock with each planted file, read by path. */
export function plantedInputs(lock: CensusLock, under: ProofRoot) {
  const entries = plantedUnder(lock, under);

  return {
    suites: [...new Set(entries.map((entry) => keyedTest(entry.key).file))].sort(),
    reads: [...new Set([LOCK, ...entries.flatMap((entry) => (entry.plants ?? []).map((plant) => plant.file))])].sort(),
  };
}

/** Whether the named test failed in one `bun test` run of its file. */
function failed(file: string, title: string): boolean {
  const run = Bun.spawnSync(['bun', 'test', '--timeout=0', file, '-t', title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')], { cwd: root });

  return `${run.stdout.toString()}${run.stderr.toString()}`.split('\n')
    .some((line) => line.startsWith('(fail)') && line.includes(title));
}

function prove(lock: CensusLock, under: ProofRoot): number {
  const unrooted = lock.entries.filter((entry) => (entry.plants ?? []).length > 0
    && !PROOF_ROOTS.some((proofRoot) => keyedTest(entry.key).file.startsWith(proofRoot)));

  for (const entry of unrooted) console.error(`census-plants: NO ROW   ${entry.key} lies under no proof root`);
  let failures = unrooted.length;

  for (const entry of plantedUnder(lock, under)) {
    const plants = entry.plants ?? [];
    const { file, title } = keyedTest(entry.key);

    // A test red without any plant would "prove" every plant.
    if (failed(file, title)) {
      console.error(`census-plants: RED UNPLANTED ${file} :: ${title}`);
      failures += 1;
      continue;
    }

    for (const plant of plants) {
      const path = join(root, plant.file);
      const original = readFileSync(path, 'utf8');

      if (plant.edits.some(([from]) => original.split(from).length !== 2)) {
        console.error(`census-plants: STALE    ${plant.defect}: ${plant.file} no longer holds its edit exactly once`);
        failures += 1;
        continue;
      }

      writeFileSync(path, plant.edits.reduce((text, [from, to]) => text.replace(from, () => to), original));
      let red: boolean;

      try {
        red = failed(file, title);
      } finally {
        writeFileSync(path, original);
      }

      console.log(`census-plants: ${red ? 'red     ' : 'GREEN   '} ${plant.defect} -> ${file} :: ${title}`);

      if (!red) failures += 1;
    }
  }

  if (failures === 0) {
    console.log(`census-plants: every locked suspect under ${under} is green as written and red under each of its plants`);
    console.log('  blind: a plant shows the test catches that defect, not every defect its title claims');
  }

  return failures === 0 ? 0 : 1;
}

if (import.meta.main) {
  const under = PROOF_ROOTS.find((proofRoot) => proofRoot === process.argv[2]);

  if (under === undefined) throw new Error(`usage: bun scripts/census-plants.ts ${PROOF_ROOTS.join('|')}`);
  process.exitCode = prove(readCensusLock(), under);
}
