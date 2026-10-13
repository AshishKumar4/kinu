// Roster and parked-decision planes ride typed source callbacks into the one shared assembler; a backend
// splice after `collectDynamicContext` would drop planes for actors that do not re-splice. Observed where
// the model reads them: the request a turn prepares.
import { describe, expect, test } from 'bun:test';
import { appendMemoryNote, DeferredApprovalStore, formatApproval, SubordinateRosterStore } from '@kinu.run/core';
import { makeSqlExec } from '../../core/tests/helpers';
import {
  chatSessionTurns, hostedSubordinateHarness, orchestratorHarness, workspaceMainActor, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import { wrapDatabase } from '@kinu.run/core/identity';

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
    const scout = await agent.actorDirectory({ action: 'register', creationId: 'c-scout', name: 'scout', origin: 'agent', lifetime: 'durable' });

    new SubordinateRosterStore(makeSqlExec(db), workspaceMainActor(db)).create({
      name: 'scout', actorReference: scout.reference, birth: null, deleteRequested: false,
      status: 'working', currentTask: 'map the failure surface', createdAt: Date.now(), dismissedAt: null,
      taskEventId: null,
    });

    const context = await modelContext(agent);
    expect(context).toContain('scout');
    expect(context).toContain('map the failure surface');
  });

  test('a deferred shell approval is parked on the user in the block', async () => {
    const { agent, db } = orchestratorHarness();

    const parked = new DeferredApprovalStore(wrapDatabase(db).sql, workspaceMainActor(db)).create({
      id: `defer-${crypto.randomUUID()}`,
      command: 'bun run deploy',
      executor: 'workspace', context: {},
      reason: formatApproval({ decision: 'gate', hits: [] }),
      requestedAt: Date.now(),
    }, []);

    expect(parked.status).toBe('queued');

    expect(await modelContext(agent)).toContain('bun run deploy');
  });

  // The block is the workspace's to render (its reads), so the agent's own isolate reads no memory of its own.
  test("the workspace's MEMORY.md tail is in its agent's block", async () => {
    const workspace = orchestratorHarness();
    const hire = await hostedSubordinateHarness(workspace, { name: 'scribe-1', displayName: 'Scribe', nameOrigin: 'user', roleId: 'task', mission: 'take notes' });

    // A hire's note lands in the workspace's MEMORY.md, which every agent of it reads.
    await appendMemoryNote(hire.actor.runtime.memory, 'the build needs node 22', { heading: 'Lesson' });

    expect(await modelContext(workspace.agent)).toContain('the build needs node 22');
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
