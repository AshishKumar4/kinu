/**
 * `getWorkspaceOverview` over real stores: the read never `acquire`s an actor,
 * and unfinished work with nothing running reads 'unfinished', not 'working'.
 */
import { describe, expect, test } from 'bun:test';
import { RunEventRecorder, WORKSPACE_RUN_ID, DeferredApprovalStore, formatApproval } from '@kinu.run/core';
import { orchestratorHarness, hostedSubordinateHarness } from './helpers/actor-harness';
import { mockAgentsSdk } from './helpers/agents-sdk';

mockAgentsSdk();

describe('getWorkspaceOverview', () => {
  test('a quiet workspace reads as no decisions, idle, no run — and acquires nobody', async () => {
    const { agent } = orchestratorHarness();
    const host = agent.observeActorHost();

    let acquired = 0;

    const realAcquire = host.acquire.bind(host);

    host.acquire = async (reference) => {
      acquired += 1;

      return realAcquire(reference);
    };

    const overview = await agent.getWorkspaceOverview();

    expect(acquired).toBe(0);
    expect(overview.decisionsWaiting).toBe(0);
    expect(overview.hasUpdates).toBe(false);
    expect(overview.activity).toBe('idle');
    expect(overview.latestRun).toBeNull();
    expect(overview.observedAt).toBeGreaterThan(0);
  });

  test('a pending consent and a parked command both wait on the owner', async () => {
    const { agent } = orchestratorHarness();
    const rt = agent.observeRuntime();

    const consent = agent.awaitDeviceConsent({
      deviceId: 'dev-1', deviceLabel: 'device', method: 'shell', command: 'git push',
    });

    const parked = new DeferredApprovalStore(rt.storage.sql, rt.actor).create({
      id: `defer-${crypto.randomUUID()}`,
      command: 'bun run deploy',
      executor: 'workspace',
      reason: formatApproval({ decision: 'gate', hits: [] }),
      requestedAt: Date.now(),
    });

    expect(parked.status).toBe('queued');
    const overview = await agent.getWorkspaceOverview();

    expect(overview.decisionsWaiting).toBe(2);
    expect(overview.hasUpdates).toBe(false);

    const [pending] = await agent.listPendingConsents();

    if (!pending) throw new Error('expected a pending device consent');
    await agent.resolveDeviceConsent(pending.consentId, 'deny');
    await expect(consent).resolves.toBe('deny');
  });

  test('a live turn on a hosted child reads working — without an acquire', async () => {
    const workspace = orchestratorHarness();
    const { agent } = workspace;

    const host = agent.observeActorHost();
    let acquired = 0;

    const realAcquire = host.acquire.bind(host);

    host.acquire = async (reference) => {
      acquired += 1;

      return realAcquire(reference);
    };

    const { actor } = await hostedSubordinateHarness(workspace, {
      name: 'scout', displayName: 'Scout', nameOrigin: 'user', mission: 'map the failure surface',
    });

    const acquisitionsAfterSetup = acquired;
    const lease = actor.session.beginTurn({ runId: 'child-run', turnId: 'child-turn' }, 'build', Date.now());

    try {
      const overview = await agent.getWorkspaceOverview();

      expect(acquired).toBe(acquisitionsAfterSetup);
      expect(overview.activity).toBe('working');
    } finally {
      actor.session.finishTurn(lease);
    }
  });

  test('the newest sealed run is the card line; the reserved aggregate is skipped', async () => {
    const { agent } = orchestratorHarness();
    const recorder = new RunEventRecorder(agent.observeRuntime().storage.sql, agent.observeRuntime().actor);

    recorder.emit('run-older', { type: 'run_start', agentId: 'main', userMessage: 'first task' });
    recorder.emit('run-older', { type: 'run_end', reason: 'completed' });
    recorder.emit('run-newer', { type: 'run_start', agentId: 'main', userMessage: 'latest task' });
    recorder.emit('run-newer', { type: 'run_end', reason: 'error' });
    // The reserved between-run aggregate is not a run and must never lead the card.
    recorder.emit(WORKSPACE_RUN_ID, { type: 'model_call', source: 'agent' });

    const overview = await agent.getWorkspaceOverview();

    expect(overview.latestRun).toEqual({ status: 'error', task: 'latest task' });
  });

  test('a live turn beside a completed last run reads working, and the run line is the live run', async () => {
    const { agent } = orchestratorHarness();
    const recorder = new RunEventRecorder(agent.observeRuntime().storage.sql, agent.observeRuntime().actor);

    recorder.emit('run-1', { type: 'run_start', agentId: 'main', userMessage: 'done' });
    recorder.emit('run-1', { type: 'run_end', reason: 'completed' });
    // A live turn is an open, unsealed run in the ledger: no status yet.
    await agent.declareTurnInFlight(true);

    const overview = await agent.getWorkspaceOverview();

    expect(overview.activity).toBe('working');
    expect(overview.latestRun).toEqual({ status: null, task: 'a live turn' });

    await agent.declareTurnInFlight(false);
    expect((await agent.getWorkspaceOverview()).latestRun).toEqual({ status: 'completed', task: 'a live turn' });
  });
});
