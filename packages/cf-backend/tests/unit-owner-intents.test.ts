/**
 * The owner's decisions, answers and Retries are intents (design v2 §1, D6): committed with the agent's wake, then crossed
 * as any input is. The caller hears the agent's answer when the crossing reaches it, and `owed` when it does not; the
 * agent's wake then delivers it, once, whether the crossing died before the agent took it or after, its answer lost.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import { JsonValueSchema, type OwnerAnswer } from '@kinu.run/core';
import { driveUntil, gatewayWorkspace, workspaceMainActor, type HarnessOrchestratorAgent, type StartedHarness } from './helpers/actor-harness';
import { cutNextDelivery } from './helpers/agent-facets';
import { socketConnection } from './helpers/bindings';
import { chatCompletion, openingOf, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

const PLANNING = 'Plan the parser fix.';

const ASKING = 'Migrate the ledger.';

const RETRIED = 'Summarize the ledger.';

const ASK = {
  questions: [{
    id: 'units', question: 'Which unit should the ledger store?', header: 'Units', recommended: 0,
    options: [{ label: 'Integer cents', description: 'Exact.' }, { label: 'Decimal dollars', description: 'Readable.' }],
  }],
};

const ANSWER: OwnerAnswer[] = [{ id: 'units', selected: ['Integer cents'] }];

const CUTS = ['before-admit', 'after-admit'] as const;

/** A model that plans, asks and answers, counting what each intent's delivery ran. */
function model() {
  const ran = { approved: 0, resumed: 0, retried: 0 };

  const gateway = stubAiBinding((run) => {
    const { messages, tools } = requestOf(run);
    const said = JSON.stringify(messages);
    const answered = messages.some((message) => message.role === 'tool');

    if (said.includes('The owner approved plan')) {
      ran.approved += 1;

      return chatCompletion(run, 'Building it.');
    }

    if (openingOf(run).includes(PLANNING) && tools.includes('submit_plan')) {
      return answered ? chatCompletion(run, 'Submitted.') : toolCallCompletion(run, { tool: 'submit_plan', args: { edits: [{ start: 1, content: '# Plan\n\nFix the parser.' }] } }, 'call_plan');
    }

    if (openingOf(run).includes(ASKING) && tools.includes('ask_owner')) {
      if (!answered) return toolCallCompletion(run, { tool: 'ask_owner', args: ASK }, 'call_ask');
      ran.resumed += 1;

      return chatCompletion(run, 'Storing integer cents.');
    }

    if (openingOf(run).includes(RETRIED)) {
      ran.retried += 1;

      return chatCompletion(run, 'Three open items.');
    }

    return chatCompletion(run, 'Noted.');
  });

  return { gateway, ran };
}

const owner = socketConnection({ id: 'owner', send: () => {} });

/** Every frame the workspace broadcasts to its tabs from here on. */
function listen(agent: HarnessOrchestratorAgent): string[] {
  const frames: string[] = [];
  const fanout = agent.broadcast.bind(agent);

  Object.defineProperty(agent, 'broadcast', {
    configurable: true,
    value: (message: string, exclude?: string[]) => {
      frames.push(message);
      fanout(message, exclude);
    },
  });

  return frames;
}

/** The deliveries the workspace still owes its agents: an intent's row until the agent's answer for it lands. */
function owed(workspace: StartedHarness): number {
  return v.parse(v.object({ n: v.number() }), workspace.db.query('SELECT COUNT(*) AS n FROM agent_deliveries').get()).n;
}

/** The owner's message as the pane sends one. */
function ownerMessage(id: string, text: string, mode: 'plan' | 'build' = 'build'): string {
  return JSON.stringify({
    type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST, id,
    init: { method: 'POST', body: JSON.stringify({ messages: [{ id, role: 'user', parts: [{ type: 'text', text }], metadata: { kinuMode: mode } }], trigger: 'submit-message' }) },
  });
}

/** The owner's Retry of `turnId`, as the pane sends one: its messages up to the turn it retries. */
function retried(requestId: string, turnId: string, text: string): string {
  return JSON.stringify({
    type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST, id: requestId,
    init: { method: 'POST', body: JSON.stringify({ messages: [{ id: turnId, role: 'user', parts: [{ type: 'text', text }] }], trigger: 'regenerate-message' }) },
  });
}

async function turn(workspace: StartedHarness, text: string, mode: 'plan' | 'build' = 'build'): Promise<string> {
  const id = crypto.randomUUID();

  await workspace.agent.onMessage(owner, ownerMessage(id, text, mode));
  await workspace.agent.harnessAgentsIdle();

  return id;
}

function mainKey(workspace: StartedHarness): string {
  return workspace.agent.agentOf(workspaceMainActor(workspace.db).actorId).storageKey;
}

for (const at of CUTS) {
  test(`a plan decision whose crossing died ${at} is answered owed, and the agent's wake decides it once`, async () => {
    const { gateway, ran } = model();
    const workspace = gatewayWorkspace(gateway);

    await turn(workspace, PLANNING, 'plan');
    const plan = await workspace.agent.getActivePlanReview();

    if (plan === null) throw new Error('the plan was never submitted');
    cutNextDelivery(mainKey(workspace), at);

    const decided = await workspace.agent.decidePlanReview(plan.id, plan.revision, 'approve');

    expect(decided).toEqual({ owed: `decision:${plan.id}:${String(plan.revision)}` });
    expect(await workspace.agent.listOwedIntents()).toEqual([{ id: `decision:${plan.id}:${String(plan.revision)}`, kind: 'decision', target: plan.id, actor: null }]);

    await driveUntil(workspace, 'the owed decision was never delivered', () => ran.approved > 0 && owed(workspace) === 0);
    await workspace.agent.harnessAgentsIdle();

    expect(await workspace.agent.getActivePlanReview()).toMatchObject({ id: plan.id, status: 'approved', handoffAccepted: true });
    expect(await workspace.agent.listOwedIntents()).toEqual([]);
    expect(ran.approved).toBe(1);
  });

  test(`a question answer whose crossing died ${at} is answered owed, and the agent's wake resumes its call once`, async () => {
    const { gateway, ran } = model();
    const workspace = gatewayWorkspace(gateway);

    await turn(workspace, ASKING);
    const [asking] = await workspace.agent.listOwnerQuestions();

    if (asking === undefined) throw new Error('the agent never asked');
    cutNextDelivery(mainKey(workspace), at);

    expect(await workspace.agent.answerOwnerQuestions(asking.asked.id, v.parse(JsonValueSchema, ANSWER))).toEqual({ owed: `answers:${asking.asked.id}` });
    expect(await workspace.agent.listOwedIntents()).toEqual([{ id: `answers:${asking.asked.id}`, kind: 'answers', target: asking.asked.id, actor: null }]);

    await driveUntil(workspace, 'the owed answer was never delivered', () => ran.resumed > 0 && owed(workspace) === 0);
    await workspace.agent.harnessAgentsIdle();

    expect(await workspace.agent.listOwedIntents()).toEqual([]);
    expect(ran.resumed).toBe(1);
  });

  test(`a Retry whose crossing died ${at} ends its request owed, and the agent's wake runs the turn again once`, async () => {
    const { gateway, ran } = model();
    const workspace = gatewayWorkspace(gateway);
    const turnId = await turn(workspace, RETRIED);

    expect(ran.retried).toBe(1);
    cutNextDelivery(mainKey(workspace), at);
    const frames = listen(workspace.agent);

    const requestId = crypto.randomUUID();

    await workspace.agent.onMessage(owner, retried(requestId, turnId, RETRIED));

    const done = frames.map((frame) => v.safeParse(v.looseObject({ id: v.literal(requestId), done: v.literal(true), owed: v.optional(v.string()), error: v.optional(v.boolean()) }), JSON.parse(frame)))
      .flatMap((parsed) => (parsed.success ? [parsed.output] : []));

    expect(done).toEqual([expect.objectContaining({ owed: `retry:${turnId}` })]);
    expect(await workspace.agent.listOwedIntents()).toEqual([{ id: `retry:${turnId}`, kind: 'retry', target: turnId, actor: null }]);

    await driveUntil(workspace, 'the owed Retry was never delivered', () => ran.retried > 1 && owed(workspace) === 0);
    await workspace.agent.harnessAgentsIdle();

    expect(await workspace.agent.listOwedIntents()).toEqual([]);
    expect(ran.retried).toBe(2);
  });
}

test('a decision whose crossing reaches the agent is answered as a direct one was, and leaves nothing owed', async () => {
  const { gateway, ran } = model();
  const workspace = gatewayWorkspace(gateway);

  await turn(workspace, PLANNING, 'plan');
  const plan = await workspace.agent.getActivePlanReview();

  if (plan === null) throw new Error('the plan was never submitted');

  expect(await workspace.agent.decidePlanReview(plan.id, plan.revision, 'approve')).toMatchObject({ ok: true, queued: true, plan: { status: 'approved' } });
  expect(await workspace.agent.listOwedIntents()).toEqual([]);
  await workspace.agent.harnessAgentsIdle();
  expect(ran.approved).toBe(1);
});
