/**
 * Every compaction path on cf (the workspace's chat, an added agent's chat and a search node, each in its own
 * isolate, and a search's inherited prefix) moves older screenshots out to links the file tool opens again, keeps the
 * newest two, and prices images for the model serving the request. The turns run on Claude, which prices a 1280x800 screenshot at
 * 1,334 tokens; its fallback, gpt-4o-mini, at 36,835 (tile pricing). Twenty fit Claude's window, so only a request the
 * fallback serves, or a search node on gpt-4o-mini, compacts them.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { actorConnectionTag, buildBuiltinTools, type JsonValue } from '@kinu.run/core';
import { present, toolExecute } from '@kinu.run/test-utils';
import { screenshot } from '../../compaction/tests/helpers';
import { conversationsFor } from '../../core/tests/helpers';
import { asPane } from './helpers/agents-sdk';
import { catalogTurn, driveUntil, hostedMainActor, orchestratorHarness, workspaceFiles, type HarnessOrchestratorAgent } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun } from './helpers/platform-gateway';

const PRIMARY = 'ai-gateway/workers-ai/@cf/harness/claude-sonnet-4-5';

const FALLBACK = 'ai-gateway/workers-ai/@cf/harness/gpt-4o-mini';

const WINDOW = 128_000;

const SHOTS = 20;

const ASK = `Check each of the ${String(SHOTS)} settings screens and tell me which shows an error.`;

const THANKS = 'Thanks.';

const FOLLOW_UP = 'What did the error say?';

const SEARCH_ASK = 'Find a faster way to tokenize the settings files.';

const SEARCH_TASK = 'Name one way to make tokenizing faster.';

const LINK = /→ (vfs:\/\/[^\]\s"\\]+)\]/gu;

const ModelSchema = v.looseObject({ model: v.string() });

/** What a request carried: the screenshots still inline, by number, and the links left for the others. */
function carried(sent: string) {
  return {
    inline: Array.from({ length: SHOTS }, (_, n) => n).filter((n) => sent.includes(screenshot(n))),
    links: [...new Set([...sent.matchAll(LINK)].map((match) => match[1] ?? ''))],
  };
}

/** The screenshots each link opens to, through the workspace's own file tool. */
async function reopened(workspace: Parameters<typeof hostedMainActor>[0], links: readonly string[]): Promise<number[]> {
  const rt = (await hostedMainActor(workspace)).actor.runtime;
  const file = present(buildBuiltinTools({ rt, conversations: conversationsFor(rt) }).file, 'the file tool');
  const read = toolExecute<JsonValue, JsonValue>(file);
  const shown = present(file.toModelOutput, 'the image output');

  const numbers = await Promise.all(links.map(async (path) => {
    const output = JSON.stringify(await shown({ toolCallId: path, input: {}, output: await read({ action: 'read', path }) }));

    return Array.from({ length: SHOTS }, (_, n) => n).find((n) => output.includes(screenshot(n))) ?? -1;
  }));

  return numbers.sort((a, b) => a - b);
}

const EARLIER = Array.from({ length: SHOTS - 2 }, (_, n) => n);

const ALL = Array.from({ length: SHOTS }, (_, n) => n);

/** Which model a request was sent to, by the spec's own model id. */
function servedBy(run: RecordedGatewayRun, spec: string): boolean {
  return spec.endsWith(v.parse(ModelSchema, run.query).model.split('/').at(-1) ?? '');
}

/** A refusal its provider would retry: the turn hands over to its fallback at once. */
function refused(): Response {
  return Response.json({ error: { message: 'rate limited', type: 'rate_limit' } }, { status: 429, headers: { 'retry-after-ms': '1' } });
}

/** The conversation so far: every screen read, one per step, then answered, then a thanks, so they sit before the kept
 *  tail. A call with no tools is a side lane, answered in a word. */
function conversationTurn(run: RecordedGatewayRun, sent: string): Response {
  const { messages, tools } = requestOf(run);

  if (tools.length === 0) return chatCompletion(run, 'ok');

  if (sent.includes(THANKS)) return chatCompletion(run, 'Glad to help.');
  const step = messages.filter((message) => message.role === 'tool').length;

  return step < SHOTS
    ? toolCallCompletion(run, { tool: 'file', args: { action: 'read', path: `/home/main/shots/screen-${String(step)}.png` } }, `shot_${String(step)}`)
    : chatCompletion(run, 'Screen 7 shows the error.');
}

/** Claude answers the conversation and is refused the follow-up, which gpt-4o-mini answers; `asked` keeps the two
 *  turn requests for it. */
function fallingBack(asked: { readonly primary: string[]; readonly fallback: string[] }) {
  return (run: RecordedGatewayRun): Response => {
    const sent = JSON.stringify(run.query);
    const turn = sent.includes(FOLLOW_UP) && requestOf(run).tools.length > 0;

    if (servedBy(run, FALLBACK)) {
      if (turn) asked.fallback.push(sent);

      return chatCompletion(run, 'It said the disk is full.');
    }

    if (!sent.includes(FOLLOW_UP)) return conversationTurn(run, sent);

    if (turn) asked.primary.push(sent);

    return refused();
  };
}

/** A request a search node is sent: its seed names its task, and it is offered no `agents` tool. */
function nodeRequest(run: RecordedGatewayRun, sent: string): boolean {
  return sent.includes(SEARCH_TASK) && !requestOf(run).tools.includes('agents');
}

/** The search call, once per conversation: an inheriting one-node `ideate`, on `tier` when named. */
function searchTurn(run: RecordedGatewayRun, tier?: string): Response {
  const searched = JSON.stringify(requestOf(run).messages).includes('"name":"agents"');

  return searched ? chatCompletion(run, 'Searched.') : toolCallCompletion(run, {
    tool: 'agents',
    args: { action: 'swarm', task: SEARCH_TASK, preset: 'custom', from: 'ideate', label: 'inherited-screens', branches: 1, config: { context: 'inherit' }, ...(tier !== undefined && { tier }) },
  }, 'search_0');
}

/** The conversation, then a search on the fast tier, whose node requests land in `nodes`. */
function fastSearch(nodes: string[]) {
  return (run: RecordedGatewayRun): Response => {
    const sent = JSON.stringify(run.query);

    if (nodeRequest(run, sent)) {
      nodes.push(sent);

      return chatCompletion(run, 'Tokenize with a lookup table.');
    }

    return sent.includes(SEARCH_ASK) && requestOf(run).tools.length > 0 ? searchTurn(run, 'fast') : conversationTurn(run, sent);
  };
}

/** A workspace holding the screenshots whose default tier is Claude falling back to gpt-4o-mini, and a fast tier on it. */
async function screenshotWorkspace(respond: (run: RecordedGatewayRun) => Response) {
  const workspace = orchestratorHarness(undefined, { aiGateway: stubAiBinding(respond) });

  workspace.agent.harnessInstallCatalog({
    tiers: { default: { model: PRIMARY, fallbacks: [FALLBACK] }, deep: { model: PRIMARY }, fast: { model: FALLBACK } },
    availableModels: [PRIMARY, FALLBACK],
  });
  workspace.agent.harnessCatalogModels({ [PRIMARY]: { contextWindow: WINDOW }, [FALLBACK]: { contextWindow: WINDOW } });
  const files = workspaceFiles(workspace.agent);

  for (let n = 0; n < SHOTS; n++) await files.writeFile(`/home/main/shots/screen-${String(n)}.png`, Buffer.from(screenshot(n), 'base64'));

  return workspace;
}

/** An added agent, and the owner's words in its own pane. */
async function addedAgent(agent: HarnessOrchestratorAgent) {
  await agent.setSoul('# Purpose\n\nCheck the settings screens.');
  const { subordinate } = await agent.createSubordinateAgent();
  const pane = [actorConnectionTag(subordinate.actorId ?? '')];

  return async (text: string): Promise<void> => {
    await asPane(pane, () => agent.send(text, crypto.randomUUID()));
    await agent.harnessAgentsIdle();
  };
}

describe('older screenshots leave as links, priced for the model serving the request', () => {
  test('a workspace turn its Claude model is refused falls back to gpt-4o-mini, sent the newest two and links to the rest', async () => {
    const asked = { primary: new Array<string>(), fallback: new Array<string>() };
    const workspace = await screenshotWorkspace(fallingBack(asked));

    for (const words of [ASK, THANKS, FOLLOW_UP]) await catalogTurn(workspace.agent, words);

    const served = carried(present(asked.fallback[0], 'the request gpt-4o-mini served'));

    expect(carried(present(asked.primary[0], 'the request Claude refused'))).toEqual({ inline: ALL, links: [] });
    expect(served.inline).toEqual([SHOTS - 2, SHOTS - 1]);
    expect(await reopened(workspace, served.links)).toEqual(EARLIER);
  });

  test("an added agent's turn its Claude model is refused falls back to gpt-4o-mini, sent the newest two and links to the rest", async () => {
    const asked = { primary: new Array<string>(), fallback: new Array<string>() };
    const workspace = await screenshotWorkspace(fallingBack(asked));

    const say = await addedAgent(workspace.agent);

    for (const words of [ASK, THANKS, FOLLOW_UP]) await say(words);
    await driveUntil(workspace, 'gpt-4o-mini never answered the agent', () => asked.fallback.length > 0);

    const served = carried(present(asked.fallback[0], 'the request gpt-4o-mini served'));

    expect(carried(present(asked.primary[0], 'the request Claude refused'))).toEqual({ inline: ALL, links: [] });
    expect(served.inline).toEqual([SHOTS - 2, SHOTS - 1]);
    expect(await reopened(workspace, served.links)).toEqual(EARLIER);
  });

  test('a search node its Claude model refuses falls back to gpt-4o-mini, sent the newest two and links to the rest', async () => {
    const asked = { primary: new Array<string>(), fallback: new Array<string>() };

    const workspace = await screenshotWorkspace((run) => {
      const sent = JSON.stringify(run.query);

      if (nodeRequest(run, sent)) {
        (servedBy(run, FALLBACK) ? asked.fallback : asked.primary).push(sent);

        return servedBy(run, FALLBACK) ? chatCompletion(run, 'Tokenize with a lookup table.') : refused();
      }

      return sent.includes(SEARCH_ASK) && requestOf(run).tools.length > 0 ? searchTurn(run) : conversationTurn(run, sent);
    });

    for (const words of [ASK, THANKS, SEARCH_ASK]) await catalogTurn(workspace.agent, words);
    await driveUntil(workspace, 'the search node never reached gpt-4o-mini', () => asked.fallback.length > 0);

    const served = carried(present(asked.fallback[0], 'the node request gpt-4o-mini served'));

    expect(carried(present(asked.primary[0], 'the node request Claude refused'))).toEqual({ inline: ALL, links: [] });
    expect(served.inline).toEqual([SHOTS - 2, SHOTS - 1]);
    expect(await reopened(workspace, served.links)).toEqual(EARLIER);
  });

  test('a search on the fast tier inherits the workspace conversation priced for its gpt-4o-mini nodes', async () => {
    const nodes: string[] = [];
    const workspace = await screenshotWorkspace(fastSearch(nodes));

    for (const words of [ASK, THANKS, SEARCH_ASK]) await catalogTurn(workspace.agent, words);
    await driveUntil(workspace, 'the search node never ran', () => nodes.length > 0);

    const node = carried(present(nodes[0], 'the search node\'s request'));

    expect(node.inline).toEqual([SHOTS - 2, SHOTS - 1]);
    expect(await reopened(workspace, node.links)).toEqual(EARLIER);
  });
});
