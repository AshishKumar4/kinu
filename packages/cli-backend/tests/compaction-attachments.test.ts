/**
 * Every compaction path on the CLI moves older screenshots out to links the file tool opens again, keeps the newest
 * two, and prices images for the model serving the request. The turn runs on Claude, which prices a 1280x800
 * screenshot at 1,334 tokens; its fallback, gpt-4o-mini, at 36,835 (tile pricing). Twenty fit Claude's window, so
 * only a request the fallback serves, or a search node on gpt-4o-mini, compacts them.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APICallError } from 'ai';
import type { LanguageModelV2CallOptions, LanguageModelV2StreamPart } from '@ai-sdk/provider';
import {
  buildBuiltinTools, initWorkspaceSchema, profileCatalogDigest, type JsonValue, type ProfileCatalogEnvelope,
} from '@kinu.run/core';
import { present, scratchDir, scratchPath, toolExecute, workspaceDatabase } from '@kinu.run/test-utils';
import { screenshot } from '../../compaction/tests/helpers';
import { createCLIRuntime, makeWorkspaceSchemaSql, type CLIRuntime } from '../src/runtime';
import { LocalAgentSession } from '../src/local-session';
import type { LocalModelResolver } from '../src/model-resolver';
import { TestLanguageModelV2 } from './test-language-model';
import { DUMMY_LLM, fakeModel, namedSpec, resolverRest, SEARCH_ASK, SEARCH_TASK, textStream, toolCallStream } from './helpers/local-session';

const PRIMARY = 'anthropic/claude-sonnet-4-5';

const FALLBACK = 'openai/gpt-4o-mini';

const WINDOW = 128_000;

const SHOTS = 20;

const ASK = `Check each of the ${String(SHOTS)} settings screens and tell me which shows an error.`;

const THANKS = 'Thanks.';

const FOLLOW_UP = 'What did the error say?';

const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

type Prompt = LanguageModelV2CallOptions['prompt'];

const LINK = /→ (vfs:\/\/[^\]\s"\\]+)\]/gu;

/** What a request carried: the screenshots still inline, by number, and the links left for the others. */
function carried(prompt: Prompt) {
  const sent = JSON.stringify(prompt);

  return {
    inline: Array.from({ length: SHOTS }, (_, n) => n).filter((n) => sent.includes(screenshot(n))),
    links: [...new Set([...sent.matchAll(LINK)].map((match) => match[1] ?? ''))],
  };
}

/** The screenshots each link opens to, through the workspace's own file tool. */
async function reopened(rt: CLIRuntime, links: readonly string[]): Promise<number[]> {
  const file = present(buildBuiltinTools({ rt, conversations: rt.stores.conversationSearch }).file, 'the file tool');
  const read = toolExecute<JsonValue, JsonValue>(file);
  const shown = present(file.toModelOutput, 'the image output');

  return await Promise.all(links.map(async (path) => {
    const output = JSON.stringify(await shown({ toolCallId: path, input: {}, output: await read({ op: 'read', path }) }));

    return Array.from({ length: SHOTS }, (_, n) => n).find((n) => output.includes(screenshot(n))) ?? -1;
  }));
}

/** Twenty file reads in one step, as a model checking every screen asks for them. */
function screenReads(): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });

      for (let n = 0; n < SHOTS; n++) {
        controller.enqueue({ type: 'tool-call', toolCallId: `shot_${String(n)}`, toolName: 'file', input: JSON.stringify({ op: 'read', path: `shots/screen-${String(n)}.png` }) });
      }

      controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage });
      controller.close();
    },
  });
}

function refusal(): APICallError {
  return new APICallError({ message: 'rate limited', url: 'https://api.anthropic.com/v1/messages', requestBodyValues: {}, statusCode: 429, isRetryable: true });
}

const answer = (stream: ReadableStream<LanguageModelV2StreamPart>) => ({ stream, response: { headers: {} } });

/** The owner's conversation so far: the screens read and answered, then a thanks, so they sit before the kept tail. */
function conversationTurn(prompt: Prompt) {
  const sent = JSON.stringify(prompt);

  if (sent.includes(THANKS)) return answer(textStream('Glad to help.', usage));

  return answer(prompt.some((message) => message.role === 'tool') ? textStream('Screen 7 shows the error.', usage) : screenReads());
}

/** A workspace folder holding the screenshots, and a session whose default tier is Claude falling back to gpt-4o-mini. */
function workspace(models: { readonly primary: TestLanguageModelV2; readonly fallback: TestLanguageModelV2 }) {
  const cwd = scratchDir('compaction-attachments');
  const db = workspaceDatabase(scratchPath('compaction-attachments', 'agent.db'));
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { cwd, llm: DUMMY_LLM });

  mkdirSync(join(cwd, 'shots'), { recursive: true });

  for (let n = 0; n < SHOTS; n++) writeFileSync(join(cwd, 'shots', `screen-${String(n)}.png`), Buffer.from(screenshot(n), 'base64'));

  const resolver: LocalModelResolver = {
    normalizeSpecSync: (spec) => namedSpec(spec) ?? PRIMARY,
    resolveModel: (spec) => (spec === FALLBACK ? models.fallback : models.primary),
    listProviders: async () => [],
    listModels: async () => ({ models: [], failures: [] }),
    modelInfo: async (spec) => ({ id: spec ?? PRIMARY, label: spec ?? PRIMARY, capabilities: ['tools', 'streaming'], contextWindow: WINDOW }),
    ...resolverRest,
  };

  const catalog = { roles: {}, betaSwarms: true, tiers: { default: { model: PRIMARY, fallbacks: [FALLBACK] }, fast: { model: FALLBACK } } };
  const envelope: ProfileCatalogEnvelope = { authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog };

  rt.actor.config.setLearning(false);

  const session = new LocalAgentSession({ rt, db, model: fakeModel('unused'), modelResolver: resolver, profileAuthority: () => envelope, onEvent: () => {} });

  return { rt, session };
}

describe('older screenshots leave as links, priced for the model serving the request', () => {
  test('a turn its Claude model is refused falls back to gpt-4o-mini, which is sent the newest two and links to the rest', async () => {
    const asked = { primary: new Array<Prompt>(), fallback: new Array<Prompt>() };

    const primary = new TestLanguageModelV2({
      provider: 'fake', modelId: 'claude-sonnet-4-5',
      doStream: async ({ prompt }) => {
        if (!JSON.stringify(prompt).includes(FOLLOW_UP)) return conversationTurn(prompt);
        asked.primary.push(prompt);

        throw refusal();
      },
    });

    const fallback = new TestLanguageModelV2({
      provider: 'fake', modelId: 'gpt-4o-mini',
      doStream: async ({ prompt }) => {
        asked.fallback.push(prompt);

        return answer(textStream('It said the disk is full.', usage));
      },
    });

    const { rt, session } = workspace({ primary, fallback });

    try {
      for (const words of [ASK, THANKS, FOLLOW_UP]) await session.send(words, { id: crypto.randomUUID() });
    } finally {
      await session.end();
    }

    const refused = carried(present(asked.primary[0], 'the request Claude refused'));
    const served = carried(present(asked.fallback[0], 'the request gpt-4o-mini served'));

    expect(refused).toEqual({ inline: Array.from({ length: SHOTS }, (_, n) => n), links: [] });
    expect(served.inline).toEqual([SHOTS - 2, SHOTS - 1]);
    expect((await reopened(rt, served.links)).sort((a, b) => a - b)).toEqual(Array.from({ length: SHOTS - 2 }, (_, n) => n));
  });

  test('a search on the fast tier inherits the conversation priced for its gpt-4o-mini nodes', async () => {
    const nodes: Prompt[] = [];

    const primary = new TestLanguageModelV2({
      provider: 'fake', modelId: 'claude-sonnet-4-5',
      doStream: async ({ prompt }) => {
        if (!JSON.stringify(prompt).includes(SEARCH_ASK)) return conversationTurn(prompt);
        const searched = prompt.some((message) => message.role === 'tool' && JSON.stringify(message.content).includes('agents'));

        return answer(searched ? textStream('Searched.', usage) : toolCallStream('agents', {
          op: 'swarm', task: SEARCH_TASK, preset: 'custom', from: 'ideate', label: 'inherited-screens', tier: 'fast', branches: 1,
          config: { context: 'inherit' },
        }, usage));
      },
    });

    const fallback = new TestLanguageModelV2({
      provider: 'fake', modelId: 'gpt-4o-mini',
      doStream: async ({ prompt }) => {
        nodes.push(prompt);

        return answer(textStream('Tokenize with a lookup table.', usage));
      },
    });

    const { rt, session } = workspace({ primary, fallback });

    try {
      for (const words of [ASK, THANKS, SEARCH_ASK]) await session.send(words, { id: crypto.randomUUID() });
      await session.settleBackgroundWork();
    } finally {
      await session.end();
    }

    const node = carried(present(nodes[0], 'the search node\'s request'));

    expect(node.inline).toEqual([SHOTS - 2, SHOTS - 1]);
    expect((await reopened(rt, node.links)).sort((a, b) => a - b)).toEqual(Array.from({ length: SHOTS - 2 }, (_, n) => n));
  });

  test('a search node its Claude model refuses falls back to gpt-4o-mini, which is sent the newest two and links to the rest', async () => {
    const asked = { primary: new Array<Prompt>(), fallback: new Array<Prompt>() };

    const primary = new TestLanguageModelV2({
      provider: 'fake', modelId: 'claude-sonnet-4-5',
      doStream: async ({ prompt, tools }) => {
        // A node is offered no `agents` tool: it delegates nothing.
        if (!(tools ?? []).some((tool) => tool.name === 'agents')) {
          asked.primary.push(prompt);

          throw refusal();
        }

        if (!JSON.stringify(prompt).includes(SEARCH_ASK)) return conversationTurn(prompt);
        const searched = prompt.some((message) => message.role === 'tool' && JSON.stringify(message.content).includes('agents'));

        return answer(searched ? textStream('Searched.', usage) : toolCallStream('agents', {
          op: 'swarm', task: SEARCH_TASK, preset: 'custom', from: 'ideate', label: 'inherited-screens', branches: 1,
          config: { context: 'inherit' },
        }, usage));
      },
    });

    const fallback = new TestLanguageModelV2({
      provider: 'fake', modelId: 'gpt-4o-mini',
      doStream: async ({ prompt }) => {
        asked.fallback.push(prompt);

        return answer(textStream('Tokenize with a lookup table.', usage));
      },
    });

    const { rt, session } = workspace({ primary, fallback });

    try {
      for (const words of [ASK, THANKS, SEARCH_ASK]) await session.send(words, { id: crypto.randomUUID() });
      await session.settleBackgroundWork();
    } finally {
      await session.end();
    }

    const refused = carried(present(asked.primary[0], 'the node request Claude refused'));
    const served = carried(present(asked.fallback[0], 'the node request gpt-4o-mini served'));

    expect(refused).toEqual({ inline: Array.from({ length: SHOTS }, (_, n) => n), links: [] });
    expect(served.inline).toEqual([SHOTS - 2, SHOTS - 1]);
    expect((await reopened(rt, served.links)).sort((a, b) => a - b)).toEqual(Array.from({ length: SHOTS - 2 }, (_, n) => n));
  });
});
