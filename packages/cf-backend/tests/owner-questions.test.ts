/**
 * The agent's questions to its owner on the cloud backend, read from the requests the model received: the turn ends on
 * the ask, and every later request carries the owner's answer, or the dismissal, as that call's one result. What the
 * model read up to its ask is sent again byte for byte, so its cache holds up to the call.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { actorConnectionTag, JsonValueSchema, WORKSPACE_TITLE_SYSTEM_PROMPT, type JsonValue, type OwnerAnswer } from '@kinu.run/core';
import { asPane } from './helpers/agents-sdk';
import { createTestUserDO, provisionTestWorkspace } from './helpers/user-do';
import {
  catalogTurn, driveUntil, gatewayWorkspace, GATEWAY_CATALOG, reactivateOrchestratorHarness, workspaceMainActor, type StartedHarness,
} from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun, type StubbedAiBinding } from './helpers/platform-gateway';

const ASK = {
  questions: [{
    id: 'units', question: 'Which unit should the ledger store?', header: 'Units', recommended: 0,
    options: [{ label: 'Integer cents', description: 'Exact; every reader converts.' }, { label: 'Decimal dollars', description: 'Readable; rounding at every sum.' }],
  }],
};

const ANSWER: OwnerAnswer[] = [{ id: 'units', selected: ['Integer cents'], note: 'Round half to even.' }];

const CALL = 'call_ask';

/** Exactly what one request sent: its messages and its tools, as the gateway received them. */
interface Sent {
  readonly messages: readonly JsonValue[];
  readonly tools: string;
}

const SentQuerySchema = v.looseObject({ messages: v.array(JsonValueSchema), tools: v.optional(JsonValueSchema) });

interface AskingModel {
  readonly gateway: StubbedAiBinding;
  readonly sent: Sent[];
}

const TASK = 'Migrate the ledger.';

/**
 * A model that asks once about {@link TASK} and then goes on: each request of the conversation (one offering
 * `ask_owner`, not a side lane's) from the task on is kept, and is answered with the call until one carries a result.
 * `dies` is called at the first request that carries one, which then never answers and is not kept: its isolate is gone.
 */
function asksOnce(dies?: () => void): AskingModel {
  const sent: Sent[] = [];
  let died = dies === undefined;

  const gateway = stubAiBinding(async (run: RecordedGatewayRun) => {
    const { messages, tools } = requestOf(run);

    if (!tools.includes('ask_owner') || JSON.stringify(messages).includes(WORKSPACE_TITLE_SYSTEM_PROMPT)) return chatCompletion(run, 'Noted.');

    if (!JSON.stringify(messages).includes(TASK)) return chatCompletion(run, 'Hello.');
    const query = v.parse(SentQuerySchema, run.query);
    // The wire renames call ids: any result after the task is the ask's.
    const resumed = messages.some((message) => message.role === 'tool');

    if (resumed && !died) {
      died = true;
      dies?.();

      return await new Promise<never>(() => {});
    }

    sent.push({ messages: query.messages, tools: JSON.stringify(query.tools) });

    return resumed ? chatCompletion(run, 'Storing integer cents.') : toolCallCompletion(run, { tool: 'ask_owner', args: ASK }, CALL);
  });

  return { gateway, sent };
}

const WireCallSchema = v.looseObject({ role: v.literal('assistant'), tool_calls: v.array(v.looseObject({ id: v.string(), function: v.looseObject({ name: v.string() }) })) });

/** Runtime state the request carries after the conversation (prompting/volatile-context.ts): not a message of anyone's. */
const isRuntimeState = (message: JsonValue): boolean => JSON.stringify(message).startsWith('{"content":"<dynamic_context');

/**
 * The request after the ask, read against the one that asked: the ask call by its id on the wire, every result paired
 * with it, what follows them, and the first message before the call that changed.
 */
function resumedFrom(sent: readonly Sent[]) {
  const [asking, resumed] = sent;

  if (asking === undefined || resumed === undefined) throw new Error(`the model was asked ${String(sent.length)} time(s), not twice`);

  const calls = resumed.messages.flatMap((message, at) => {
    const call = v.safeParse(WireCallSchema, message);

    return call.success ? call.output.tool_calls.filter((each) => each.function.name === 'ask_owner').map((each) => ({ at, id: each.id })) : [];
  });

  const [call] = calls;
  const results = resumed.messages.flatMap((message, at) => JSON.stringify(message).includes(`"tool_call_id":"${call?.id ?? ''}"`) ? [{ at, text: JSON.stringify(message) }] : []);
  const changed = asking.messages.findIndex((message, at) => JSON.stringify(message) !== JSON.stringify(resumed.messages[at]));
  const [was, now] = changed < 0 ? ['', ''] : [JSON.stringify(asking.messages[changed]), JSON.stringify(resumed.messages[changed] ?? null)];
  const from = Array.from({ length: was.length }, (_, at) => at).find((at) => was[at] !== now[at]) ?? was.length;

  return {
    calls: calls.length, callAt: call?.at ?? -1, askedLength: asking.messages.length,
    results: results.map((result) => result.text), resultAt: results[0]?.at ?? -1,
    after: resumed.messages.slice((results.at(-1)?.at ?? resumed.messages.length) + 1),
    // Where the first changed message first differs, so a failure names the bytes that broke the cache.
    firstChange: changed < 0 ? null : { message: changed, asked: was.slice(Math.max(0, from - 120), from + 200), resumed: now.slice(Math.max(0, from - 120), from + 200) },
    toolsKept: resumed.tools === asking.tools,
  };
}

/** One call and one result right after it, and the request up to the call as the asking one sent it. */
function expectOneCallOneResult(resumed: ReturnType<typeof resumedFrom>, answer: string): void {
  expect({ calls: resumed.calls, results: resumed.results.length, firstChange: resumed.firstChange, toolsKept: resumed.toolsKept })
    .toEqual({ calls: 1, results: 1, firstChange: null, toolsKept: true });
  expect([resumed.callAt, resumed.resultAt]).toEqual([resumed.askedLength, resumed.askedLength + 1]);
  expect(resumed.results[0]).toContain(answer);
}

const OWNER = 'abcdef0123456789abcdef0123456789';

/**
 * A workspace its owner named, in a real account registry. The system prompt names the workspace
 * (prompts/agent-names-line.md); the harness's own registry keeps no name, so every turn would rename it there and
 * change the prompt, ask or not.
 */
async function namedWorkspace(gateway: StubbedAiBinding): Promise<StartedHarness> {
  const user = createTestUserDO({ durableObjectId: OWNER });
  const token = await provisionTestWorkspace(user, 'ledger', 'Ledger');
  const workspace = gatewayWorkspace(gateway, { userDO: user.userDO, workspace: 'ledger', ownerUserId: OWNER });

  workspace.agent.harnessHoldsCapability(token);
  await workspace.agent.setDisplayName('Ledger');

  return workspace;
}

async function openQuestion(workspace: StartedHarness, actor: string | null = null) {
  const open = (await workspace.agent.listOwnerQuestions()).find((asking) => asking.actor === actor && asking.asked.status === 'open');

  if (open === undefined) throw new Error('the ask left no open question');

  return open.asked;
}

describe('the workspace agent asks its owner', () => {
  test('the turn ends on the ask, and the answer is the call\'s one result, the prefix untouched', async () => {
    const { gateway, sent } = asksOnce();
    const workspace = await namedWorkspace(gateway);

    await catalogTurn(workspace.agent, TASK);
    expect(sent).toHaveLength(1);
    const asked = await openQuestion(workspace);

    await workspace.agent.answerOwnerQuestions(asked.id, ANSWER);
    await driveUntil(workspace, 'the answer never resumed the turn', () => sent.length >= 2);

    const resumed = resumedFrom(sent);

    expectOneCallOneResult(resumed, 'Integer cents');
    expect(resumed.results[0]).toContain('Round half to even.');
    // Nothing follows the answer: the model goes on from its own call.
    expect(resumed.after).toEqual([]);
    expect((await workspace.agent.listOwnerQuestions())[0]?.asked.status).toBe('answered');
  });

  test('an answer whose turn the isolate died in is resumed by the next activation, from the same call', async () => {
    let die = (): void => {};

    const { gateway, sent } = asksOnce(() => { die(); });
    // Not named first: the harness's registry keeps no title, so the next activation would name it nothing either.
    const workspace = gatewayWorkspace(gateway);
    const main = workspace.agent.agentOf(workspaceMainActor(workspace.db).actorId);

    die = () => { workspace.agent.harnessResetAgentIsolate(main.storageKey); };

    await catalogTurn(workspace.agent, TASK);
    const asked = await openQuestion(workspace);

    // Taken in main's own isolate, under the wake the workspace armed for it, and the isolate gone in the turn it owes.
    await workspace.agent.answerOwnerQuestions(asked.id, ANSWER);

    const reopened = await reactivateOrchestratorHarness(workspace.db, undefined, {
      world: { aiGateway: gateway },
      beforeStart: (agent) => { agent.harnessInstallCatalog(GATEWAY_CATALOG); },
    });

    await driveUntil(reopened, 'the next activation never resumed the answer', () => sent.length >= 2);

    const resumed = resumedFrom(sent);

    expectOneCallOneResult(resumed, 'Integer cents');
    // A new activation states the runtime afresh after the answer, as it does after any restart; nothing else follows.
    expect(resumed.after.every(isRuntimeState)).toBe(true);
    expect(sent).toHaveLength(2);
  });

  test('Stop dismisses the questions: the next request carries the dismissal as the call\'s result, then the owner\'s words', async () => {
    const { gateway, sent } = asksOnce();
    const workspace = await namedWorkspace(gateway);

    await catalogTurn(workspace.agent, TASK);
    await workspace.agent.cancelCurrentWork();
    expect((await workspace.agent.listOwnerQuestions())[0]?.asked.status).toBe('dismissed');

    await catalogTurn(workspace.agent, 'Use cents.');
    const resumed = resumedFrom(sent);

    expectOneCallOneResult(resumed, 'dismissed');
    expect(resumed.after.filter((message) => !isRuntimeState(message)).map((message) => JSON.stringify(message))).toEqual([expect.stringContaining('Use cents.')]);
  });
});

describe("an agent the owner added asks them on the owner's turns", () => {
  test('its question waits in the workspace stack, and the answer resumes it in its own isolate', async () => {
    const { gateway, sent } = asksOnce();
    const workspace = await namedWorkspace(gateway);

    await workspace.agent.setSoul('# Purpose\n\nKeep the ledger.');
    const { subordinate } = await workspace.agent.createSubordinateAgent();
    const actorId = subordinate.actorId ?? '';

    // Named by the owner, as the workspace is, so its first turn names it nothing new.
    await workspace.agent.renameSubordinateAgent(subordinate.name, 'Ledger keeper');

    await asPane([actorConnectionTag(actorId)], () => workspace.agent.send(TASK, crypto.randomUUID()));
    await driveUntil(workspace, 'the agent never asked', () => sent.length >= 1);
    await workspace.agent.harnessAgentsIdle();
    const asked = await openQuestion(workspace, actorId);

    await workspace.agent.answerOwnerQuestions(asked.id, ANSWER, actorId);
    await driveUntil(workspace, 'the answer never resumed the agent', () => sent.length >= 2);
    await workspace.agent.harnessAgentsIdle();

    const resumed = resumedFrom(sent);

    expectOneCallOneResult(resumed, 'Integer cents');
    expect(resumed.after).toEqual([]);
    expect((await workspace.agent.listOwnerQuestions()).find((asking) => asking.actor === actorId)?.asked.status).toBe('answered');
  });
});
