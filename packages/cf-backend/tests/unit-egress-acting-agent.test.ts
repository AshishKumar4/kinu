// A workspace process leaves through Kinu's egress minted for the agent that started it (Nimbus's egressFor, ask 45),
// so what the egress records, its GitHub facts, names that agent.
import { expect, test } from 'bun:test';
import { present } from '@kinu.run/test-utils';
import { EGRESS_FETCHES } from './helpers/programmatic-host';
import { hostedMainActor, hostedSubordinateHarness, orchestratorHarness } from './helpers/actor-harness';

test('a request a hired agent\'s command makes leaves through an egress naming that agent, and main\'s names main', async () => {
  const workspace = orchestratorHarness(undefined, { ownerUserId: '0123456789abcdef0123456789abcdef' });
  await workspace.started;
  const main = await hostedMainActor(workspace);
  const child = await hostedSubordinateHarness(workspace, { name: 'scout', displayName: 'Scout', nameOrigin: 'user', mission: 'fetch a page' });
  const before = EGRESS_FETCHES.length;

  // A private address: the egress refuses it without the network, after it has served the request.
  await present(main.actor.runtime.shell, 'main\'s shell').exec('curl -s http://10.0.0.1/main');
  await present(child.actor.runtime.shell, 'the hired agent\'s shell').exec('curl -s http://10.0.0.1/child');

  expect(EGRESS_FETCHES.slice(before)).toEqual([
    { url: 'http://10.0.0.1/main', principal: 'owner', actorId: main.actor.handle.actorId },
    { url: 'http://10.0.0.1/child', principal: 'owner', actorId: child.actor.handle.actorId },
  ]);
});
