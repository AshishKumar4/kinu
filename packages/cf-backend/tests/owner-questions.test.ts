/**
 * The agent's questions to its owner on the cloud backend, read from the requests the model received: the turn ends on
 * the ask, and every later request carries the owner's answer, or the dismissal, as that call's one result. What the
 * model read up to its ask is sent again byte for byte, so its cache holds up to the call.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { actorConnectionTag, JsonValueSchema, OwnerQuestionStore, WORKSPACE_TITLE_SYSTEM_PROMPT, type JsonValue, type OwnerAnswer } from '@kinu.run/core';
import { settleSync } from '@kinu.run/core/obs';
import { sqlOver } from '@kinu.run/test-utils';
import { asPane } from './helpers/agents-sdk';
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

/**
 * A model that asks once and then goes on: each request offered `ask_owner` (the conversation's, not a side lane's) is
 * kept, and is answered with the call until a request carries its result.
 */
function asksOnce(): AskingModel {
  const sent: Sent[] = [];

  const gateway = stubAiBinding((run: RecordedGatewayRun) => {
    const { messages, tools } = requestOf(run);

    if (!tools.includes('ask_owner') || JSON.stringify(messages).includes(WORKSPACE_TITLE_SYSTEM_PROMPT)) return chatCompletion(run, 'Noted.');
    const query = v.parse(SentQuerySchema, run.query);

    sent.push({ messages: query.messages, tools: JSON.stringify(query.tools) });

    // The wire renames call ids: any result after the ask is its.
    return messages.some((message) => message.role === 'tool')
      ? chatCompletion(run, 'Storing integer cents.')
      : toolCallCompletion(run, { tool: 'ask_owner', args: ASK }, CALL);
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
  const [was, now] = [JSON.stringify(asking.messages[changed]), JSON.stringify(resumed.messages[changed])];
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

async function openQuestion(workspace: StartedHarness, actor: string | null = null) {
  const open = (await workspace.agent.listOwnerQuestions()).find((asking) => asking.actor === actor && asking.asked.status === 'open');

  if (open === undefined) throw new Error('the ask left no open question');

  return open.asked;
}

describe('the workspace agent asks its owner', () => {
  test('the turn ends on the ask, and the answer is the call\'s one result, the prefix untouched', async () => {
    const { gateway, sent } = asksOnce();
    const workspace = gatewayWorkspace(gateway);

    await catalogTurn(workspace.agent, 'Migrate the ledger.');
    expect(sent).toHaveLength(1);
    const asked = await openQuestion(workspace);

    await workspace.agent.answerOwnerQuestions(asked.id, ANSWER);
    await workspace.agent.harnessChatLoop.pumpPromise;

    const resumed = resumedFrom(sent);

    expectOneCallOneResult(resumed, 'Integer cents');
    expect(resumed.results[0]).toContain('Round half to even.');
    // Nothing follows the answer: the model goes on from its own call.
    expect(resumed.after).toEqual([]);
    expect((await workspace.agent.listOwnerQuestions())[0]?.asked.status).toBe('answered');
  });

  test('an answer the isolate took before it died is resumed by the next activation, from the same call', async () => {
    const { gateway, sent } = asksOnce();
    const workspace = gatewayWorkspace(gateway);

    await catalogTurn(workspace.agent, 'Migrate the ledger.');
    const asked = await openQuestion(workspace);

    // Recorded, and the isolate gone before the turn it owes opened.
    settleSync(new OwnerQuestionStore(sqlOver(workspace.db), workspaceMainActor(workspace.db)).answer(asked.id, ANSWER));

    const reopened = await reactivateOrchestratorHarness(workspace.db, undefined, {
      world: { aiGateway: gateway },
      beforeStart: (agent) => { agent.harnessInstallCatalog(GATEWAY_CATALOG); },
    });

    await driveUntil(reopened, 'the next activation never resumed the answer', () => sent.length >= 2);
    await reopened.agent.harnessChatLoop.pumpPromise;

    const resumed = resumedFrom(sent);

    expectOneCallOneResult(resumed, 'Integer cents');
    // A new activation states the runtime afresh after the answer, as it does after any restart; nothing else follows.
    expect(resumed.after.every(isRuntimeState)).toBe(true);
    expect(sent).toHaveLength(2);
  });

  test('Stop dismisses the questions: the next request carries the dismissal as the call\'s result, then the owner\'s words', async () => {
    const { gateway, sent } = asksOnce();
    const workspace = gatewayWorkspace(gateway);

    await catalogTurn(workspace.agent, 'Migrate the ledger.');
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
    const workspace = gatewayWorkspace(gateway);

    await workspace.agent.setSoul('# Purpose\n\nKeep the ledger.');
    const { subordinate } = await workspace.agent.createSubordinateAgent();
    const actorId = subordinate.actorId ?? '';

    await asPane([actorConnectionTag(actorId)], () => workspace.agent.send('Migrate the ledger.', crypto.randomUUID()));
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
