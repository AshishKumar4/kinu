import { expect, setSystemTime, test } from 'bun:test';
import { agentSql, catalogTurn, driveUntil, GATEWAY_CATALOG, gatewayWorkspace, reactivateOrchestratorHarness, workspaceMainActor } from './helpers/actor-harness';
import { cutNextDelivery } from './helpers/agent-facets';
import { chatCompletion, stubAiBinding } from './helpers/platform-gateway';

for (const cut of ['before-admit', 'after-admit'] as const) {
  test(`main recovers a peer delivery after its workspace dies ${cut}, preserving the original event binding`, async () => {
    const gateway = stubAiBinding((run) => chatCompletion(run, 'Noted.'));
    const workspace = gatewayWorkspace(gateway);

    await catalogTurn(workspace.agent, 'Open the release workspace.');
    const main = workspaceMainActor(workspace.db);

    cutNextDelivery(workspace.agent.agentOf(main.actorId).storageKey, cut);

    const received = await workspace.agent.receivePeerMessage({
      sender_event_id: 'survive-a-dead-workspace', sender_agent_name: 'sender', sender_user_id: 'harness-owner',
      topic: 'Release status', body: 'Report release status.', mode: 'build',
    });

    await workspace.agent.drainAgent(main);
    expect(workspace.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM agent_deliveries').get()?.n).toBe(1);
    const bound = workspace.db.query<{ turn_id: string }, [string]>('SELECT turn_id FROM agent_log WHERE id = ?').get(received.event_id ?? '');

    expect(bound?.turn_id).toBeDefined();

    const next = await reactivateOrchestratorHarness(workspace.db, undefined, {
      world: { aiGateway: gateway },
      beforeStart: (agent) => { agent.harnessInstallCatalog(GATEWAY_CATALOG); },
    });

    const turns = () => agentSql(next, main.actorId)<{ n: number }>`SELECT COUNT(*) AS n FROM run_events WHERE type = 'run_start' AND json_extract(payload, '$.caused_by') = 'event_drain'`[0]?.n;

    try {
      // Recovery crosses the committed delivery on its wake, before the obsolete ten-minute lease grace.
      setSystemTime(Date.now() + 61_000);
      await next.agent.alarm();
      await driveUntil(next, 'the peer delivery never reached main after the workspace died', () => turns() === 1);
      await next.agent.harnessAgentsIdle();
      await next.agent.drainAgent(main);
      await next.agent.harnessAgentsIdle();

      expect(turns()).toBe(1);
      expect(workspace.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM agent_deliveries').get()?.n).toBe(0);
      expect(workspace.db.query<{ turn_id: string; consumed_at: number | null }, [string]>('SELECT turn_id, consumed_at FROM agent_log WHERE id = ?').get(received.event_id ?? ''))
        .toEqual({ turn_id: bound?.turn_id, consumed_at: null });
    } finally {
      setSystemTime();
    }
  });
}
