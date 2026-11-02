/** The Work tab's Now rows, read while the agent works: what each says of a turn that runs, or that a restart cut. */
import { expect, test } from 'bun:test';
import { driveUntil, gatewayWorkspace, GATEWAY_CATALOG, reactivateOrchestratorHarness, until } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding } from './helpers/platform-gateway';

/** A gateway whose first call of the owner's turn parks, and whose next answers once `resumed` is released. */
function heldGateway() {
  const parked = Promise.withResolvers<Response>();
  const resumed = Promise.withResolvers<Response>();
  const asked: string[] = [];

  const gateway = stubAiBinding((run) => {
    const prompt = JSON.stringify(requestOf(run).messages);

    asked.push(prompt);

    if (!prompt.includes('RUNNING_MARKER')) return chatCompletion(run, 'Done.');

    return asked.filter((each) => each.includes('RUNNING_MARKER')).length === 1 ? parked.promise : resumed.promise;
  });

  return { gateway, asked, resumed };
}

const turnRows = (rows: readonly { kind: string; label: string; phase: string; why: string | null }[]) =>
  rows.filter((row) => row.kind === 'turn').map(({ label, phase, why }) => ({ label, phase, why }));

test("an owner's turn reads as the work it is while it runs, and as resuming, not stuck, while a restart has cut it", async () => {
  const { gateway, asked } = heldGateway();
  const workspace = gatewayWorkspace(gateway);

  await workspace.agent.send('RUNNING_MARKER: tidy the parser.', crypto.randomUUID(), []);
  await until(() => asked.some((prompt) => prompt.includes('RUNNING_MARKER')), 'the turn never reached its model');

  expect(turnRows(await workspace.agent.inspectWork())).toEqual([{ label: 'working on a request', phase: 'running', why: null }]);

  // The owner, 2026-10-25: an active agent's Work tab read "build turn · blocked · no activation is running it" while the
  // workspace restarted under the turn (25 startups in an hour on production).
  const next = await reactivateOrchestratorHarness(workspace.db, undefined, {
    world: { aiGateway: gateway },
    beforeStart: (agent) => { agent.harnessInstallCatalog(GATEWAY_CATALOG); },
  });

  await next.started;

  expect(turnRows(await next.agent.inspectWork())).toEqual([
    { label: 'working on a request', phase: 'waiting', why: 'stopped by a restart; it picks up again on its own' },
  ]);

  // Its wake comes, and it picks the turn up again: running, on its second try.
  await driveUntil(next, 'the turn never resumed', () => asked.filter((prompt) => prompt.includes('RUNNING_MARKER')).length > 1);
  expect((await next.agent.inspectWork()).filter((row) => row.kind === 'turn').map(({ phase, attempt }) => ({ phase, attempt }))).toEqual([{ phase: 'running', attempt: 2 }]);
});
