/**
 * An agent's isolate is a Dynamic Worker, and an object may have ten of them each with a call awaiting an answer
 * (platform-catalog `worker_loader.do_dynamic_worker_concurrency`, measured on staging 2026-10-02). The harness counts
 * as the platform does, so a read that calls more isolates at once than that is refused here as it was on staging.
 */
import { beginLoaderFetch, loaderLedgerStats } from '@nimbus-sh/fabric/budgets.js';
import { describe, expect, test, vi } from 'bun:test';
import { catalogTurn, gatewayWorkspace, orchestratorHarness, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

const HELPERS = 12;

/** Agents the owner adds, as the browser adds them: each is listed and has an isolate of its own. */
async function hire(workspace: ActorHarness<HarnessOrchestratorAgent>, count: number): Promise<string[]> {
  const labels: string[] = [];

  await workspace.agent.setSoul('# Kinu\n\n## Mission\n\nCount the paths.\n');

  for (let index = 0; index < count; index += 1) labels.push((await workspace.agent.createSubordinateAgent()).displayName);

  return labels;
}

/** Main hires one helper, which answers one task in two priced steps. */
/** Each turn of the event loop is one RPC round trip of the platform's, a refusal included. */
async function roundTrips(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) await new Promise<void>((resolve) => { setImmediate(resolve); });
}

function hiringGateway() {
  return stubAiBinding((run) => {
    const request = requestOf(run);
    const step = request.messages.filter((message) => message.role === 'tool').length;

    if (!request.tools.includes('report')) {
      return step === 0
        ? toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'researcher', name: 'counter', mission: 'Count the paths.' } }, 'start')
        : chatCompletion(run, 'Handed off.');
    }

    return step === 0 ? toolCallCompletion(run, { tool: 'tasks', args: { op: 'list' } }, 'inspect') : chatCompletion(run, 'Counted.');
  });
}

describe('the roster', () => {
  test(`of ${String(HELPERS)} helpers is read with no call to any agent's isolate`, async () => {
    const workspace = orchestratorHarness();
    const labels = await hire(workspace, HELPERS);
    const before = workspace.agent.harnessDynamicWorkers.calls.length;

    const roster = await workspace.agent.listWorkspaceAgents();

    expect(workspace.agent.harnessDynamicWorkers.calls.slice(before)).toEqual([]);
    expect(roster.map((agent) => agent.label)).toEqual(expect.arrayContaining(['Main', ...labels]));
  });

  test("shows a helper's figures as its isolate reported them at its turn's end, and reads on once it is dismissed", async () => {
    const workspace = gatewayWorkspace(hiringGateway());

    await workspace.agent.setSoul('# Purpose\n\nCount the paths.');
    await catalogTurn(workspace.agent, 'Delegate counting the paths.');
    await workspace.agent.terminalRetryPass();
    await joinHarnessFibers();
    const before = workspace.agent.harnessDynamicWorkers.calls.length;
    const hired = (await workspace.agent.listWorkspaceAgents()).find((agent) => agent.category === 'hired');

    expect(hired?.figures.tokens).toBeGreaterThan(0);
    await workspace.agent.dismissSubordinate('counter', true);

    expect((await workspace.agent.listWorkspaceAgents()).map((agent) => agent.label)).toEqual(['Main']);
    expect(workspace.agent.harnessDynamicWorkers.calls.slice(before)).toEqual([]);
  });
});

describe("a read across every agent's isolate", () => {
  test(`waits for a slot, so spend across ${String(HELPERS)} helpers is read with ten calls in flight at most`, async () => {
    const workspace = orchestratorHarness();

    await hire(workspace, HELPERS);
    const workers = workspace.agent.harnessDynamicWorkers;

    workers.peak = 0;

    expect(await workspace.agent.accountSpend()).toEqual(expect.any(Array));
    expect(workers.peak).toBe(10);
  });

  test("an eleventh call waits for one of Kinu's own to end, then runs", async () => {
    const workspace = orchestratorHarness();

    await hire(workspace, 11);
    const workers = workspace.agent.harnessDynamicWorkers;
    const gate = Promise.withResolvers<void>();

    workers.gate = gate.promise;
    const spend = workspace.agent.accountSpend();

    await workers.when(() => workers.inFlight.size === 10);
    expect(workers.refused).toBe(0);

    workers.gate = null;
    gate.resolve();

    expect(await spend).toEqual(expect.any(Array));
  });

  test('a call the platform refused, for workers no ledger here sees, is sent again when a call of its own ends', async () => {
    const workspace = orchestratorHarness();

    await hire(workspace, 2);
    const workers = workspace.agent.harnessDynamicWorkers;
    const gate = Promise.withResolvers<void>();

    workers.hidden = 9;
    workers.gate = gate.promise;
    const spend = workspace.agent.accountSpend();

    await workers.when(() => workers.refused === 1 && workers.inFlight.size === 1);
    await roundTrips(20);

    workers.gate = null;
    gate.resolve();

    expect(await spend).toEqual(expect.any(Array));
  });

  // A refusal pauses the ledger's admissions (50 ms, doubling to 2 s), so refused calls never resend in a loop.
  test('refused calls are not sent again at once, then every call completes once a call that ran ends', async () => {
    const workspace = orchestratorHarness();

    await hire(workspace, 3);
    const workers = workspace.agent.harnessDynamicWorkers;
    const gate = Promise.withResolvers<void>();

    workers.hidden = 9;
    workers.gate = gate.promise;
    const timer = globalThis.setTimeout;
    const ledger = workspace.agent.harnessDynamicWorkerLedger();
    const beforeRetry = Promise.withResolvers<{ refused: number; calls: number }>();

    const observeRetry = Object.assign((...args: Parameters<typeof timer>): ReturnType<typeof timer> => {
      const [callback, ms, ...params] = args;

      if (ms === undefined || ms <= 0 || loaderLedgerStats(ledger).pauseMs !== ms) return timer(...args);

      return timer(() => {
        beforeRetry.resolve({ refused: workers.refused, calls: workers.calls.length });
        callback(...params);
      }, ms);
    }, timer);

    const arming = vi.spyOn(globalThis, 'setTimeout').mockImplementation(observeRetry);
    const spend = workspace.agent.accountSpend();

    try {
      // Main's isolate is read as every hire's is: four isolates, one slot.
      expect(await beforeRetry.promise).toEqual({ refused: 3, calls: 1 });
      workers.gate = null;
      gate.resolve();

      expect(await spend).toEqual(expect.any(Array));
      expect(workers.calls).toHaveLength(4);
      expect(new Set(workers.calls).size).toBe(4);
    } finally {
      workers.gate = null;
      gate.resolve();
      arming.mockRestore();
      await spend;
    }
  });

  test("fails naming the ledger when every slot is Nimbus's and none of Kinu's calls is in flight", async () => {
    const workspace = orchestratorHarness();

    await hire(workspace, 1);
    const ledger = workspace.agent.harnessDynamicWorkerLedger();
    const held = Array.from({ length: 10 }, (_, index) => beginLoaderFetch(ledger, `nimbus-facet-${String(index)}`));

    expect(workspace.agent.accountSpend()).rejects.toMatchObject({
      code: 'unavailable', message: expect.stringContaining('distinct dynamic worker(s) in flight (nimbus-facet-0'),
    });

    for (const end of held) end();
  });
});
