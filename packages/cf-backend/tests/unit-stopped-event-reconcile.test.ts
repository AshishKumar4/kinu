import { expect, setSystemTime, test } from 'bun:test';
import { present } from '@kinu.run/test-utils';
import { agentSql, catalogTurn, GATEWAY_CATALOG, gatewayWorkspace, reactivateOrchestratorHarness, workspaceMainActor } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

// Rehearses the persisted state the former Stop left, alongside an input its owner still holds.
test('the one-time Stop reconcile dismisses an old orphan and preserves an owner-held input regardless of age', async () => {
  const gateway = stubAiBinding((run) => {
    const { messages } = requestOf(run);

    if (messages.some((message) => message.role === 'tool')) return chatCompletion(run, 'Waiting on the release decision.');

    return toolCallCompletion(run, { tool: 'ask_owner', args: {
      questions: [{ id: 'release', question: 'Which release should be prepared?', header: 'Release', recommended: 0,
        options: [{ label: 'Candidate', description: 'Prepare the candidate.' }, { label: 'Current', description: 'Keep the current release.' }] }],
    } }, 'ask_release');
  });

  const workspace = gatewayWorkspace(gateway);

  await catalogTurn(workspace.agent, 'Prepare the release.');
  const main = workspaceMainActor(workspace.db);

  const peer = async (sender_event_id: string) => await workspace.agent.receivePeerMessage({
    sender_event_id, sender_agent_name: 'sender', sender_user_id: 'harness-owner',
    topic: 'Daily brief', body: 'Report release status.', mode: 'build',
  });

  const orphan = await peer('old-stopped-input');
  const orphanId = present(orphan.event_id, 'the old input event');

  await workspace.agent.drainAgent(main);
  await workspace.agent.harnessAgentsIdle();
  const orphanTurn = workspace.db.query<{ turn_id: string }, [string]>('SELECT turn_id FROM agent_log WHERE id = ?').get(orphanId)?.turn_id ?? '';

  // The old Stop retired the queued input and left its workspace lease. The actor restart drops its old RAM queue.
  void agentSql(workspace, main.actorId)`DELETE FROM queued_turns WHERE id = ${orphanTurn}`;
  const held = await peer('still-waiting-on-owner');
  const heldId = present(held.event_id, 'the input held by its owner');

  await workspace.agent.drainAgent(main);
  await workspace.agent.harnessAgentsIdle();
  const heldBinding = workspace.db.query<{ turn_id: string }, [string]>('SELECT turn_id FROM agent_log WHERE id = ?').get(heldId)?.turn_id;
  const heldTurn = present(heldBinding, 'the held event binding');

  workspace.db.exec('UPDATE agent_log SET consumed_at = 0 WHERE consumed_at IS NOT NULL');
  workspace.agent.harnessDynamicWorkerLedger().storage.kv.delete('stopped-event-leases-2026-11-12');
  workspace.agent.harnessResetAgentIsolate(workspace.agent.agentOf(main.actorId).storageKey);

  const next = await reactivateOrchestratorHarness(workspace.db, undefined, {
    world: { aiGateway: gateway }, beforeStart: (agent) => { agent.harnessInstallCatalog(GATEWAY_CATALOG); },
  });

  try {
    setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    await next.agent.terminalRetryPass();
    await next.agent.harnessAgentsIdle();
    const rows = workspace.db.query<{ id: string; turn_id: string | null; consumed_at: number | null; step_idx: number }, []>('SELECT id, turn_id, consumed_at, step_idx FROM agent_log WHERE variant = \'peer_agent\'').all();

    expect(rows.find((row) => row.id === orphanId)).toEqual({ id: orphanId, turn_id: null, consumed_at: null, step_idx: -2 });
    expect(rows.find((row) => row.id === heldId)).toEqual({ id: heldId, turn_id: heldTurn, consumed_at: 0, step_idx: 0 });
    expect(agentSql(next, main.actorId)<{ n: number }>`SELECT COUNT(*) AS n FROM queued_turns`[0]?.n).toBe(1);
    expect(next.agent.harnessDynamicWorkerLedger().storage.kv.get<boolean>('stopped-event-leases-2026-11-12')).toBe(true);
  } finally {
    setSystemTime();
  }
});
