#!/usr/bin/env bun
/**
 * The cost table measures exactly the rows the deploy plans.
 *
 * `deployPlan()` refuses a row with no figure, but it runs only when something plans a deploy: its own test
 * is in `deploy.test.ts`, a ci-tier row. On 2026-09-29 a lane widened the chat-scroll row's command (b631df84cd),
 * its commit went green, and the ci tier on integration/0965 d511bdfe56 was the first to read the table under the
 * new key. So the check runs at commit, where the lane that changes a row is the one asked to measure it.
 *
 * A row that reads the deployment is the exception: it can be measured only against a deployment of the build it
 * was written for, so it is not a fault here; with no figure the plan gives it the whole box, and the deploy's
 * report names the command that measures it (L18).
 */
import { assertMeasured, finding } from './gate-ratchet';
import { COST_TABLE, type CostTable, QUIET_LOAD, readCosts } from './gate-cost';
import { LADDER, deployOrder, readsDeployment } from './ladder';

/** What is wrong with `costs` against the rows the ladder declares, one line per fault. */
export function costTableFaults(costs: CostTable, gates = LADDER, planned = deployOrder()): string[] {
  const runs = new Set(gates.map((gate) => gate.run));

  return [
    ...Object.keys(costs.rows).filter((run) => !runs.has(run)).map((run) => `a figure for a row that is no longer a gate: ${run}`),
    ...planned
      .filter((gate) => !readsDeployment(gate))
      .flatMap((gate) => {
        const cost = costs.rows[gate.run];

        if (cost === undefined) return [`a row of the deploy plan with no measured cost: ${gate.run}`];

        return cost.exit === 0 ? [] : [`a figure taken from a run that exited ${String(cost.exit)}: ${gate.run}`];
      }),
  ];
}

if (import.meta.main) {
  const costs = readCosts();
  const faults = costTableFaults(costs);

  const measured = assertMeasured('cost-table', [
    ['LADDER rows', LADDER.length],
    ['measured rows', Object.keys(costs.rows).length],
  ]);

  for (const fault of faults) {
    console.error(finding({
      at: COST_TABLE,
      invariant: 'the cost table measures exactly the rows the deploy plans',
      found: fault,
      silently: 'the deploy plan refuses at deploy time, or the wave admits a row against a number nobody took',
      fix: 'bun scripts/gate-cost-measure.ts --only="<the row\'s command>" on a quiet box, and commit the table; '
        + 'it drops the figures of rows that are no longer gates',
    }));
  }

  const contended = Object.values(costs.rows).filter((cost) => cost.loadAtStart >= QUIET_LOAD).length;

  console.log(`cost-table: ${faults.length === 0 ? 'ok' : `${String(faults.length)} finding(s)`} — ${measured}, `
    + `${String(contended)} figure(s) taken above load ${String(QUIET_LOAD)}`);
  console.log('  blind: whether a figure still describes its row: a command that keeps its text and changes its work keeps its old figure');
  process.exit(faults.length === 0 ? 0 : 1);
}
