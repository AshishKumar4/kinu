/**
 * Refinement of `MCTS/Convergence.lean — outcomeOf` and `Backpropagation.lean — sum_invariant` by
 * the deployed search: each tree in `lean/fixtures/convergence.json` is built the way `runMCTS`
 * builds one, every candidate recorded then backpropagated in order through the deployed
 * `backpropagate`. Every row must hold the model's visit count and mean, and the deployed
 * `converge` must answer what the model answers, naming one of the model's winners. Plan mode, so
 * no judge or executor runs. `bash scripts/verify-lean.sh` regenerates the fixture from the model.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as v from 'valibot';
import { createMockSession, createTestRuntime } from './helpers';
import { backpropagate } from '../src/mcts/backpropagation';
import { converge } from '../src/mcts/convergence';
import { initSearchTables } from '../src/mcts/schemas';

const FIXTURE = resolve(import.meta.dir, '../../../lean/fixtures/convergence.json');

const StatusSchema = v.picklist(['open', 'terminal', 'pruned', 'failed']);

const FixtureSchema = v.object({
  fixture: v.literal('convergence'),
  rewardScale: v.number(),
  cases: v.array(v.object({
    rootStatus: StatusSchema,
    minAcceptable: v.tuple([v.number(), v.number()]),
    candidates: v.array(v.object({
      id: v.string(),
      path: v.array(v.string()),
      reward: v.number(),
      status: StatusSchema,
      text: v.string(),
    })),
    stats: v.array(v.object({ id: v.string(), sum: v.number(), visits: v.number() })),
    winners: v.array(v.string()),
    outcome: v.picklist(['converged', 'undifferentiated', 'no_acceptable_candidate', 'no_viable_nodes']),
  })),
});

const { rewardScale, cases } = v.parse(FixtureSchema, JSON.parse(readFileSync(FIXTURE, 'utf8')));

const ROOT = 'R';

describe('converge refines Convergence.outcomeOf', () => {
  test('the fixture reaches every outcome', () => {
    expect(new Set(cases.map((c) => c.outcome))).toEqual(
      new Set(['converged', 'undifferentiated', 'no_acceptable_candidate', 'no_viable_nodes']));
  });

  test.each(cases.map((c, i) => [i, c] as const))('case %d', async (_i, c) => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw);
    const { sql } = rt.storage;
    const actorId = rt.actor.actorId;

    // `runMCTS` records the root with the task as its observation; the model's root carries `task`.
    void sql`INSERT INTO search_nodes (actor_id, id, parent_id, root_id, task, observation, depth)
      VALUES (${actorId}, ${ROOT}, NULL, ${ROOT}, 'task', 'task', 0)`;

    for (const candidate of c.candidates) {
      void sql`INSERT INTO search_nodes (actor_id, id, parent_id, root_id, task, observation, depth)
        VALUES (${actorId}, ${candidate.id}, ${candidate.path.at(-1) ?? null}, ${ROOT}, 'task',
          ${candidate.text}, ${candidate.path.length})`;
      backpropagate(sql, rt.actor, candidate.id, candidate.reward / rewardScale);
    }

    // `Backpropagation.lean — sum_invariant`: visits count the rewards through a row and
    // value · visits is their sum, up to the doubles' rounding.
    for (const stat of c.stats) {
      const row = sql<{ value: number; visits: number }>`
        SELECT value, visits FROM search_nodes WHERE actor_id = ${actorId} AND id = ${stat.id}`[0];

      expect(row?.visits).toBe(stat.visits);
      expect(row?.value ?? Number.NaN).toBeCloseTo(stat.visits === 0 ? 0 : stat.sum / rewardScale / stat.visits, 12);
    }

    void sql`UPDATE search_nodes SET status = ${c.rootStatus} WHERE actor_id = ${actorId} AND id = ${ROOT}`;

    for (const candidate of c.candidates) {
      void sql`UPDATE search_nodes SET status = ${candidate.status}
        WHERE actor_id = ${actorId} AND id = ${candidate.id}`;
    }

    const [minNum, minDen] = c.minAcceptable;
    const answer = converge(rt, createMockSession(), ROOT, { mode: 'plan', minAcceptable: minNum / minDen });

    if (c.outcome === 'no_viable_nodes') {
      await expect(answer).rejects.toThrow('No viable nodes');

      return;
    }

    const result = await answer;
    expect(c.winners).toContain(result.winnerId);
    expect(result.converged).toBe(c.outcome === 'converged');
    expect(result.reason).toBe(c.outcome === 'converged' ? undefined : c.outcome);
  });
});
