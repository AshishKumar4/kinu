/** The owner reads a turn's requests as the model received them, rebuilt from what the turn stored. */
import { describe, expect, test } from 'bun:test';
import { ActorClaimStore } from '@kinu.run/core';
import { makeSql } from '../../core/tests/helpers';
import {
  catalogTurn, gatewayWorkspace, historyOver, workspaceMainActor, type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import { answeringGateway, requestOf, scriptedGateway } from './helpers/platform-gateway';

function latestTurnId(harness: ActorHarness<HarnessOrchestratorAgent>): string {
  const store = new ActorClaimStore(makeSql(harness.db), workspaceMainActor(harness.db), (write) => write(), historyOver(harness));
  const turn = store.latestTurn();

  if (turn === null) throw new Error('no turn was claimed');

  return turn.turnId;
}

describe('a turn read back request by request', () => {
  test('each step reads as the list the provider received, paired with what came back', async () => {
    const gateway = scriptedGateway([{ tool: 'file', args: { action: 'write', path: '/workspace/notes.txt', content: 'hello' } }], 'All written.');
    const harness = gatewayWorkspace(gateway);
    await catalogTurn(harness.agent, 'Write hello to notes.txt.');
    const turnId = latestTurnId(harness);

    const index = await harness.agent.getTurnRequests(turnId);
    expect(index.claim?.status).toBe('settled');
    const steps = index.requests.filter((row) => row.step !== null);
    expect(steps.map((row) => row.step)).toEqual([0, 1]);
    expect(index.requests.filter((row) => row.step === null)).toHaveLength(1);

    const sent = gateway.runs.map(requestOf).map((request) => request.messages.filter((message) => message.role !== 'system'));
    expect(sent).toHaveLength(2);

    for (const [at, row] of steps.entries()) {
      const page = await harness.agent.getTurnRequest(turnId, { epoch: row.epoch, revision: row.revision });

      // What the provider received, message for message.
      expect(page.messageCount).toBe(sent[at]?.length);
      expect(page.messages.map((message) => message['role'])).toEqual(sent[at]?.map((message) => message.role === 'tool' ? 'tool' : message.role));
      expect(page.nextFrom).toBeNull();
      expect(page.response?.stepIndex).toBe(at + 1);
    }

    const first = await harness.agent.getTurnRequest(turnId, { epoch: steps[0]?.epoch ?? 0, revision: steps[0]?.revision ?? 0 });
    expect(first.response?.reason).toBe('tool-calls');
    const last = await harness.agent.getTurnRequest(turnId, { epoch: steps[1]?.epoch ?? 0, revision: steps[1]?.revision ?? 0 });
    expect(last.response?.reason).toBe('stop');
  });

  test('a request larger than a page reads in pages that join to the whole list', async () => {
    const harness = gatewayWorkspace(answeringGateway('Noted.'));
    await catalogTurn(harness.agent, `first ${'a'.repeat(200 * 1024)}`);
    await catalogTurn(harness.agent, `second ${'b'.repeat(200 * 1024)}`);
    const turnId = latestTurnId(harness);
    // The admission: the conversation as admitted, both long messages whole (a step's request carries them clamped).
    const step = (await harness.agent.getTurnRequests(turnId)).requests.find((row) => row.step === null);

    if (step === undefined) throw new Error('the turn has no admission');
    const pages = [];
    let from: number | null = 0;

    while (from !== null) {
      const page = await harness.agent.getTurnRequest(turnId, { epoch: step.epoch, revision: step.revision, from });
      pages.push(page);
      from = page.nextFrom;
    }

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((page) => page.messages)).toHaveLength(pages[0]?.messageCount ?? -1);
  });

  test('a support read lands in the owner\'s activity log with its stated reason', async () => {
    const harness = gatewayWorkspace(answeringGateway('Noted.'));
    await catalogTurn(harness.agent, 'Hello.');
    const turnId = latestTurnId(harness);

    const read = await harness.agent.supportReadTurn({ turnId, reason: 'support_ticket' });

    expect('turnId' in read && read.turnId).toBe(turnId);
    const log = (await harness.agent.getActivitySnapshot({ logs: 20 })).log;
    expect(log.filter((entry) => entry.event === 'support.read').map((entry) => entry.detail))
      .toEqual([`support read turn ${turnId} (support_ticket)`]);
  });

  test('an actor this workspace never registered is refused', async () => {
    const harness = gatewayWorkspace(answeringGateway('Noted.'));
    await catalogTurn(harness.agent, 'Hello.');

    await expect(harness.agent.getTurnRequests(latestTurnId(harness), crypto.randomUUID())).rejects.toThrow(/not registered/);
  });
});
