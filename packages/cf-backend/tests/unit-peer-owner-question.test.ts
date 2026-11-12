import { expect, setSystemTime, test } from 'bun:test';
import type { PeerMessage } from '@kinu.run/core';
import { isRuntimeContext, present } from '@kinu.run/test-utils';
import { agentSql, catalogTurn, GATEWAY_CATALOG, type HarnessOrchestratorAgent, orchestratorHarness, workspaceMainActor } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

const ASK = {
  questions: [{
    id: 'release', question: 'Which release should be prepared?', header: 'Release', recommended: 0,
    options: [{ label: 'Next candidate', description: 'Prepare the candidate.' }, { label: 'Current', description: 'Keep the current release.' }],
  }],
};

for (const restart of [false, true]) {
  test(`a peer delivery held behind an owner question is read once after the answer, isolate restarted: ${restart}`, async () => {
    const initial = Date.now();
    const peers = new Map<string, HarnessOrchestratorAgent>();
    let replies = 0;

    const gateway = stubAiBinding((run) => {
      const { messages } = requestOf(run);

      let at = messages.length - 1;

      while (at >= 0 && !(messages[at]?.role === 'user' && typeof messages[at]?.content === 'string' && !isRuntimeContext(String(messages[at]?.content)))) at -= 1;

      const content = messages[at]?.content;
      const text = typeof content === 'string' ? content : '';
      const tools = messages.slice(at + 1).filter((message) => message.role === 'tool').length;

      if (text.includes('Daily brief status') && tools === 0) {
        replies += 1;

        return toolCallCompletion(run, { tool: 'agents', args: { op: 'message', agent: 'sender', topic: 'Daily brief status', message: 'Waiting on the release decision.' } }, `reply_${replies}`);
      }

      if (text === 'Prepare the release.' && tools === 0) return toolCallCompletion(run, { tool: 'ask_owner', args: ASK }, 'ask_release');

      return chatCompletion(run, 'Noted.');
    });

    const recipient = orchestratorHarness({ titles: [], workspaces: [{ name: 'sender', displayName: 'Sender' }] }, { workspace: 'recipient', aiGateway: gateway, workspaces: peers });

    recipient.agent.harnessInstallCatalog(GATEWAY_CATALOG);

    const sender = orchestratorHarness(undefined, { workspace: 'sender', aiGateway: stubAiBinding((run) => chatCompletion(run, 'Received.')), workspaces: peers });

    sender.agent.harnessInstallCatalog(GATEWAY_CATALOG);
    peers.set('sender', sender.agent);
    peers.set('recipient', recipient.agent);

    const main = workspaceMainActor(recipient.db).actorId;

    const incoming: PeerMessage = {
      sender_event_id: 'one-daily-brief', sender_agent_name: 'sender', sender_user_id: 'harness-owner',
      topic: 'Daily brief status', body: 'Report release status.', mode: 'build',
    };

    try {
      await Promise.all([recipient.started, sender.started]);
      await catalogTurn(recipient.agent, 'Prepare the release.');
      const question = present((await recipient.agent.listOwnerQuestions()).find((item) => item.asked.status === 'open'), 'the release question');
      const admitted = await recipient.agent.receivePeerMessage(incoming);

      expect(admitted.admitted).toBe(true);
      await recipient.agent.drainAgent(workspaceMainActor(recipient.db));
      await recipient.agent.harnessAgentsIdle();
      expect(replies).toBe(0);

      if (restart) recipient.agent.harnessResetAgentIsolate(recipient.agent.agentOf(main).storageKey);

      // A delivery can wait on its owner for longer than the old lease's ten-minute grace.
      setSystemTime(initial + 11 * 60 * 1000);
      await recipient.agent.terminalRetryPass();
      await recipient.agent.harnessAgentsIdle();
      expect(replies).toBe(0);

      await recipient.agent.answerOwnerQuestions(question.asked.id, [{ id: 'release', selected: ['Next candidate'] }]);
      await recipient.agent.harnessAgentsIdle();
      await sender.agent.drainAgent(workspaceMainActor(sender.db));
      await sender.agent.harnessAgentsIdle();
      await recipient.agent.terminalRetryPass();
      await recipient.agent.drainAgent(workspaceMainActor(recipient.db));
      await recipient.agent.harnessAgentsIdle();

      const turns = agentSql(recipient, main)<{ n: number }>`SELECT COUNT(*) AS n FROM run_events WHERE type = 'run_start' AND json_extract(payload, '$.caused_by') = 'event_drain'`;

      expect({ replies, turns: turns[0]?.n }).toEqual({ replies: 1, turns: 1 });
      expect((await sender.agent.listRecentEvents({ variant: 'peer_agent' })).length).toBe(1);
    } finally {
      setSystemTime();
    }
  });
}
