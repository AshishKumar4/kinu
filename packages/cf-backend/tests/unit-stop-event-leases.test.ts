import { expect, test } from 'bun:test';
import { agentSql, catalogTurn, gatewayWorkspace, workspaceMainActor } from './helpers/actor-harness';
import { cutNextDelivery } from './helpers/agent-facets';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';
import { TERMINAL_RETRY_JOB } from '../src/wake-jobs';

for (const crossing of ['admitted', 'unpaid'] as const) {
  test(`Stop dismisses the events of an ${crossing} delivery held behind main's owner question and leaves no retry wake`, async () => {
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

    expect((await workspace.agent.listOwnerQuestions()).some((question) => question.asked.status === 'open')).toBe(true);

    const received = await workspace.agent.receivePeerMessage({
      sender_event_id: 'daily-brief', sender_agent_name: 'sender', sender_user_id: 'harness-owner',
      topic: 'Daily brief', body: 'Report release status.', mode: 'build',
    });

    if (crossing === 'unpaid') cutNextDelivery(workspace.agent.agentOf(main.actorId).storageKey, 'before-admit');
    await workspace.agent.drainAgent(main);
    await workspace.agent.harnessAgentsIdle();
    expect(workspace.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM agent_deliveries').get()?.n).toBe(crossing === 'unpaid' ? 1 : 0);
    expect(agentSql(workspace, main.actorId)<{ n: number }>`SELECT COUNT(*) AS n FROM queued_turns`[0]?.n).toBe(crossing === 'admitted' ? 1 : 0);

    await workspace.agent.cancelCurrentWork();
    await workspace.agent.harnessAgentsIdle();
    await workspace.agent.terminalRetryPass();
    await workspace.agent.harnessAgentsIdle();
    await workspace.agent.terminalRetryPass();

    const lease = workspace.db.query<{ turn_id: string | null; consumed_at: number | null; step_idx: number }, [string]>('SELECT turn_id, consumed_at, step_idx FROM agent_log WHERE id = ?').get(received.event_id ?? '');
    const wake = workspace.db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM cf_agents_jobs WHERE id = ?').get(TERMINAL_RETRY_JOB)?.n;

    expect({ lease, wake }).toEqual({ lease: { turn_id: null, consumed_at: null, step_idx: -2 }, wake: 0 });
    expect(agentSql(workspace, main.actorId)<{ n: number }>`SELECT COUNT(*) AS n FROM queued_turns`[0]?.n).toBe(0);
    expect(workspace.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM agent_deliveries').get()?.n).toBe(0);
  });
}
