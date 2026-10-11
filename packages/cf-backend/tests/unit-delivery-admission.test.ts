/**
 * The one way input reaches an agent (design v2 §1, v3 A): its producer commits a delivery with its own fact and the
 * agent's wake, then the delivery crosses once into the agent's own store, and the agent's answer retires it. A death on
 * either side of the crossing loses nothing and runs nothing twice: the agent's wake crosses an unpaid delivery again,
 * and the agent answers a repeat `duplicate`.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { catalogTurn, driveUntil, gatewayWorkspace, workspaceMainActor, type StartedHarness } from './helpers/actor-harness';
import { cutNextDelivery } from './helpers/agent-facets';
import { chatCompletion, requestOf, stubAiBinding } from './helpers/platform-gateway';

const TASK = 'Tally the refunds.';

/** A model that answers every call, counting the calls that carry `TASK`. */
function counting() {
  const asked: string[] = [];

  const gateway = stubAiBinding((run) => {
    asked.push(JSON.stringify(requestOf(run).messages));

    return chatCompletion(run, 'Noted.');
  });

  return { gateway, tasked: () => asked.filter((messages) => messages.includes(TASK)).length };
}

function owedDeliveries(workspace: StartedHarness): number {
  return v.parse(v.object({ n: v.number() }), workspace.db.query('SELECT COUNT(*) AS n FROM agent_deliveries').get()).n;
}

/** Each cut, with what the agent's wake finds: owed, it is crossed and taken; taken, the repeat is answered `duplicate`. */
const CUTS = [
  { at: 'before-admit', title: "a delivery whose crossing died before the agent took it is taken at the agent's wake, once" },
  { at: 'after-admit', title: 'a delivery the agent took, whose answer was lost, is answered `duplicate` at the wake and runs once' },
] as const;

for (const { at, title } of CUTS) {
  test(title, async () => {
    const { gateway, tasked } = counting();
    const workspace = gatewayWorkspace(gateway);

    await catalogTurn(workspace.agent, 'Start the ledger.');
    cutNextDelivery(workspace.agent.agentOf(workspaceMainActor(workspace.db).actorId).storageKey, at);

    // Committed with its producer's fact: the producer is done, and the delivery owed.
    expect(await workspace.agent.runTaskFromMcp(TASK)).toEqual({ status: 'queued' });
    expect(owedDeliveries(workspace)).toBe(1);

    await driveUntil(workspace, `the delivery cut ${at} was never retired`, () => tasked() > 0 && owedDeliveries(workspace) === 0);
    expect(tasked()).toBe(1);
  });
}
