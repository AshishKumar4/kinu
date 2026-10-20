/**
 * 1008-aa, 2026-10-08: chat-builder's turn ended in error once a storage reset cut the stream relaying its answer to its
 * room ("relaying the answer stream to the connected clients: ReadableStream received over RPC disconnected
 * prematurely"), though that stream only feeds the tabs and the turn keeps its own record. Here a hired agent's live
 * relay is cut at its shell call, which then runs on in its window (relay-cut-agent.ts): the turn goes on to its answer,
 * once, and the command it started runs once.
 */
import { env } from 'cloudflare:test';
import { getAgentByName } from 'agents';
import { expect, it } from 'vitest';
import { HOSTED_ACTOR_ID_HEADER, hostedActorSocketPath, ORCHESTRATOR_AGENT_SLUG } from '@kinu.run/core';
import { JOB_STARTED } from './hire-shapes';
import { actorWindow } from '../helpers/actor-window';

/** Its agents' facets lose their live relays at a shell call: the name starts `relay-cut-`. */
const WORKSPACE = 'relay-cut-hire';

const probe = () => env.HIRE_PROBE.get(env.HIRE_PROBE.idFromName(WORKSPACE));

it('a hired agent whose live relay is cut as its shell call runs answers once, and its command runs once', async () => {
  await probe().setup(WORKSPACE, 'hire-root', 'job');
  await probe().watchRelays(WORKSPACE);
  await probe().openHire(WORKSPACE, 'Hire an auditor to run the job.');
  // The auditor's shell call is in its window, and the room has lost the relay of the step that made it.
  await probe().jobWindowArmed(WORKSPACE, 1);
  const lost = await probe().relayLost(WORKSPACE);
  const hire = (await probe().observe(WORKSPACE)).actors.find((actor) => actor.hired);

  if (hire === undefined) throw new Error('the auditor was not hired');
  const workspace = await getAgentByName(env.HIRE_WORKSPACE, WORKSPACE);

  const upgraded = await workspace.fetch(new Request(
    `http://localhost/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(WORKSPACE)}/${hostedActorSocketPath(hire.name)}`,
    { headers: { Upgrade: 'websocket', [HOSTED_ACTOR_ID_HEADER]: hire.actorId } },
  ));

  const pane = await actorWindow(upgraded);

  await probe().outrunJobWindow(WORKSPACE);
  await pane.turnEnded(1);

  await probe().settled(WORKSPACE);
  const seen = await probe().observe(WORKSPACE);

  expect(lost).toBe('relaying the answer stream to the connected clients: ReadableStream received over RPC disconnected prematurely.');
  expect(await probe().runStatuses(WORKSPACE, hire.name)).toEqual(['completed']);
  expect(seen.transcript.filter((line) => line.includes(JOB_STARTED))).toHaveLength(1);
  expect(seen.toolResults.filter((result) => result.includes('backgrounded'))).toHaveLength(1);
  expect(await probe().jobRows(WORKSPACE)).toEqual([expect.objectContaining({ actorId: hire.actorId, status: 'running' })]);
  pane.close();
});
