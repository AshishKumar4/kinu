/**
 * Refinement of `MCTS/Uct.lean — select_is_maximal`: on every table in `lean/fixtures/uct-select.json`
 * the deployed `selectNode` returns a row the model's argmax admits, or null when it selects nothing.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as v from 'valibot';
import { createTestActors } from '@kinu.run/test-utils';
import { makeExecRaw, makeSql } from './helpers';
import { initSearchTables } from '../src/mcts/schemas';
import { selectNode } from '../src/mcts/uct';
import type { ActorHandle } from '../src/identity/actor-handle';
import type { SqlExecutor } from '../src/types/primitives';

const FIXTURE = resolve(import.meta.dir, '../../../lean/fixtures/uct-select.json');

const RowSchema = v.object({
  id: v.string(),
  parent: v.nullable(v.string()),
  root: v.string(),
  status: v.picklist(['open', 'terminal', 'pruned', 'failed']),
  depth: v.number(),
  visits: v.number(),
  sixtyFourths: v.number(),
});

const FixtureSchema = v.object({
  fixture: v.literal('uct-select'),
  cases: v.array(v.object({
    weight: v.union([v.literal('sqrt2'), v.object({ quarters: v.number() })]),
    rootId: v.string(),
    maxDepth: v.number(),
    rows: v.array(RowSchema),
    decoys: v.array(RowSchema),
    selectable: v.array(v.string()),
  })),
});

const { cases } = v.parse(FixtureSchema, JSON.parse(readFileSync(FIXTURE, 'utf8')));

function insert(sql: SqlExecutor, actor: ActorHandle, row: v.InferOutput<typeof RowSchema>): void {
  void sql`INSERT INTO search_nodes (actor_id, id, parent_id, root_id, task, visits, value, depth, status)
    VALUES (${actor.actorId}, ${row.id}, ${row.parent}, ${row.root}, 'fixture', ${row.visits},
      ${row.sixtyFourths / 64}, ${row.depth}, ${row.status})`;
}

describe('selectNode refines Uct.select', () => {
  test('the fixture exercises a tie, an empty selection and a foreign actor', () => {
    expect(cases.some((c) => c.selectable.length > 1)).toBe(true);
    expect(cases.some((c) => c.selectable.length === 0)).toBe(true);
    expect(cases.some((c) => c.decoys.length > 0)).toBe(true);
  });

  test.each(cases.map((c, i) => [i, c] as const))('case %d', (_i, c) => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    const execRaw = makeExecRaw(db);
    initSearchTables(execRaw);
    const actors = createTestActors(sql, execRaw);
    const other = actors.sibling('decoy');

    for (const row of c.rows) insert(sql, actors.main, row);

    for (const row of c.decoys) insert(sql, other, row);

    const explorationWeight = c.weight === 'sqrt2' ? Math.SQRT2 : c.weight.quarters / 4;
    const selected = selectNode(sql, actors.main, c.rootId, { explorationWeight, maxDepth: c.maxDepth });

    if (c.selectable.length === 0) {
      expect(selected).toBeNull();
    } else {
      expect(c.selectable).toContain(selected?.id ?? '');
    }
  });
});
