/**
 * The dynamic-context block across an object restart, through the production chat gate: while the provider's
 * prompt cache is warm, the stored block keeps its position and the request's prefix stays byte-identical; once
 * the cache has expired, the stored blocks go and the state is stated exactly once, before the new input.
 * The owner's ask, 2026-09-25 (DYNCTX-RESTART-0925): nothing guarded this, and a cache miss is paid on every turn.
 * And between two asks, nothing a turn reads that is no agent event (the account's facts, a workspace fact over one,
 * recalled memory, tasks, mail) reaches the prefix: 2026-11-11, the account's facts rode the system prompt,
 * and each change of one sent the whole conversation again uncached.
 */
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { DYNAMIC_CONTEXT_OPEN_TAG, type MailListing, type MailThreadSummary, type PromptFile } from '@kinu.run/core';
import {
  orchestratorHarness, reactivateOrchestratorHarness, uploadedFile, workspaceFiles, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import { createTestUserDO, provisionTestWorkspace, testOwner } from './helpers/user-do';
import { socketConnection } from './helpers/bindings';
import { chatRequest } from './helpers/chat-frames';

type Prompt = LanguageModelV4CallOptions['prompt'];

const MINUTE_MS = 60_000;

/** A clock far from a day's end: the block states the date, so a turn either side of midnight states a new one. */
const NOON = Date.parse('2026-10-07T12:00:00.000Z');

/** What a turn's ask carries besides its words: the tool calls its model makes first, and the files sent with it. */
interface Asked {
  readonly calls?: readonly { tool: string; args: object }[];
  readonly files?: readonly PromptFile[];
}

/** One root turn through the chat gate; returns the request its model received. */
async function turn(agent: HarnessOrchestratorAgent, id: string, text: string, { calls = [], files = [] }: Asked = {}): Promise<Prompt> {
  const received: Prompt[] = [];

  agent.harnessSupplyTurnModel(scriptedTurnModel({ doGenerate: (options) => {
    received.push(options.prompt);
    const step = options.prompt.filter((message) => message.role === 'tool').length;
    const call = calls[step];

    return {
      content: call === undefined
        ? [{ type: 'text', text: `answer ${id}` }]
        : [{ type: 'tool-call', toolCallId: `${id}-${String(step)}`, toolName: call.tool, input: JSON.stringify(call.args) }],
      finishReason: { unified: call === undefined ? 'stop' : 'tool-calls', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
    };
  } }));

  const settled = Promise.withResolvers<void>();
  const fanout = agent.broadcast.bind(agent);

  // The request closes at turn end; its done frame is the signal.
  Object.defineProperty(agent, 'broadcast', {
    configurable: true,
    value: (message: string, exclude?: string[]) => {
      if (message.includes(`"id":"${id}"`) && message.includes('"done":true')) settled.resolve();
      fanout(message, exclude);
    },
  });

  // Each file as the composer sends one: named by its upload and the digest it was pinned as.
  const before = files.map((file) => ({
    type: 'file', mediaType: file.mediaType, filename: file.filename, url: file.path,
    providerMetadata: { kinu: { upload: file.path, ...(file.digest !== undefined && { digest: file.digest }) } },
  }));

  await agent.harnessChatGate()(socketConnection({ id: `conn-${id}`, send: () => {} }), chatRequest(id, text, { before }));
  await settled.promise;
  const request = received.at(-1);

  if (request === undefined) throw new Error(`turn ${id} never called its model`);

  return calls.length === 0 ? request : received[0] ?? request;
}

function messageText(message: Prompt[number]): string {
  return v.is(v.string(), message.content)
    ? message.content
    : message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
}

/** Each message as its role, or `dynamic` for a state block. */
function messageOrder(prompt: Prompt): string[] {
  return prompt.map((message) => messageText(message).startsWith(DYNAMIC_CONTEXT_OPEN_TAG) ? 'dynamic' : `${message.role}:${messageText(message)}`);
}

/** Two turns, the object reactivated over the same storage in between, `gapMs` of clock apart from `start`. */
async function acrossRestart(gapMs: number, start = NOON): Promise<{ readonly before: Prompt; readonly after: Prompt }> {
  setSystemTime(new Date(start));
  const first = orchestratorHarness();
  await first.agent.activateActor();
  const before = await turn(first.agent, 'first', 'hello one');

  const next = await reactivateOrchestratorHarness(first.db);
  await next.agent.activateActor();
  setSystemTime(new Date(start + gapMs));

  return { before, after: await turn(next.agent, 'second', 'hello two') };
}

/** The owner's mailbox as a turn reads it: the unread threads `unread` holds when asked. */
function mailbox(unread: () => readonly MailThreadSummary[]) {
  return {
    holdsAddress: async () => true,
    findFor: async (): Promise<MailListing> => ({ threads: unread(), unread: unread().length }),
  };
}

const THREAD = {
  id: 't-1', path: 'inbox', subject: 'Your flight to Lisbon is confirmed', from: [{ name: null, address: 'bookings@example.com' }],
  snippet: 'Booking reference KX4P', sender: { name: null, address: 'bookings@example.com' }, at: NOON, count: 1, unread: true,
  verified: true, attachments: false, important: null, trashedAt: null, draft: false, outgoing: false,
} as const satisfies MailThreadSummary;

describe('what a turn reads that is no agent event', () => {
  afterEach(() => { setSystemTime(); });

  test('changed between two turns, it rides tail blocks: the system prompt and every earlier message stay byte-identical', async () => {
    setSystemTime(new Date(NOON));
    const OWNER = 'abcdef0123456789abcdef0123456789';
    const user = createTestUserDO({ durableObjectId: OWNER });
    const owner = await testOwner();
    const token = await provisionTestWorkspace(user, 'prefix', 'Prefix');
    const threads: MailThreadSummary[] = [];

    const { agent } = orchestratorHarness(undefined, {
      userDO: user.userDO, workspace: 'prefix', ownerUserId: OWNER, mailbox: { domain: 'example.com', owner: mailbox(() => threads) },
    });

    agent.harnessHoldsCapability(token);
    await user.userDO.accountMemory_put(owner, 'home.city', 'Raleigh');
    await user.userDO.accountMemory_put(owner, 'reply.language', 'English');
    await agent.activateActor();
    const before = await turn(agent, 'first', 'Book my Thanksgiving flights.');

    // Between the two asks: the agent keeps a fact over one of the account's, a note and a task, as its own tools write
    // them; the owner changes an account fact; mail arrives.
    await turn(agent, 'keep', 'Keep what you need for the trip.', { calls: [
      { tool: 'memory', args: { op: 'remember', key: 'reply.language', value: 'Portuguese for this client' } },
      { tool: 'memory', args: { op: 'note', content: 'Thanksgiving flights: the owner flies Delta, aisle seat.' } },
      { tool: 'tasks', args: { op: 'add', titles: ['Compare Thanksgiving fares'] } },
    ] });
    await user.userDO.accountMemory_put(owner, 'home.city', 'Austin');
    threads.push(THREAD);
    setSystemTime(new Date(NOON + MINUTE_MS));
    const after = await turn(agent, 'second', 'And the hotel for Thanksgiving?');

    expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
    // Past the first ask, only what the conversation itself added, and state blocks at its tail.
    expect(messageOrder(after.slice(before.length)).filter((entry) => entry !== 'dynamic').at(-1)).toBe('user:And the hotel for Thanksgiving?');
    const told = after.slice(before.length).map(messageText).filter((text) => text.startsWith(DYNAMIC_CONTEXT_OPEN_TAG)).join('\n');

    for (const changed of ['Austin', 'Portuguese for this client', 'Delta, aisle seat', 'Compare Thanksgiving fares', 'Lisbon is confirmed']) {
      expect(told).toContain(changed);
    }

    await user.joinFibers();
    user.close();
  });
});

describe('a file attached to an earlier message', () => {
  afterEach(() => { setSystemTime(); });

  test('is shown from the bytes it was attached with: editing the file between turns leaves every earlier byte as it was', async () => {
    setSystemTime(new Date(NOON));
    const OWNER = 'abcdef0123456789abcdef0123456789';
    const user = createTestUserDO({ durableObjectId: OWNER });
    // A named workspace: an unnamed one takes its first ask as its name, which the system prompt states.
    const token = await provisionTestWorkspace(user, 'pinned', 'Pinned');
    const { agent } = orchestratorHarness(undefined, { userDO: user.userDO, workspace: 'pinned', ownerUserId: OWNER });

    agent.harnessHoldsCapability(token);
    await agent.activateActor();
    const chart = await uploadedFile(agent, 'chart.png', 'image/png', Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const before = await turn(agent, 'first', 'What does this chart show?', { files: [chart] });

    // The file it names is changed afterwards, by an agent's tools or the Files tab: other bytes, another size.
    await workspaceFiles(agent).writeFile(chart.path, new TextEncoder().encode('a different chart, written later'));
    setSystemTime(new Date(NOON + MINUTE_MS));
    const after = await turn(agent, 'second', 'And the trend?');

    // Message by message, so a difference names the one it is in.
    expect(after.slice(0, before.length).map((message) => JSON.stringify(message))).toEqual(before.map((message) => JSON.stringify(message)));
  });
});

describe('the dynamic context across an object restart', () => {
  afterEach(() => { setSystemTime(); });

  test('with the prompt cache warm, the block keeps its position and the prefix stays byte-identical', async () => {
    const { before, after } = await acrossRestart(MINUTE_MS);

    expect(messageOrder(before)).toEqual([expect.stringMatching(/^system:/u), 'dynamic', 'user:hello one']);
    expect(messageOrder(after)).toEqual([
      expect.stringMatching(/^system:/u), 'dynamic', 'user:hello one', 'assistant:answer first', 'user:hello two',
    ]);
    // As bytes: `toEqual` ignores key order and undefined fields, which the wire does not.
    expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
  });

  // 2026-10-08, armada runs straddling 00:00 UTC: the second turn stated the new date, which the case above read as a
  // change it could not explain.
  test('a turn after midnight states the new date in a block of its own, the prefix still byte-identical', async () => {
    const { before, after } = await acrossRestart(MINUTE_MS, Date.parse('2026-10-07T23:59:59.000Z'));

    expect(messageOrder(after)).toEqual([
      expect.stringMatching(/^system:/u), 'dynamic', 'user:hello one', 'assistant:answer first', 'dynamic', 'user:hello two',
    ]);
    expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
    expect(after.filter((message) => messageText(message).startsWith(DYNAMIC_CONTEXT_OPEN_TAG)).map(messageText))
      .toEqual([expect.stringContaining('2026-10-07'), expect.stringContaining('2026-10-08')]);
  });

  test('with the prompt cache expired, the stored blocks go and the state is stated once, before the new input', async () => {
    const { after } = await acrossRestart(3 * 60 * MINUTE_MS);

    expect(messageOrder(after)).toEqual([
      expect.stringMatching(/^system:/u), 'user:hello one', 'assistant:answer first', 'dynamic', 'user:hello two',
    ]);
  });
});
