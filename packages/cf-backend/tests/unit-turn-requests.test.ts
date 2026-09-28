/** The owner reads a turn's requests as the model received them, rebuilt from what the turn stored. */
import { describe, expect, test } from 'bun:test';
import { ActorClaimStore, JsonValueSchema, type JsonValue } from '@kinu.run/core';
import * as v from 'valibot';
import { makeSql } from '../../core/tests/helpers';
import {
  catalogTurn, gatewayWorkspace, historyOver, workspaceMainActor, type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import { answeringGateway, requestOf, scriptedGateway } from './helpers/platform-gateway';

function latestTurnId(harness: ActorHarness<HarnessOrchestratorAgent>): string {
  const store = new ActorClaimStore(makeSql(harness.db), workspaceMainActor(harness.db), (write) => write(), historyOver(harness));
  const turn = store.latestTurn();

  if (turn === null) throw new Error('no turn was claimed');

  return turn.turnId;
}

/** One message both ways, so a page (stored parts) and a wire request (OpenAI chat) compare deeply. */
interface Canonical { role: string; text: string; calls: { id: string; name: string; args: JsonValue }[]; result: { id: string; value: JsonValue } | null }

const PagePartSchema = v.variant('type', [
  v.looseObject({ type: v.literal('text'), text: v.string() }),
  v.looseObject({ type: v.literal('tool-call'), toolCallId: v.string(), toolName: v.string(), input: JsonValueSchema }),
  v.looseObject({ type: v.literal('tool-result'), toolCallId: v.string(), output: v.looseObject({ value: JsonValueSchema }) }),
]);

const PageMessageSchema = v.looseObject({ role: v.string(), content: v.union([v.string(), v.array(PagePartSchema)]) });

/** Every tool argument and result in this turn is JSON on the wire. */
function parsedJson(text: string): JsonValue {
  return v.parse(JsonValueSchema, JSON.parse(text));
}

function canonicalFromPage(message: v.InferOutput<typeof PageMessageSchema>): Canonical {
  const { role, content } = message;

  if (v.is(v.string(), content)) return { role, text: content, calls: [], result: null };
  let text = '';
  const calls: Canonical['calls'] = [];
  let result: Canonical['result'] = null;

  for (const part of content) {
    if (part.type === 'text') text += part.text;

    if (part.type === 'tool-call') calls.push({ id: part.toolCallId, name: part.toolName, args: part.input });

    if (part.type === 'tool-result') result = { id: part.toolCallId, value: part.output.value };
  }

  return { role, text, calls, result };
}

const WireMessageSchema = v.looseObject({
  role: v.string(),
  content: v.nullish(v.string()),
  tool_call_id: v.optional(v.string()),
  tool_calls: v.optional(v.array(v.object({ id: v.string(), function: v.object({ name: v.string(), arguments: v.string() }) }))),
});

function canonicalFromWire(message: v.InferOutput<typeof WireMessageSchema>): Canonical {
  const text = message.content ?? '';

  if (message.role === 'tool') return { role: 'tool', text: '', calls: [], result: { id: message.tool_call_id ?? '', value: parsedJson(text) } };

  return {
    role: message.role, text,
    calls: (message.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function.name, args: parsedJson(call.function.arguments) })),
    result: null,
  };
}

describe('the context number a page reads back', () => {
  test('the web snapshot and the status read show the prompt size the last step reported', async () => {
    const harness = gatewayWorkspace(answeringGateway('Noted.'));
    expect((await harness.agent.getActivitySnapshot()).fill).toBeNull();

    await catalogTurn(harness.agent, 'Remember the word heron.');

    const { fill } = await harness.agent.getActivitySnapshot();
    // The stub provider reports one prompt token per request.
    expect(fill).toMatchObject({ tokens: 1, source: 'provider' });
    expect((await harness.agent.getAgentStatus()).context).toEqual(fill);
  });
});

describe('a turn read back request by request', () => {
  test('each step reads as the list the provider received, paired with what came back', async () => {
    const gateway = scriptedGateway([{ tool: 'file', args: { action: 'write', path: '/workspace/notes.txt', content: 'hello' } }], 'All written.');
    const harness = gatewayWorkspace(gateway);
    await catalogTurn(harness.agent, 'Write hello to notes.txt.');
    const turnId = latestTurnId(harness);

    const index = await harness.agent.getTurnRequests(turnId);
    expect(index.claim?.status).toBe('settled');
    const steps = index.requests.filter((row) => row.step !== null);
    expect(steps.map((row) => row.step)).toEqual([0, 1]);
    expect(index.requests.filter((row) => row.step === null)).toHaveLength(1);

    // The page does not claim the system prompt (not kept per request), so the wire's is set aside.
    const sent = gateway.runs.map(requestOf).map((request) => request.messages.filter((message) => message.role !== 'system').map((message) => canonicalFromWire(v.parse(WireMessageSchema, message))));
    expect(sent).toHaveLength(2);

    for (const [at, row] of steps.entries()) {
      const page = await harness.agent.getTurnRequest(turnId, { epoch: row.epoch, revision: row.revision });

      // What the provider received, message for message, text, calls and results included.
      expect(page.messages.map((message) => canonicalFromPage(v.parse(PageMessageSchema, message)))).toEqual(sent[at] ?? []);
      expect(page.nextFrom).toBeNull();
      expect(page.head?.response?.stepIndex).toBe(at + 1);
    }

    const first = await harness.agent.getTurnRequest(turnId, { epoch: steps[0]?.epoch ?? 0, revision: steps[0]?.revision ?? 0 });
    expect(first.head?.response?.reason).toBe('tool-calls');
    const last = await harness.agent.getTurnRequest(turnId, { epoch: steps[1]?.epoch ?? 0, revision: steps[1]?.revision ?? 0 });
    expect(last.head?.response?.reason).toBe('stop');
  });

  test('a request larger than a page reads in pages that join to the whole list', async () => {
    const harness = gatewayWorkspace(answeringGateway('Noted.'));
    await catalogTurn(harness.agent, `first ${'a'.repeat(200 * 1024)}`);
    await catalogTurn(harness.agent, `second ${'b'.repeat(200 * 1024)}`);
    const turnId = latestTurnId(harness);
    // The admission: the conversation as admitted, both long messages whole (a step's request carries them clamped).
    const step = (await harness.agent.getTurnRequests(turnId)).requests.find((row) => row.step === null);

    if (step === undefined) throw new Error('the turn has no admission');
    const pages = [];
    let from: number | null = 0;

    while (from !== null) {
      const page = await harness.agent.getTurnRequest(turnId, { epoch: step.epoch, revision: step.revision, from });
      pages.push(page);
      from = page.nextFrom;
    }

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((page) => page.messages)).toHaveLength(pages[0]?.messageCount ?? -1);
    // The head rides the first page alone.
    expect(pages.map((page) => page.head !== null)).toEqual([true, ...pages.slice(1).map(() => false)]);
  });

  test('a support read lands in the owner\'s activity log with its stated reason', async () => {
    const harness = gatewayWorkspace(answeringGateway('Noted.'));
    await catalogTurn(harness.agent, 'Hello.');
    const turnId = latestTurnId(harness);

    const read = await harness.agent.supportReadTurn({ turnId, reason: 'support_ticket' });

    expect('turnId' in read && read.turnId).toBe(turnId);
    const log = (await harness.agent.getActivitySnapshot({ logs: 20 })).log;
    expect(log.filter((entry) => entry.event === 'support.read').map((entry) => entry.detail))
      .toEqual([`support read turn ${turnId} (support_ticket)`]);
  });

  test('an actor this workspace never registered is refused', async () => {
    const harness = gatewayWorkspace(answeringGateway('Noted.'));
    await catalogTurn(harness.agent, 'Hello.');

    await expect(harness.agent.getTurnRequests(latestTurnId(harness), crypto.randomUUID())).rejects.toThrow(/not registered/);
  });
});
