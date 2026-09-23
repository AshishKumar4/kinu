/**
 * Refinement of `Exploration/Concurrent.lean — runC` by the deployed records store: each case in
 * `lean/fixtures/records.json` interleaves the steps of one to three runs over one cell, each run
 * holding its own `PublicationState` as a swarm run does, and the deployed `recordExploration`
 * must give every write the model's verdict and leave the model's rows. One run is
 * `RecordsStore.lean`'s single-run store. `bash scripts/verify-lean.sh` regenerates the fixture.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as v from 'valibot';
import { createTestActors } from '@kinu.run/test-utils';
import { makeExecRaw, makeSql } from './helpers';
import { initExplorationRecordsTable, recordExploration } from '../src/strategy/records';
import type {
  Floor, FloorBreach, FloorRederivation, ObjectiveIdentity, PublicationState,
} from '../src/strategy/objective';

const FIXTURE = resolve(import.meta.dir, '../../../lean/fixtures/records.json');

const FixtureSchema = v.object({
  fixture: v.literal('records'),
  cases: v.array(v.object({
    direction: v.picklist(['minimise', 'maximise']),
    runs: v.number(),
    steps: v.array(v.variant('action', [
      v.object({
        run: v.number(), action: v.literal('write'), artifact: v.string(), value: v.number(),
        verdict: v.picklist(['recorded', 'sealed', 'not-better']),
      }),
      v.object({ run: v.number(), action: v.literal('breach') }),
      v.object({ run: v.number(), action: v.literal('clear') }),
    ])),
    rows: v.array(v.object({ artifact: v.string(), value: v.number() })),
  })),
});

const { cases } = v.parse(FixtureSchema, JSON.parse(readFileSync(FIXTURE, 'utf8')));

/** `RecordsStore.lean`'s `sampleFloor`, `sampleBreach` and `sampleRederivation`. */
const FLOOR: Floor = { value: 10, proof: 'fixture bound', kind: 'certificate', bestKnownHonest: 12 };

const BREACH: FloorBreach = {
  floor: FLOOR,
  measured: { kind: 'measured', value: 3, detail: 'fixture measurement' },
  margin: (FLOOR.bestKnownHonest - FLOOR.value) / FLOOR.bestKnownHonest,
  hypotheses: ['floor_wrong', 'verifier_gameable'],
};

const REDERIVATION: FloorRederivation = { floor: { ...FLOOR, value: 2 }, adjudication: 'the floor was wrong', at: 0 };

describe('recordExploration refines Concurrent.runC', () => {
  test('the fixture interleaves several runs and reaches every verdict', () => {
    expect(cases.some((c) => c.runs > 1)).toBe(true);
    expect(new Set(cases.flatMap((c) => c.steps.flatMap((s) => (s.action === 'write' ? [s.verdict] : [])))))
      .toEqual(new Set(['recorded', 'sealed', 'not-better']));
  });

  test.each(cases.map((c, i) => [i, c] as const))('case %d', (_i, c) => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    const execRaw = makeExecRaw(db);
    const actor = createTestActors(sql, execRaw).main;
    initExplorationRecordsTable(execRaw);

    const identity: ObjectiveIdentity = {
      metric: 'ops', unit: 'ops', direction: c.direction, scale: 'linear', verifierDigest: 'fixture',
    };

    const seals: PublicationState[] = Array.from({ length: c.runs }, () => ({ kind: 'open' }));

    for (const [at, step] of c.steps.entries()) {
      const seal = seals[step.run];

      if (seal === undefined) throw new Error(`the fixture names run ${step.run} of ${c.runs}`);

      if (step.action === 'breach') {
        seals[step.run] = { kind: 'sealed', breach: BREACH, clearedBy: null };
        continue;
      }

      if (step.action === 'clear') {
        if (seal.kind === 'sealed') seals[step.run] = { ...seal, clearedBy: REDERIVATION };
        continue;
      }

      const verdict = recordExploration(sql, actor, {
        publication: seal,
        write: {
          identity, descriptor: null, artifact: step.artifact, value: step.value, detail: 'fixture',
          measured: null, preset: 'fixture', label: null, rootId: `run-${step.run}`,
          configDigest: 'fixture', depth: 1, branches: 1, floor: FLOOR, costUsd: null, costTokens: null, at,
        },
      });

      expect(verdict.kind === 'recorded' ? 'recorded' : verdict.cause).toBe(step.verdict);
    }

    const rows = sql<{ artifact: string; value: number }>`
      SELECT artifact, value FROM exploration_records WHERE actor_id = ${actor.actorId} ORDER BY artifact`;

    expect(rows).toEqual([...c.rows].sort((a, b) => a.artifact.localeCompare(b.artifact)));
  });
});
