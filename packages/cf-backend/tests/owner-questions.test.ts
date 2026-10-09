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

    return messages.some((message) => message.role === 'tool' && JSON.stringify(message).includes(CALL))
      ? chatCompletion(run, 'Storing integer cents.')
      : toolCallCompletion(run, { tool: 'ask_owner', args: ASK }, CALL);
  });

  return { gateway, sent };
}

/** The request after the ask, read against the one that asked. */
function resumedFrom(sent: readonly Sent[]) {
  const [asking, resumed] = sent;

  if (asking === undefined || resumed === undefined) throw new Error(`the model was asked ${String(sent.length)} time(s), not twice`);
  const calls = resumed.messages.filter((message) => JSON.stringify(message).includes('"tool_calls"') && JSON.stringify(message).includes('ask_owner'));
  const results = resumed.messages.filter((message) => JSON.stringify(message).includes(`"tool_call_id":"${CALL}"`));
  const at = resumed.messages.findIndex((message) => results.includes(message));

  return {
    calls: calls.length, results: results.map((result) => JSON.stringify(result)), after: resumed.messages.slice(at + 1),
    // The asking request, then the model's own call: what the model had read, and what it said, up to the result.
    prefixKept: JSON.stringify(resumed.messages.slice(0, asking.messages.length)) === JSON.stringify(asking.messages),
    callAt: resumed.messages.indexOf(calls[0] ?? null), askedLength: asking.messages.length,
    toolsKept: resumed.tools === asking.tools,
  };
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

    expect(resumed).toMatchObject({ calls: 1, after: [], prefixKept: true, toolsKept: true });
    expect(resumed.callAt).toBe(resumed.askedLength);
    expect(resumed.results).toHaveLength(1);
    expect(resumed.results[0]).toContain('Integer cents');
    expect(resumed.results[0]).toContain('Round half to even.');
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

    expect(resumed).toMatchObject({ calls: 1, after: [], prefixKept: true, toolsKept: true });
    expect(resumed.results[0]).toContain('Integer cents');
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

    expect(resumed).toMatchObject({ calls: 1, prefixKept: true, toolsKept: true });
    expect(resumed.results[0]).toContain('dismissed');
    expect(JSON.stringify(resumed.after)).toContain('Use cents.');
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

    expect(resumed).toMatchObject({ calls: 1, after: [], prefixKept: true, toolsKept: true });
    expect(resumed.results[0]).toContain('Integer cents');
    expect((await workspace.agent.listOwnerQuestions()).find((asking) => asking.actor === actorId)?.asked.status).toBe('answered');
  });
});
