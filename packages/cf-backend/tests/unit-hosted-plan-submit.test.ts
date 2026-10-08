/**
 * A hire's Plan turn offers `submit_plan`, as the workspace's own does, and the plan it submits is reviewed in the
 * hire's window, from its own store: the hirer's window shows none.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import { actorConnectionTag } from '@kinu.run/core';
import { asPane } from './helpers/agents-sdk';
import { driveUntil, gatewayWorkspace } from './helpers/actor-harness';
import { socketConnection } from './helpers/bindings';
import { chatCompletion, openingOf, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

const BRIEF = 'Plan the parser fix.';

const PLAN = '1. Read the parser.\n2. Fix the off-by-one.';

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

test("a hire's Plan turn submits its plan to its own window, not its hirer's", async () => {
  const offered: (readonly string[])[] = [];
  let answered = false;

  const workspace = gatewayWorkspace(stubAiBinding((run) => {
    const { messages, tools } = requestOf(run);
    const step = messages.filter((message) => message.role === 'tool').length;

    if (openingOf(run).includes(BRIEF)) {
      offered.push(tools);

      if (step === 0) return toolCallCompletion(run, { tool: 'submit_plan', args: { edits: [{ start: 1, content: PLAN }] } }, 'call_plan');
      answered = true;

      return chatCompletion(run, 'Submitted the plan.');
    }

    if (JSON.stringify(messages.at(-1)).includes('[subordinate_report]')) return chatCompletion(run, 'Noted.');

    return step === 0
      ? toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', name: 'planner', mission: BRIEF } }, 'call_hire')
      : chatCompletion(run, 'Hired a planner.');
  }));

  const owner = socketConnection({ id: 'owner', send: () => {} });

  await workspace.agent.onMessage(owner, planRequest(crypto.randomUUID()));
  await driveUntil(workspace, 'the planner never answered after submitting', () => answered);

  const planner = (await workspace.agent.listSubordinates()).find((entry) => entry.name === 'planner');
  const actorId = v.parse(v.string(), planner?.actorId);
  const own = await asPane([actorConnectionTag(actorId)], () => workspace.agent.getActivePlanReview());

  expect(offered[0]).toContain('submit_plan');
  expect({ planner: own?.content, hirer: await workspace.agent.getActivePlanReview() }).toEqual({ planner: PLAN, hirer: null });
});
