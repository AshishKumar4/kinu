// Roster and parked-decision planes ride typed source callbacks into the one shared assembler; a backend
// splice after `collectDynamicContext` would drop planes for actors that do not re-splice.
import { describe, expect, test } from 'bun:test';
import { DeferredApprovalStore, formatApproval } from '@kinu.run/core';
import { orchestratorHarness, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';

describe('the orchestrator dynamic context reads its own planes', () => {
  function harness(): ActorHarness<HarnessOrchestratorAgent> {
    return orchestratorHarness();
  }

  test('a hired subordinate renders as a delegate ahead of any search roster', () => {
    const agent = harness().agent;
    agent.harnessRoster().create({ name: 'scout', actorReference: null, birth: null, deleteRequested: false, createdBy: 'orchestrator', status: 'working', currentTask: 'map the failure surface', createdAt: Date.now(), dismissedAt: null, lifetime: 'durable', taskEventId: null });

    const delegates = agent.observeDynamicContext().delegates;
    expect(delegates?.items).toContainEqual({
      kind: 'subordinate',
      name: 'scout',
      phase: 'working',
      task: 'map the failure surface',
    });
  });

  test('a deferred shell approval is parked on the user in the block', () => {
    const agent = harness().agent;
    const rt = agent.observeRuntime();

    const parked = new DeferredApprovalStore(rt.storage.sql, rt.actor).create({
      id: `defer-${crypto.randomUUID()}`,
      command: 'bun run deploy',
      executor: 'workspace',
      reason: formatApproval({ decision: 'gate', hits: [] }),
      requestedAt: Date.now(),
    });

    expect(parked.status).toBe('queued');

    const approvals = agent.observeDynamicContext().approvals;
    expect(approvals?.total).toBe(1);
    expect(approvals?.items[0]?.detail).toContain('bun run deploy');
  });

  test('a raised device consent waits on the user in the block', async () => {
    const agent = harness().agent;

    // Settle the caller's promise afterward so this fixture leaves no work detached.
    const consent = agent.awaitDeviceConsent({
      deviceId: 'dev-1',
      deviceLabel: 'device',
      method: 'shell',
      command: 'git push origin main',
    });

    const approvals = agent.observeDynamicContext().approvals;
    expect(approvals?.items.some((approval) => approval.kind === 'device consent'
      && approval.detail.includes('git push origin main'))).toBe(true);

    const [pendingConsent] = await agent.listPendingConsents();

    if (!pendingConsent) throw new Error('expected a pending device consent');
    expect(await agent.resolveDeviceConsent(pendingConsent.consentId, 'deny')).toEqual({ ok: true });
    await expect(consent).resolves.toBe('deny');
  });
});
