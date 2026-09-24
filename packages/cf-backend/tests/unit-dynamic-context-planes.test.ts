// Roster and parked-decision planes ride typed source callbacks into the one shared assembler; a backend
// splice after `collectDynamicContext` would drop planes for actors that do not re-splice. Observed where
// the model reads them: the request a turn prepares.
import { describe, expect, test } from 'bun:test';
import { DeferredApprovalStore, formatApproval, SubordinateRosterStore } from '@kinu.run/core';
import { sqlOver } from '@kinu.run/test-utils';
import { makeSqlExec } from '../../core/tests/helpers';
import {
  chatSessionTurns, orchestratorHarness, workspaceMainActor, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';

/** Everything the model reads for one turn: the prepared system prompt and prompt messages. */
async function modelContext(agent: HarnessOrchestratorAgent): Promise<string> {
  const prepared = await chatSessionTurns(agent).prepare({
    messages: [{ role: 'user', content: 'What is waiting on me?' }],
  });

  return [prepared.system ?? '', ...prepared.prompt.map((message) => JSON.stringify(message.content))].join('\n');
}

describe('the orchestrator dynamic context reads its own planes', () => {
  test('a hired subordinate renders as a delegate in the block', async () => {
    const { agent, db } = orchestratorHarness();
    new SubordinateRosterStore(makeSqlExec(db), workspaceMainActor(db)).create({
      name: 'scout', actorReference: null, birth: null, deleteRequested: false, createdBy: 'orchestrator',
      status: 'working', currentTask: 'map the failure surface', createdAt: Date.now(), dismissedAt: null,
      lifetime: 'durable', taskEventId: null,
    });

    const context = await modelContext(agent);
    expect(context).toContain('scout');
    expect(context).toContain('map the failure surface');
  });

  test('a deferred shell approval is parked on the user in the block', async () => {
    const { agent, db } = orchestratorHarness();

    const parked = new DeferredApprovalStore(sqlOver(db), workspaceMainActor(db)).create({
      id: `defer-${crypto.randomUUID()}`,
      command: 'bun run deploy',
      executor: 'workspace',
      reason: formatApproval({ decision: 'gate', hits: [] }),
      requestedAt: Date.now(),
    });

    expect(parked.status).toBe('queued');

    expect(await modelContext(agent)).toContain('bun run deploy');
  });

  test('a raised device consent waits on the user in the block', async () => {
    const { agent } = orchestratorHarness();

    // Settle the caller's promise afterward so this fixture leaves no work detached.
    const consent = agent.awaitDeviceConsent({
      deviceId: 'dev-1',
      deviceLabel: 'device',
      method: 'shell',
      command: 'git push origin main',
    });

    expect(await modelContext(agent)).toContain('git push origin main');

    const [pendingConsent] = await agent.listPendingConsents();

    if (!pendingConsent) throw new Error('expected a pending device consent');
    expect(await agent.resolveDeviceConsent(pendingConsent.consentId, 'deny')).toEqual({ ok: true });
    await expect(consent).resolves.toBe('deny');
  });
});
