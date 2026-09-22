// The record RPCs over a real orchestrator and workspace database. Defends: `exploration_records` missing
// on a never-searched workspace (`no such table` as an empty pane), and null handle digests lost in transit.
import { describe, expect, test } from 'bun:test';
import {
  recordExploration,
  type ExplorationWrite, type Floor, type ObjectiveIdentity, type PublicationState,
} from '@kinu.run/core';
import { sqlOver } from '@kinu.run/test-utils';
import { orchestratorHarness } from './helpers/actor-harness';

const OPEN: PublicationState = { kind: 'open' };

const CALLS: ObjectiveIdentity = {
  metric: 'oracle_calls',
  unit: 'oracle calls',
  direction: 'minimise',
  scale: 'log',
  verifierDigest: 'exec-ratio@abc123',
};

const PASS: ObjectiveIdentity = {
  metric: 'pass_rate',
  unit: 'fraction of held-out tasks',
  direction: 'maximise',
  scale: 'linear',
  verifierDigest: 'suite@f00d',
};

const FLOOR: Floor = {
  value: 0.4,
  kind: 'certificate',
  bestKnownHonest: 0.62,
  proof: 'The held-out suite admits no solution below the reference implementation.',
};

const T0 = 1_700_000_000_000;


function write(over: Partial<ExplorationWrite>): ExplorationWrite {
  return {
    identity: CALLS,
    descriptor: null,
    artifact: 'export function solve() { return 1; }',
    value: 23,
    detail: '23 oracle calls',
    measured: null,
    preset: 'optimise',
    label: null,
    rootId: 'root-1',
    configDigest: 'cfg-1',
    depth: 5,
    branches: 3,
    floor: null,
    costUsd: null,
    costTokens: null,
    at: T0,
    ...over,
  };
}

/** One unfloored, unpartitioned set; one floored set over three cells, five occupants in one. */
function seededWorkspace() {
  const harness = orchestratorHarness();
  // The harness's own database: a second connection would seed another store.
  const sql = sqlOver(harness.db);
  // `listRecordObjectives` answers as this actor; rows under any other read back as an empty page.
  const actor = harness.agent.observeRuntime().actor;

  for (const [index, value] of [41, 23, 88].entries()) {
    recordExploration(sql, actor, {
      publication: OPEN,
      write: write({ artifact: `calls-${String(index)}`, value, at: T0 + index }),
    });
  }

  const partitioned: ReadonlyArray<readonly [string, number, number]> = [
    ['len=short', 0.71, 10], ['len=short', 0.5, 11], ['len=short', 0.5, 11],
    ['len=short', 0.5, 12], ['len=short', 0.44, 13],
    ['len=medium', 0.66, 14], ['len=long', 0.6, 15], ['len=long', 0.58, 16],
  ];

  for (const [index, [descriptor, value, offset]] of partitioned.entries()) {
    recordExploration(sql, actor, {
      publication: OPEN,
      write: write({
        identity: PASS, floor: FLOOR, descriptor, value, at: T0 + offset,
        artifact: `pass artifact ${String(index)} unique tokens ${String(index)}`,
      }),
    });
  }

  return harness;
}

describe('the record RPCs answer over a real workspace', () => {
  test('a workspace that has never searched answers with an empty page, not a throw', async () => {
    // Red if `initExplorationRecordsTable` leaves `initWorkspaceSchema`.
    const harness = orchestratorHarness();
    expect(harness.tableNames()).toContain('exploration_records');
    expect(await harness.agent.listRecordObjectives()).toEqual({ status: 'end', items: [] });
  });

  test('listRecordObjectives reports both sets with the unit and direction they measured', async () => {
    const harness = seededWorkspace();
    const page = await harness.agent.listRecordObjectives();
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.map((item) => [item.metric, item.unit, item.direction, item.scale, item.cells, item.rows]))
      .toEqual([
        ['pass_rate', 'fraction of held-out tasks', 'maximise', 'linear', 3, 8],
        ['oracle_calls', 'oracle calls', 'minimise', 'log', 1, 3],
      ]);
    expect(page.items.map((item) => item.best?.value)).toEqual([0.71, 23]);
  });

  test('listRecordCells takes the handle back opaquely, NULL floor digest included', async () => {
    const harness = seededWorkspace();
    const objectives = await harness.agent.listRecordObjectives();
    const calls = objectives.items.find((item) => item.metric === 'oracle_calls');
    expect(calls?.floorDigest).toBeNull();

    if (!calls) throw new Error('the fixture must hold the unfloored set');

    const cells = await harness.agent.listRecordCells({
      objectiveId: calls.objectiveId, floorDigest: calls.floorDigest,
    });

    expect(cells.items.length).toBeGreaterThan(0);
    expect(cells.items.map((cell) => [cell.descriptor, cell.occupants, cell.elite?.value]))
      .toEqual([[null, 3, 23]]);
  });

  test('readRecordCell pages a cell, and the walk neither drops nor repeats an occupant', async () => {
    // The handle comes from the list, never rebuilt: a surface passes back the opaque pair.
    const harness = seededWorkspace();
    const objectives = await harness.agent.listRecordObjectives();
    const pass = objectives.items.find((item) => item.metric === 'pass_rate');

    if (!pass) throw new Error('the fixture must hold the partitioned set');
    const handle = { objectiveId: pass.objectiveId, floorDigest: pass.floorDigest, descriptor: 'len=short' };

    const whole = await harness.agent.readRecordCell({ ...handle, limit: 100 });
    expect(whole.items).toHaveLength(5);
    // Three occupants tie at 0.5, so pages of two put a boundary inside the tie.
    expect(whole.items.filter((row) => row.value === 0.5).length).toBeGreaterThan(1);

    const digests: string[] = [];
    let cursor: { after: string } | undefined;

    for (let step = 0; step < 10; step += 1) {
      const page = await harness.agent.readRecordCell({ ...handle, cursor, limit: 2 });
      digests.push(...page.items.map((row) => row.artifactDigest));

      if (page.status === 'end') break;
      cursor = page.next;
    }

    expect(digests).toEqual(whole.items.map((row) => row.artifactDigest));
    expect(new Set(digests).size).toBe(whole.items.length);
  });

  test('the no-partition cell is readable through the RPC, which `descriptor = NULL` is not', async () => {
    const harness = seededWorkspace();
    const objectives = await harness.agent.listRecordObjectives();
    const calls = objectives.items.find((item) => item.metric === 'oracle_calls');

    if (!calls) throw new Error('the fixture must hold the unfloored set');

    const page = await harness.agent.readRecordCell({
      objectiveId: calls.objectiveId, floorDigest: calls.floorDigest, descriptor: null,
    });

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.map((row) => row.value)).toEqual([23, 41, 88]);
  });
});
