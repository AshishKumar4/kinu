/**
 * A hire given a Plan task answers its hirer in Plan: the hirer's turn that takes the report up is a Plan turn, whichever
 * way the report came, its report tool or its turn's end. Defends duplicate-path rank 1: the report tool's relay said
 * Build, so a completed Plan report woke its hirer able to write.
 */
import { expect, test } from 'bun:test';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import { driveUntil, gatewayWorkspace } from './helpers/actor-harness';
import { socketConnection } from './helpers/bindings';
import { chatCompletion, openingOf, requestOf, stubAiBinding, toolCallCompletion, type GatewayToolCall } from './helpers/platform-gateway';

const BRIEF = 'Plan the parser fix.';

const ANSWER = 'Planned the parser fix.';

/** The owner's Plan message, as the pane sends one. */
function planRequest(id: string): string {
  return JSON.stringify({
    type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST, id,
    init: { method: 'POST', body: JSON.stringify({
      messages: [{ id, role: 'user', parts: [{ type: 'text', text: 'Have someone plan the parser fix.' }], metadata: { kinuMode: 'plan' } }],
      trigger: 'submit-message',
    }) },
  });
}

/** The tools of each workspace request that takes the hire's report up. */
async function takingUpThePlanReport(calls: readonly GatewayToolCall[]): Promise<(readonly string[])[]> {
  const takenUp: (readonly string[])[] = [];

  const workspace = gatewayWorkspace(stubAiBinding((run) => {
    const { messages, tools } = requestOf(run);
    const step = messages.filter((message) => message.role === 'tool').length;

    // The report opens the workspace's next turn, after the turn that hired.
    if (JSON.stringify(messages.at(-1)).includes('[subordinate_report]')) {
      takenUp.push(tools);

      return chatCompletion(run, 'Noted.');
    }

    if (openingOf(run).includes(BRIEF)) {
      const call = calls[step];

      return call === undefined ? chatCompletion(run, ANSWER) : toolCallCompletion(run, call, `call_${String(step)}`);
    }

    return step === 0
      ? toolCallCompletion(run, { tool: 'agents', args: { action: 'hire', role: 'task', lifetime: 'task', mission: BRIEF } }, 'call_hire')
      : chatCompletion(run, 'Hired a planner.');
  }));

  const owner = socketConnection({ id: 'owner', send: () => {} });
  const answered = Promise.resolve(workspace.agent.onMessage(owner, planRequest(crypto.randomUUID())));

  await driveUntil(workspace, 'the workspace never took the report up', () => takenUp.length > 0);
  await answered;

  return takenUp;
}

test.each([
  { source: 'its report tool', calls: [{ tool: 'report', args: { status: 'completed', content: ANSWER } }] },
  { source: 'its turn end', calls: [] },
])("a Plan hire's answer through $source wakes its hirer in Plan", async ({ calls }) => {
  const takenUp = await takingUpThePlanReport(calls);

  expect(takenUp[0]).toContain('submit_plan');
});
