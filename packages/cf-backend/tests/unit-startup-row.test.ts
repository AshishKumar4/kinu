/** The `startups` panel counts rows, so one activation must be one `actor.startup` row. */
import { expect, test } from 'bun:test';
import { AGENT_METRICS_SCHEMA, analyticsDigest } from '@kinu.run/core/analytics';
import { fleetEnvForTest } from './helpers/analytics-plane';
import { makeEnv, orchestratorHarness } from './helpers/actor-harness';

const slot = (name: string): number => AGENT_METRICS_SCHEMA.blobs.findIndex((b) => b.name === name);

test('each activation writes exactly one actor.startup row, under the workspace digest', async () => {
  // The harness activates the actor once as it builds it.
  const { agent, started } = orchestratorHarness(undefined, undefined, fleetEnvForTest(makeEnv()));
  await started;
  const startups = () => agent.harnessFleetTurnRows().filter((row) => row.blobs?.[slot('event')] === 'actor.startup');

  expect(startups()).toHaveLength(1);
  expect(startups()[0]?.indexes?.[0]).toBe(analyticsDigest(agent.name));
  expect(startups()[0]?.blobs?.[slot('kind')]).toBe('event');

  await agent.activateActor();

  expect(startups()).toHaveLength(2);
});
