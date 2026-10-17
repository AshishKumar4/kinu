// What waits on the owner, as an agent's program reads it through `agent.*`, and the one wake it arms: the workspace
// agent reads every row, a hire its own, and a hire's wake comes once its owner has decided the asks it raised.
import { describe, expect, test } from 'bun:test';
import { DeferredApprovalStore, formatApproval, type JsonValue, type OperationCaller } from '@kinu.run/core';
import { wrapDatabase } from '@kinu.run/core/identity';
import { agentSql, hostedSubordinateHarness, orchestratorHarness, reactivateOrchestratorHarness, until, workspaceMainActor, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';

/** `agent.<member>(args)` as `actorId`'s own programs reach it: the public operation call its isolate's eval makes. */
async function agentCall(workspace: ActorHarness<HarnessOrchestratorAgent>, actorId: string, member: string, args: JsonValue = {}): Promise<JsonValue> {
  const caller = { actorId, turnId: null, mode: 'build' } satisfies OperationCaller;

  return (await workspace.agent.callOperation(caller, `agent.${member}`, args, { callId: crypto.randomUUID() })).value;
}

/** A gated shell command parked on the owner as `actorId`'s own ask. */
function park(workspace: ActorHarness<HarnessOrchestratorAgent>, actorId: string, command: string): string {
  const actor = actorId === workspaceMainActor(workspace.db).actorId ? workspaceMainActor(workspace.db) : null;
  const id = `defer-${crypto.randomUUID()}`;

  new DeferredApprovalStore(wrapDatabase(workspace.db).sql, actor ?? { ...workspaceMainActor(workspace.db), actorId }).create({
    id, command, executor: 'workspace', context: {}, reason: formatApproval({ decision: 'gate', hits: [] }), requestedAt: Date.now(),
  }, []);

  return id;
}

describe('agent.waitingOnOwner and agent.wakeWhenOwnerDone', () => {
  test("the workspace agent reads every ask, a hire only its own; a hire's wake comes once, when its own are decided", async () => {
    const workspace = orchestratorHarness();
    const hire = await hostedSubordinateHarness(workspace, { name: 'scout', displayName: 'Scout', nameOrigin: 'user', roleId: 'task', mission: 'look around' });
    const hireId = hire.actor.handle.actorId;

    park(workspace, workspaceMainActor(workspace.db).actorId, 'bun run deploy');
    const hiresAsk = park(workspace, hireId, 'git push origin main');

    expect(await workspace.agent.askDeviceConsent({ deviceId: 'dev-1', deviceLabel: 'laptop', method: 'shell', command: 'brew install jq', epoch: 0 })).toBe('queued');

    const mainSees = await agentCall(workspace, workspaceMainActor(workspace.db).actorId, 'waitingOnOwner');
    const hireSees = await agentCall(workspace, hireId, 'waitingOnOwner');

    expect(mainSees).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'command', what: 'bun run deploy' }),
      expect.objectContaining({ kind: 'command', what: 'git push origin main', askedBy: 'scout' }),
      expect.objectContaining({ kind: 'consent', what: 'shell on laptop: brew install jq', askedBy: null }),
    ]));
    expect(hireSees).toEqual([expect.objectContaining({ key: `action:${hiresAsk}`, kind: 'command', what: 'git push origin main', askedBy: 'scout' })]);

    expect(await agentCall(workspace, hireId, 'wakeWhenOwnerDone')).toEqual({ armed: true });

    // The owner decides the hire's ask; the workspace's own still wait. The hire is woken, once, on its own queue.
    // Woken as the owner's word wakes it: a turn of its own that starts with what it was told.
    const told = (actorId: string): number => agentSql(workspace, actorId)<{ n: number }>`
      SELECT COUNT(*) AS n FROM run_events WHERE actor_id = ${actorId} AND type = 'run_start' AND payload LIKE ${'%Your owner has handled everything%'}`[0]?.n ?? 0;

    await workspace.agent.decideDeferredApprovals([hiresAsk], 'denied');
    await workspace.agent.harnessAgentsIdle();
    expect(told(hireId)).toBe(1);

    // The rest decided: nothing more is armed, so no one is told again.
    await workspace.agent.decideDeferredApprovals((await workspace.agent.listDeferredApprovals()).map((action) => action.id), 'denied');
    await workspace.agent.harnessAgentsIdle();
    expect({ hire: told(hireId), root: told(workspaceMainActor(workspace.db).actorId) }).toEqual({ hire: 1, root: 0 });
  });

  test("a wake on one ask's key fires when that ask is decided; nothing waiting, nothing is armed", async () => {
    const workspace = orchestratorHarness();
    const main = workspaceMainActor(workspace.db).actorId;
    const deploy = park(workspace, main, 'bun run deploy');

    park(workspace, main, 'rm -rf dist');

    expect(await agentCall(workspace, main, 'wakeWhenOwnerDone', { key: `action:${deploy}` })).toEqual({ armed: true });
    expect(workspaceMainActor(workspace.db).config.getOwnerWaitsWatch()).toMatchObject({ key: `action:${deploy}`, what: 'bun run deploy' });

    await workspace.agent.decideDeferredApprovals([deploy], 'denied');
    await until(() => workspaceMainActor(workspace.db).config.getOwnerWaitsWatch() === null, 'the keyed wait was never met');

    expect(await agentCall(workspace, main, 'wakeWhenOwnerDone', { key: `action:${deploy}` })).toEqual({ already: true });
  });

  test('an armed wait outlives its object: the next activation meets it at the owner\'s decision', async () => {
    const workspace = orchestratorHarness();
    const deploy = park(workspace, workspaceMainActor(workspace.db).actorId, 'bun run deploy');

    expect(await agentCall(workspace, workspaceMainActor(workspace.db).actorId, 'wakeWhenOwnerDone')).toEqual({ armed: true });

    // The object goes; its next activation knows of the wait only through the agent's own config row.
    const reopened = await reactivateOrchestratorHarness(workspace.db);

    await reopened.agent.decideDeferredApprovals([deploy], 'denied');
    await until(() => workspaceMainActor(workspace.db).config.getOwnerWaitsWatch() === null, 'the next activation never met the wait');
  });
});
