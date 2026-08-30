// The dynamic-context planes only the orchestrator's own stores can answer —
// its subordinate roster and the two kinds of decision parked on the user —
// rendered through the ONE shared assembler, not a backend splice.
//
// Until this existed, the approvals plane was unreachable on anything but the
// orchestrator: the base class assembled through `collectDynamicContext` and
// then hand-spliced `delegates`/`approvals` over the result in an override.
// A plane added to the shared assembler therefore did not exist for an actor
// that did not re-splice it — the exact drift the shared assembler exists to
// close. This pins the cutover: the override is gone, the extras ride typed
// source callbacks, and the assembled block actually carries them.
import { describe, expect, test } from 'bun:test';
import { orchestratorHarness, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';

describe('the orchestrator dynamic context reads its own planes', () => {
  function harness(): ActorHarness<HarnessOrchestratorAgent> {
    return orchestratorHarness();
  }

  test('a hired subordinate renders as a delegate ahead of any search roster', () => {
    const agent = harness().agent;
    agent.harnessRoster().create({
      name: 'scout',
      createdBy: 'orchestrator',
      status: 'working',
      currentTask: 'map the failure surface',
      createdAt: Date.now(),
      dismissedAt: null,
      lifetime: 'durable',
      taskEventId: null,
    });

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
    const parked = agent.harnessParkShellApproval({
      command: 'bun run deploy',
      executor: 'workspace',
      review: { decision: 'gate', hits: [] },
    });
    expect(parked.outcome).toBe('queued');

    const approvals = agent.observeDynamicContext().approvals;
    expect(approvals?.total).toBe(1);
    expect(approvals?.items[0]?.detail).toContain('bun run deploy');
  });

  test('a raised device consent waits on the user in the block', async () => {
    const agent = harness().agent;
    // The prompt is observable before its owner answers. Settle the caller's
    // promise afterward so this fixture does not leave work detached.
    const consent = agent.harnessAwaitDeviceConsent({
      deviceId: 'dev-1',
      deviceLabel: 'laptop',
      method: 'shell',
      command: 'git push origin main',
      scope: 'full_filesystem',
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
