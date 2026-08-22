import { describe, expect, test } from 'bun:test';

import { PRESET_SEARCHES } from '../src/lib/hero-searches';
import { SWARM_ROWS } from '../src/lib/swarm-story';

describe('the landing hero data', () => {
  test('optimise is the recorded repository search, including its winner chain', () => {
    const search = PRESET_SEARCHES.optimise;
    expect(search.vertices.map((vertex) => vertex.id)).toEqual(SWARM_ROWS.map((row) => row.id));

    for (const row of SWARM_ROWS) {
      const vertex = search.vertices.find((candidate) => candidate.id === row.id);
      if (vertex === undefined) throw new Error(`missing recorded node ${row.id}`);
      const measured = /p95 = (\d+)ms/.exec(row.observation ?? '');
      if (measured === null) throw new Error(`recorded node ${row.id} has no p95`);
      expect(vertex.scoreText).toBe(`${measured[1]}ms`);
    }

    const winner = SWARM_ROWS.find((row) => row.status === 'terminal');
    const root = SWARM_ROWS.find((row) => row.parent_id === null);
    if (winner === undefined) throw new Error('the recorded search has no terminal winner');
    if (root === undefined) throw new Error('the recorded search has no root');
    expect(search.winnerId).toBe(winner.id);
    expect(search.winPathIds).toContain(root.id);
    expect(search.winPathIds).toContain(winner.id);
  });

  test('unrecorded preset shapes disclose that they are fixtures', () => {
    expect(PRESET_SEARCHES.research.objective).toContain('design fixture');
    expect(PRESET_SEARCHES.ideate.objective).toContain('design fixture');
  });
});
