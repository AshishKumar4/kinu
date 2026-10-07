import { scratchDir } from '../../test-utils/src/scratch';
import { AwaitedList, present, readTranscriptRows, workspaceDatabase } from '@kinu.run/test-utils';
import { existsSync } from 'node:fs';

import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import type { LanguageModelV2CallOptions, LanguageModelV2Prompt } from '@ai-sdk/provider';
import * as v from 'valibot';
import {
  NO_COUNT_ENDPOINT, openWorkspaceMainActor, profileCatalogDigest, type LLMProviderConfig, type ProfileCatalog, type ProfileCatalogEnvelope,
} from '@kinu.run/core';
import { initWorkspaceSchema, WORKSPACE_RUN_ID } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { createCLIRuntime, makeSql, type LocalModelResolver , makeWorkspaceSchemaSql } from '@kinu.run/cli-backend';
import { TestLanguageModelV2 } from '../../cli-backend/tests/test-language-model';
import { LocalAgentClient } from '../src/local-agent-client';
import type { CliSessionOptions } from '../src/session';
import type { AgentClientEvent } from '../src/agent-client';

type CliProfileSource = () => Promise<ProfileCatalogEnvelope | null>;

const DUMMY_LLM: LLMProviderConfig = {
  name: 'openai-compat', baseURL: 'http://localhost:0', headers: { Authorization: 'x' }, model: 'fake-model',
};

interface SummaryScript {
  readonly onCall?: () => void | Promise<void>;
  readonly fail?: Error;
}

function fakeModel(answer: string, onPrompt?: (prompt: LanguageModelV2Prompt) => void, summary: SummaryScript = {}): LanguageModel {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  const [a, b] = [answer.slice(0, answer.length >> 1), answer.slice(answer.length >> 1)];

  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doGenerate: async () => {
      await summary.onCall?.();

      if (summary.fail) throw summary.fail;

      return { content: [{ type: 'text', text: '## Decisions\n- the parts were looked into in order' }], finishReason: 'stop', usage, warnings: [] };
    },
    doStream: async (options) => {
      onPrompt?.(options.prompt);

      return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: '0' });
          controller.enqueue({ type: 'text-delta', id: '0', delta: a });
          controller.enqueue({ type: 'text-delta', id: '0', delta: b });
          controller.enqueue({ type: 'text-end', id: '0' });
          controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
          controller.close();
        },
      }),
      response: { headers: {} },
      };
    },
  });
}

/** A fake that answers `answer` and hands each streamed request's options to `onRequest`. */
function providerOptionsModel(answer: string, onRequest: (options: LanguageModelV2CallOptions) => void): LanguageModel {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async (options) => {
      onRequest(options);

      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: '0' });
            controller.enqueue({ type: 'text-delta', id: '0', delta: answer });
            controller.enqueue({ type: 'text-end', id: '0' });
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
            controller.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });
}

/** The server-side compaction trigger a request asked for, or null. */
function compactionTrigger(options: LanguageModelV2CallOptions): number | null {
  const asked = v.safeParse(v.object({ anthropic: v.object({ contextManagement: v.object({ edits: v.tuple([v.object({ trigger: v.object({ value: v.number() }) })]) }) }) }), options.providerOptions);

  return asked.success ? asked.output.anthropic.contextManagement.edits[0].trigger.value : null;
}

function reasoningModel(thought: string, answer: string): LanguageModel {
  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'reasoning-start', id: 'r' });
          controller.enqueue({ type: 'reasoning-delta', id: 'r', delta: thought });
          controller.enqueue({ type: 'reasoning-end', id: 'r' });
          controller.enqueue({ type: 'text-start', id: '0' });
          controller.enqueue({ type: 'text-delta', id: '0', delta: answer });
          controller.enqueue({ type: 'text-end', id: '0' });
          controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 } });
          controller.close();
        },
      }),
      response: { headers: {} },
    }),
  });
}

function stallingModel(): LanguageModel {
  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: '0' });
          controller.enqueue({ type: 'text-delta', id: '0', delta: 'partial ' });
          abortSignal?.addEventListener('abort', () => {
            controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          }, { once: true });
        },
      }),
      response: { headers: {} },
    }),
  });
}

function fakeResolver(model: LanguageModel): LocalModelResolver {
  return {
    normalizeSpecSync: (spec: string | null | undefined) => {
        const trimmed = spec?.trim();

        return trimmed === undefined || trimmed === '' ? 'fake/fake-model' : trimmed;
      },
    resolveModel: () => model,
    credentialFor: async () => null,
    listProviders: async () => [{ id: 'fake', label: 'Fake', available: true }],
    listModels: async () => ({
      models: ['fake-model', 'big-model', 'pinned-model'].map((id) => ({ id, label: id, provider: 'fake' })), failures: [],
    }),
    // Claude's row as models.dev lists it: server-side compaction is sized against its window.
    modelInfo: async (spec) => (spec === 'anthropic/claude-opus-4-7' ? { id: 'claude-opus-4-7', contextWindow: 1_000_000 } : null),
    getAuth: async () => null,
    // The fake vendor has no count endpoint, so the turn is assembled ungated.
    countInputTokens: async () => ({
      kind: 'unsupported' as const,
      provider: 'fake',
      reason: NO_COUNT_ENDPOINT,
    }),
  };
}

function nextContextFill(client: LocalAgentClient): Promise<number> {
  const fill = Promise.withResolvers<number>();

  const unsubscribe = client.subscribe((event) => {
    if (event.type === 'broadcast' && event.event.type === 'context_fill' && event.event.contextTokens !== undefined) {
      unsubscribe();
      fill.resolve(event.event.contextTokens);
    }
  });

  return fill.promise;
}

function gateMeasures(home: string): number {
  const db = new Database(join(home, 'agent.db'), { readonly: true });
  const rows = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_events WHERE type = 'context_admitted'").get()?.n ?? 0;
  db.close();

  return rows;
}

function asksSentWith(prompts: readonly LanguageModelV2Prompt[], ask: string): string[] {
  return (prompts.filter((prompt) => JSON.stringify(prompt.at(-1)).includes(ask)).at(-1) ?? [])
    .flatMap((message) => (message.role === 'user' ? message.content : []))
    .flatMap((part) => (part.type === 'text' && part.text.startsWith('look into part') ? [part.text] : []));
}

function gateSizes(client: LocalAgentClient): number[] {
  const sizes: number[] = [];

  client.subscribe((event) => {
    // A turn's own measures; the interactive session's start-up measure is the workspace's row.
    if (event.type === 'run-event' && event.event.type === 'context_admitted' && event.event.runId !== WORKSPACE_RUN_ID && event.event.tokens !== null) {
      sizes.push(event.event.tokens);
    }
  });

  return sizes;
}

function setup(model: LanguageModel, profileAuthority: CliProfileSource = async () => null) {
  const home = scratchDir('client');
  const dbPath = join(home, 'agent.db');
  const db = workspaceDatabase(dbPath, { create: true });
  // The production initializer, not a copy of its DDL.
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { llm: DUMMY_LLM, cwd: scratchDir('client-folder') });
  rt.actor.config.setLearning(false);
  // Its model calls would count as summaries here; the shared-backend suite covers it.
  rt.actor.config.setSleepTimeComputeEnabled(false);

  const info = {
    id: 'agent-1', name: 'jarvis', purpose: 'test agent', soul: '', scaffoldVersion: 1,
    searchNodeCount: 0, memorySize: 0, createdAt: Date.now(),
  };

  const client = new LocalAgentClient({
    agentName: 'jarvis',
    rt,
    db,
    dbPath,
    info,
    refreshInfo: async () => info,
    model,
    modelResolver: fakeResolver(model),
    profileAuthority,
    mcpServers: {},
    transcript: { transcriptDir: join(home, 'sessions') },
    surface: 'interactive',
  });

  return { client, home, rt };
}

function openPersistentClient(
  home: string,
  model: LanguageModel,
  transcriptOptions: CliSessionOptions,
): LocalAgentClient {
  const dbPath = join(home, 'agent.db');
  const db = workspaceDatabase(dbPath);
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { llm: DUMMY_LLM, cwd: scratchDir('client-folder') });
  rt.actor.config.setLearning(false);

  const info = {
    id: 'agent-1', name: 'jarvis', purpose: 'test agent', soul: '', scaffoldVersion: 1,
    searchNodeCount: 0, memorySize: 0, createdAt: Date.now(),
  };

  return new LocalAgentClient({
    agentName: 'jarvis',
    rt,
    db,
    dbPath,
    info,
    refreshInfo: async () => info,
    model,
    modelResolver: fakeResolver(model),
    profileAuthority: async () => null,
    mcpServers: {},
    transcript: transcriptOptions,
    surface: 'interactive',
  });
}

describe('LocalAgentClient', () => {
  test('send streams events, returns the turn result, and records the JSONL log', async () => {
    const { client } = setup(fakeModel('hello there'));
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));
    await client.connect();

    const result = await client.send('hi', { cwd: '/work' });

    if (result.landed !== 'turn') throw new Error('an idle agent runs the message as its own turn');
    expect(result.text, JSON.stringify(events)).toBe('hello there');
    expect(result.hadError).toBe(false);

    // An interactive session records its start-up measure, the workspace's row, before it takes the message.
    const types = events.flatMap((event) => (event.type === 'run-event' && event.event.runId === WORKSPACE_RUN_ID) || event.type === 'broadcast'
      ? [] : [event.type]);


    expect(types).toContain('text-delta');
    expect(types).toContain('turn-end');
    const streamed = events.flatMap((event) => event.type === 'text-delta' ? [event.delta] : []).join('');
    expect(streamed).toBe('hello there');

    const history = await client.history();
    expect(history.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(history[0].content).toBe('hi');
    expect(history[1].content).toBe('hello there');
    await client.close();
  });

  test('the diagnostic recorder never chooses or disables the durable conversation', async () => {
    const home = scratchDir('client-persistent');
    const transcriptDir = join(home, 'sessions');

    const unrecorded = openPersistentClient(home, fakeModel('first answer'), {
      noTranscript: true,
      transcriptDir,
    });

    await unrecorded.connect();
    await unrecorded.send('first question');
    await unrecorded.close();
    expect(existsSync(transcriptDir)).toBe(false);

    let prompt: LanguageModelV2Prompt = [];

    const recorded = openPersistentClient(
      home,
      fakeModel('second answer', (next) => { prompt = next; }),
      { transcriptDir },
    );

    await recorded.connect();
    await recorded.send('second question');
    expect(JSON.stringify(prompt)).toContain('first question');
    expect(JSON.stringify(prompt)).toContain('first answer');
    expect(recorded.cliSession.mode).toBe('record');
    await recorded.close();

    const db = workspaceDatabase(join(home, 'agent.db'));
    const sql = makeSql(db);
    const actorId = openWorkspaceMainActor(sql).actorId;

    const sessions = sql<{ session_id: string }>`
      SELECT DISTINCT session_id FROM conversation_entries WHERE actor_id = ${actorId} ORDER BY session_id`;

    const conversation = db.query<{ value: string }, []>(
      "SELECT value FROM actor_config WHERE key = 'conversation.id'",
    ).get();

    expect(sessions).toEqual([{ session_id: 'default' }]);
    expect(conversation?.value).toBe('default');
    db.close();
  });

  test('workspace chat exposes no selectable session surface', async () => {
    const { client } = setup(fakeModel('answer'));
    await client.connect();
    await client.send('first question');
    expect((await client.history()).map((message) => message.role)).toEqual(['user', 'assistant']);
    await client.close();
  });

  test('stop() aborts the in-flight turn through LocalAgentSession', async () => {
    const { client } = setup(stallingModel());
    const observed = new AwaitedList<AgentClientEvent>();
    const events = observed.items;
    client.subscribe((event) => observed.push(event));
    await client.connect();

    const turn = client.send('long task');
    await observed.until((items) => items.some((event) => event.type === 'text-delta'));

    expect(events.some((event) => event.type === 'text-delta')).toBe(true);

    client.stop();
    const result = await turn;
    // A user's Stop is a choice, not an agent failure: `hadError` stays false while the turn still ends.
    expect(result).toMatchObject({ landed: 'turn', hadError: false });
    expect(events.some((event) => event.type === 'error')).toBe(true);
    await client.close();
  });

  test('send mid-turn records a steered user entry and reaches the agent', async () => {
    // The 'start' turn's first call is a gated tool call: a deterministic window for a mid-turn send.
    // The gate is armed per call; every other call answers at once.
    const prompts: LanguageModelV2Prompt[] = [];
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let armed = false;

    const model = new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
      doStream: async (options) => {
        prompts.push(options.prompt);
        const gated = armed;
        armed = false;

        return {
          stream: new ReadableStream({
            async start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });

              if (gated) {
                controller.enqueue({
                  type: 'tool-call', toolCallId: 'call-1', toolName: 'memory',
                  input: JSON.stringify({ op: 'search', query: 'probe' }),
                });
                await gate;
                controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage });
              } else {
                controller.enqueue({ type: 'text-start', id: '0' });
                controller.enqueue({ type: 'text-delta', id: '0', delta: 'working on it' });
                controller.enqueue({ type: 'text-end', id: '0' });
                controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
              }

              controller.close();
            },
          }),
          response: { headers: {} },
        };
      },
    });

    const { client } = setup(model);
    const observed = new AwaitedList<AgentClientEvent>();
    const events = observed.items;
    client.subscribe((event) => observed.push(event));
    await client.connect();

    expect(await client.send('too early')).toMatchObject({ landed: 'turn' });

    armed = true;
    const turn = client.send('start');
    await observed.until((items) => items.some((event) => event.type === 'tool-call'));

    const steer = client.send('actually, use yaml');
    release();
    await turn;
    expect(await steer).toEqual({ landed: 'mid-turn' });

    const seen = (prompts.at(-1) ?? [])
      .filter((message) => message.role === 'user')
      .flatMap((message) => message.content)
      .filter((part) => part.type === 'text')
      .map((part) => part.text);

    expect(seen).toContain('actually, use yaml');
    expect(events.filter((event) => event.type === 'turn-start')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'turn-end')).toHaveLength(2);

    const history = await client.history();
    const steered = history.find((message) => message.content === 'actually, use yaml');
    expect(steered).toMatchObject({ role: 'user', steered: true });
    await client.close();
  });

  test('a message the running turn ended before reading answers with the turn that ran it', async () => {
    // The armed call is the turn's last step: a message sent while it is held has no step boundary
    // left, so the session reruns it as the operator's next turn.
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let armed = false;
    let calls = 0;

    const model = new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
      doStream: async () => {
        const gated = armed;
        armed = false;
        calls += 1;
        const answer = gated ? 'standing brief, noted' : `answer ${calls}`;

        return {
          stream: new ReadableStream({
            async start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ type: 'text-start', id: '0' });
              controller.enqueue({ type: 'text-delta', id: '0', delta: answer });

              if (gated) await gate;
              controller.enqueue({ type: 'text-end', id: '0' });
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
              controller.close();
            },
          }),
          response: { headers: {} },
        };
      },
    });

    const { client } = setup(model);
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));
    await client.connect();

    armed = true;
    const first = client.send('here is your standing brief');
    await new Promise<void>((resolve) => {
      const unsubscribe = client.subscribe((event) => {
        if (event.type === 'text-delta') { unsubscribe(); resolve(); }
      });
    });
    const second = client.send('list every tool you have');
    const third = client.send('and your version');
    release();

    expect((await first).landed).toBe('turn');
    const result = await second;
    const carried = await third;

    if (carried.landed !== 'turn') throw new Error('a message the turn never read runs as the next turn');
    expect(carried.text).toBe('answer 2');

    if (result.landed !== 'turn') throw new Error('a message the turn never read runs as the next turn');
    expect(result.text).toBe('answer 2');
    expect(events.filter((event) => event.type === 'turn-start')).toHaveLength(2);

    const history = await client.history();
    expect(history.map((message) => [message.role, message.content])).toEqual([
      ['user', 'here is your standing brief'], ['assistant', 'standing brief, noted'],
      ['user', 'list every tool you have\n\nand your version'], ['assistant', 'answer 2'],
    ]);
    expect(history[2]).not.toHaveProperty('steered');
    expect(history[3]).not.toHaveProperty('steered');
    await client.close();
  });

  test('fork walks the conversation back before the picked message and re-points the client', async () => {
    const seenPrompts: string[] = [];
    const model = fakeModel('answer', (prompt) => { seenPrompts.push(JSON.stringify(prompt)); });

    const { client } = setup(model);
    await client.connect();
    await client.send('first question');
    await client.send('second question');
    const originalSessionId = client.cliSession.id;

    const result = await client.fork({ text: 'second question', occurrenceFromEnd: 1 });
    expect(result.client).toBe(client);
    expect(client.cliSession.id).not.toBe(originalSessionId);
    expect(result.label).toBe(`branch ${client.cliSession.id}`);

    await client.send('third question');
    const forkedPrompt = present(seenPrompts.at(-1), 'the last prompt seen');
    expect(forkedPrompt).toContain('first question');
    expect(forkedPrompt).toContain('third question');
    expect(forkedPrompt).not.toContain('second question');

    await expect(client.fork({ text: 'never said', occurrenceFromEnd: 1 }))
      .rejects.toThrow('Could not locate that message');
    await client.close();
  });

  for (const empty of [false, true]) {
    test(`a walked-back seed is durable before the fork's first turn, empty=${empty}`, async () => {
      const seenPrompts: string[] = [];
      const model = fakeModel('answer', (prompt) => { seenPrompts.push(JSON.stringify(prompt)); });
      const { client, home, rt } = setup(model);
      await client.connect();
      await client.send('first question');
      await client.send('second question');
      const pivot = empty ? 'first question' : 'second question';
      await client.fork({ text: pivot, occurrenceFromEnd: 1 });

      const rows = await readTranscriptRows(rt.storage.sql, rt.actor, rt.storage.vfs);

      expect(rows.map((row) => `${row.role}:${row.content}`))
        .toEqual(empty ? [] : ['user:first question', 'assistant:answer']);

      const working = await rt.stores.history.materialize();

      expect(working.messages).toEqual(empty ? [] : [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      ]);
      await client.close();

      const reopened = openPersistentClient(home, model, { transcriptDir: join(home, 'sessions') });

      try {
        await reopened.connect();
        await reopened.send('third question');
        const prompt = present(seenPrompts.at(-1), 'the last prompt seen');
        expect(prompt).toContain('third question');
        expect(prompt).not.toContain('second question');

        if (empty) expect(prompt).not.toContain('first question');
        else expect(prompt).toContain('first question');
      } finally {
        await reopened.close();
      }
    });
  }

  test('before any turn, status names the model and effort the next turn runs at, and a pin wins over the tier', async () => {
    // It named the resolver's bare default and 'medium', so a workspace whose default tier is a big model at max
    // looked like it would run a small one, and the owner re-picked both in every workspace.
    const catalog: ProfileCatalog = { roles: {}, tiers: { default: { model: 'fake/big-model', reasoningEffort: 'max' } } };

    const envelope: ProfileCatalogEnvelope = {
      authority: { kind: 'account', accountId: 'acct' }, version: 1, digest: profileCatalogDigest(catalog), catalog,
    };

    const { client } = setup(fakeModel('ok'), async () => envelope);
    await client.connect();

    expect(await client.status()).toMatchObject({ model: 'fake/big-model', reasoningEffort: 'max', tierId: 'default' });
    await client.setModel('fake/pinned-model');
    expect(await client.status()).toMatchObject({ model: 'fake/pinned-model', reasoningEffort: 'max' });
    await client.close();
  });

  test('a turn\'s reasoning reaches the client as it streams, apart from the answer', async () => {
    const { client } = setup(reasoningModel('check the index first', 'done'));
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));
    await client.connect();

    const result = await client.send('go', { cwd: '/work' });

    expect(events.filter((event) => event.type === 'reasoning-delta')).toEqual([{ type: 'reasoning-delta', delta: 'check the index first' }]);

    if (result.landed !== 'turn') throw new Error('an idle agent runs the message as its own turn');
    expect(result.text).toBe('done');
    await client.close();
  });

  test('/clear starts a new conversation: the transcript and the next prompt hold nothing earlier', async () => {
    const prompts: LanguageModelV2Prompt[] = [];
    const { client } = setup(fakeModel('noted', (prompt) => prompts.push(prompt)));
    await client.connect();
    await client.send('remember the word heron', { cwd: '/work' });

    await client.localControls.clearConversation();
    expect(await client.history()).toEqual([]);
    await client.send('what word?', { cwd: '/work' });

    expect(JSON.stringify(prompts.at(-1))).not.toContain('heron');
    await client.close();
  });

  test('/compact folds all but its last exchanges out of the next prompt; without it every turn is sent', async () => {
    // Folded turns survive only inside the summary; as messages of their own, only the kept tail is sent.
    const turnsSentAsMessages = async (compact: boolean): Promise<string[]> => {
      const prompts: LanguageModelV2Prompt[] = [];
      const { client } = setup(fakeModel('noted', (prompt) => prompts.push(prompt)));
      await client.connect();

      for (let turn = 0; turn < 5; turn++) await client.send(`turn ${String(turn)}: ${'context '.repeat(200)}`, { cwd: '/work' });

      if (compact) await client.localControls.compact();
      await client.send('what came first?', { cwd: '/work' });
      await client.close();
      const asked = prompts.filter((prompt) => JSON.stringify(prompt.at(-1)).includes('what came first?')).at(-1) ?? [];

      return asked.flatMap((message) => (message.role === 'user' ? message.content : []))
        .flatMap((part) => (part.type === 'text' && part.text.startsWith('turn ') ? [part.text.slice(0, 6)] : []));
    };

    expect(await turnsSentAsMessages(false)).toEqual(['turn 0', 'turn 1', 'turn 2', 'turn 3', 'turn 4']);
    // Folded before the next ask exists: the kept tail is the last two exchanges.
    expect(await turnsSentAsMessages(true)).toEqual(['turn 3', 'turn 4']);
  });

  test('/compact folds at once: the number is the folded request, and the next turn sends the fold without a second one', async () => {
    let summaries = 0;
    const prompts: LanguageModelV2Prompt[] = [];
    const { client } = setup(fakeModel('findings '.repeat(600), (prompt) => prompts.push(prompt), { onCall: () => { summaries += 1; } }));
    await client.connect();
    const turns = gateSizes(client);

    for (let turn = 0; turn < 5; turn++) await client.send(`look into part ${String(turn)}`, { cwd: '/work' });

    const lastTurn = turns.at(-1) ?? 0;
    const measured = nextContextFill(client);
    await client.localControls.compact();
    const tokens = await measured;
    const folds = summaries;

    expect(folds).toBeGreaterThan(0);
    expect((await client.status()).context).toMatchObject({ tokens, source: 'gate' });
    expect(tokens).toBeLessThan(lastTurn);

    await client.send('what came first?', { cwd: '/work' });
    await client.send('and after that?', { cwd: '/work' });
    await client.close();

    expect(asksSentWith(prompts, 'what came first?')).toEqual(['look into part 3', 'look into part 4']);
    expect(asksSentWith(prompts, 'and after that?')).toEqual(['look into part 3', 'look into part 4']);
    expect(summaries).toBe(folds);
  });

  test('a /compact whose summary fails says why, leaves the conversation as it was and arms nothing', async () => {
    const prompts: LanguageModelV2Prompt[] = [];
    const { client } = setup(fakeModel('findings '.repeat(600), (prompt) => prompts.push(prompt), { fail: new Error('the summarizer is out of credit') }));
    await client.connect();

    for (let turn = 0; turn < 5; turn++) await client.send(`look into part ${String(turn)}`, { cwd: '/work' });

    const before = await client.history();
    let refusal = '';

    try {
      await client.localControls.compact();
    } catch (err) {
      refusal = renderThrownChain({ cause: err });
    }

    expect(refusal).toContain('the summarizer is out of credit');
    expect(await client.history()).toEqual(before);

    await client.send('what came first?', { cwd: '/work' });
    await client.close();

    expect(asksSentWith(prompts, 'what came first?')).toHaveLength(5);
  });

  // A Claude model that compacts server-side folds on its provider (core providers/server-compaction.ts): /compact arms
  // the next request to ask for it, or says a conversation under the provider's floor has nothing to fold.
  test('/compact on a Claude model that compacts server-side asks for it on the next request, once', async () => {
    const compacted = async (asks: number) => {
      const triggers: (number | null)[] = [];
      // Long answers: a long ask is saved to a file instead.
      const { client } = setup(providerOptionsModel('findings '.repeat(4_000), (options) => { triggers.push(compactionTrigger(options)); }));
      const sizes = gateSizes(client);
      await client.connect();
      await client.setModel('anthropic/claude-opus-4-7');

      for (let turn = 0; turn < asks; turn++) await client.send(`look into part ${String(turn)}`, { cwd: '/work' });

      const before = triggers.at(-1) ?? null;
      const outcome = await client.localControls.compact();
      await client.send('what came first?', { cwd: '/work' });
      const armed = { trigger: triggers.at(-1) ?? null, admitted: sizes.at(-1) ?? 0 };
      await client.send('and after that?', { cwd: '/work' });
      const after = triggers.at(-1) ?? null;
      await client.close();

      return { outcome, before, armed, after };
    };

    const long = await compacted(5);
    const short = await compacted(1);

    expect({ outcome: long.outcome, after: long.after }).toEqual({ outcome: 'armed', after: long.before });
    expect(long.armed.trigger).toBeLessThan(long.armed.admitted);
    expect(long.armed.trigger).toBeGreaterThanOrEqual(50_000);
    expect(short).toMatchObject({ outcome: 'nothing', armed: { trigger: short.before }, after: short.before });
  });

  test('a turn sent while /compact folds waits for the fold and runs on it', async () => {
    const order: string[] = [];
    const summarizing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const model = fakeModel('findings '.repeat(600), (prompt) => {
      if (JSON.stringify(prompt.at(-1)).includes('what came first?')) order.push('turn');
    }, {
      onCall: async () => {
        summarizing.resolve();
        await release.promise;
        order.push('summary');
      },
    });

    const { client } = setup(model);
    await client.connect();

    for (let turn = 0; turn < 5; turn++) await client.send(`look into part ${String(turn)}`, { cwd: '/work' });

    const folding = client.localControls.compact();
    await summarizing.promise;
    const sent = client.send('what came first?', { cwd: '/work' });
    release.resolve();
    await folding;
    await sent;
    await client.close();

    expect(order.at(-1)).toBe('turn');
    expect(order.filter((step) => step === 'turn')).toHaveLength(1);
    expect(order.indexOf('turn')).toBe(order.lastIndexOf('summary') + 1);
  });

  test('a new session shows the gate\'s measure of its first request before any turn, measured once', async () => {
    let calls = 0;
    const { client, home } = setup(fakeModel('noted', () => { calls += 1; }));
    const measured = nextContextFill(client);
    await client.connect();
    const tokens = await measured;

    expect((await client.status()).context).toMatchObject({ tokens, source: 'gate' });
    await client.close();

    const reopened = openPersistentClient(home, fakeModel('noted', () => { calls += 1; }), { noTranscript: true });
    await reopened.connect();
    expect((await reopened.status()).context).toMatchObject({ tokens, source: 'gate' });
    await reopened.close();

    expect(calls).toBe(0);
    expect(gateMeasures(home)).toBe(1);
  });

  test('after /clear, before any turn, the number is the gate\'s measure of the emptied request', async () => {
    const { client } = setup(fakeModel('findings '.repeat(600)));
    await client.connect();
    const turns = gateSizes(client);

    for (let turn = 0; turn < 3; turn++) await client.send(`look into part ${String(turn)}`, { cwd: '/work' });

    const lastTurn = turns.at(-1) ?? 0;
    const measured = nextContextFill(client);
    await client.localControls.clearConversation();
    const tokens = await measured;
    const status = await client.status();
    await client.close();

    expect(status.context).toMatchObject({ tokens, source: 'gate' });
    expect(tokens).toBeLessThan(lastTurn);
  });

  test('/clear returns once the emptied request is measured, so the number is already the new one', async () => {
    const { client } = setup(fakeModel('findings '.repeat(600)));
    await client.connect();
    const turns = gateSizes(client);

    for (let turn = 0; turn < 3; turn++) await client.send(`look into part ${String(turn)}`, { cwd: '/work' });

    const lastTurn = turns.at(-1) ?? 0;
    const unmeasured = await client.localControls.clearConversation();
    const status = await client.status();
    await client.close();

    expect(status.context?.source).toBe('gate');
    expect(status.context?.tokens).toBeLessThan(lastTurn);
    expect(unmeasured).toBeNull();
  });

  test('a /clear whose measure failed reads as unmeasured after a reload, not as the cleared conversation\'s number', async () => {
    let unreachable = false;

    const { client, home } = setup(fakeModel('noted'), async () => {
      if (unreachable) throw new Error('the profile catalog is unreachable');

      return null;
    });

    await client.connect();
    await client.send('remember the word heron', { cwd: '/work' });
    unreachable = true;
    await client.localControls.clearConversation();
    await client.close();

    const reopened = openPersistentClient(home, fakeModel('noted'), { noTranscript: true });
    await reopened.connect();
    const status = await reopened.status();
    await reopened.close();

    expect(status.context).toBeNull();
  });

  test('/clear whose measure fails still clears, and returns why no number exists', async () => {
    let unreachable = false;

    const { client } = setup(fakeModel('noted'), async () => {
      if (unreachable) throw new Error('the profile catalog is unreachable');

      return null;
    });

    await client.connect();
    await client.send('remember the word heron', { cwd: '/work' });
    unreachable = true;
    const unmeasured = await client.localControls.clearConversation();
    const history = await client.history();
    await client.close();

    expect(unmeasured?.message).toContain('the profile catalog is unreachable');
    expect(history).toEqual([]);
  });

  test('a model switch records the gate\'s measure of the next request against the new model', async () => {
    const { client, home } = setup(fakeModel('noted'));
    await client.connect();
    await client.send('remember the word heron', { cwd: '/work' });
    const before = gateMeasures(home);

    const measured = nextContextFill(client);
    await client.setModel('fake/big-model');
    const tokens = await measured;
    const status = await client.status();
    await client.close();

    expect(status.context).toMatchObject({ tokens, source: 'gate' });
    expect(gateMeasures(home)).toBe(before + 1);
  });

  test('a reconnect shows the prompt size the last step reported, and asks no model for it', async () => {
    const { client, home } = setup(fakeModel('noted'));
    await client.connect();
    await client.send('remember the word heron', { cwd: '/work' });
    await client.close();

    let calls = 0;
    const reopened = openPersistentClient(home, fakeModel('noted', () => { calls += 1; }), { noTranscript: true });
    await reopened.connect();
    const status = await reopened.status();
    await reopened.close();

    // The fake provider reports 5 prompt tokens for every step.
    expect(status.context).toMatchObject({ tokens: 5, source: 'provider' });
    expect(calls).toBe(0);
  });

  test('each turn records the size the admission gate measured its request at, and /compact shrinks the next one', async () => {
    // Short asks and long answers, as a working session reads: the fold keeps each ask and summarizes the answers.
    const admittedSizes = async (compact: boolean): Promise<number[]> => {
      const { client } = setup(fakeModel('findings '.repeat(600)));
      const sizes = gateSizes(client);
      await client.connect();

      for (let turn = 0; turn < 5; turn++) await client.send(`look into part ${String(turn)}`, { cwd: '/work' });

      if (compact) await client.localControls.compact();
      await client.send('what came first?', { cwd: '/work' });
      await client.close();

      return sizes;
    };

    const whole = await admittedSizes(false);
    const folded = await admittedSizes(true);

    expect(whole).toHaveLength(6);
    expect(whole.every((size, index) => index === 0 || size > (whole[index - 1] ?? 0))).toBeTrue();
    expect(folded.at(-1)).toBeLessThan(whole.at(-1) ?? 0);
  });

  test('status and tools reflect the live session', async () => {
    const { client } = setup(fakeModel('ok'));
    await client.connect();
    const status = await client.status();
    expect(status.name).toBe('jarvis');
    expect(status.autoEvolve).toBe(false);
    expect(status.toolCount).toBeGreaterThan(0);
    const tools = await client.describeTools();
    expect(tools.builtIn.length).toBeGreaterThan(0);
    await client.close();
  });
});

describe('/changelog — the Evolution Changelog over a real local client', () => {
  test('lists self-changes, marks seen on view, and reverts by index', async () => {
    const { client, rt } = setup(fakeModel('ok'));
    await client.connect();
    const { executeSlashCommand } = await import('../src/slash-commands');

    rt.craftStore.create({ name: 'csv_summarizer', description: 'summarize CSVs', code: 'async () => 1' });
    void rt.storage.sql`INSERT INTO agent_facts (actor_id, key, value_json, confidence, source, last_observed_at)
                   VALUES (${rt.actor.actorId}, 'favorite_shell', '"fish"', 1.0, NULL, ${Date.now() - 1000})`;
    void rt.storage.sql`INSERT INTO agent_facts (actor_id, key, value_json, confidence, source, last_observed_at)
                   VALUES (${rt.actor.actorId}, 'editor', '"helix"', 1.0, NULL, ${Date.now() - 500})`;

    const listed = await executeSlashCommand(client, '/changelog');

    if (listed.kind !== 'changelog') throw new Error(`expected changelog outcome, got ${listed.kind}`);
    expect(listed.view.unseenCount).toBe(2);
    const tool = present(listed.view.entries.find((entry) => entry.kind === 'tool'), 'a tool entry');
    const facts = present(listed.view.entries.find((entry) => entry.kind === 'fact'), 'a fact entry');
    expect(tool.summary).toBe('Created a tool: csv summarizer');
    expect(facts.summary).toBe('Learned 2 things about your environment');
    expect(facts.items?.map((entry) => entry.summary)).toEqual([
      'Your editor is helix',
      'Your favorite shell is fish',
    ]);

    const second = await executeSlashCommand(client, '/changelog');

    if (second.kind !== 'changelog') throw new Error('expected changelog outcome');
    expect(second.view.unseenCount).toBe(0);

    const factIndex = second.view.entries.findIndex((entry) => entry.kind === 'fact') + 1;
    const reverted = await executeSlashCommand(client, `/changelog revert ${factIndex}`);

    if (reverted.kind !== 'text') throw new Error('expected text outcome');
    expect(reverted.text).toContain(`Reverted ${factIndex}`);
    expect(rt.storage.sql`SELECT * FROM agent_facts`).toHaveLength(0);
    expect(rt.craftStore.get('csv_summarizer')).toMatchObject({ name: 'csv_summarizer' });

    const missing = await executeSlashCommand(client, '/changelog revert 99');

    if (missing.kind !== 'text') throw new Error('expected text outcome');
    expect(missing.text).toContain('No changelog entry 99');
    const usage = await executeSlashCommand(client, '/changelog revert x');

    if (usage.kind !== 'text') throw new Error('expected text outcome');
    expect(usage.text).toContain('Usage');
    await client.close();
  });
});

describe('/takes — Alternate Takes over a real local client', () => {
  test('latestTakes/pickTake round-trip: ledger write, repoint, and the /takes command surface', async () => {
    const { client, rt } = setup(fakeModel('answered with A'));
    const observed = new AwaitedList<AgentClientEvent>();
    client.subscribe((event) => observed.push(event));
    await client.connect();
    const { executeSlashCommand } = await import('../src/slash-commands');
    const { initAlternateTakesTable, recordBranchTakeSet } = await import('@kinu.run/core');

    const empty = await executeSlashCommand(client, '/takes');

    if (empty.kind !== 'text') throw new Error(`expected text outcome, got ${empty.kind}`);
    expect(empty.text).toContain('No alternate takes yet');

    initAlternateTakesTable(rt.storage.execRaw);
    await client.send('solve it');
    // A steer branch's take set on the turn that answered.
    recordBranchTakeSet(rt.storage.sql, rt.actor, {
      task: 'choose a plan', turnId: 'turn-answered', sessionId: 'default', liveText: 'plan A wins', branchText: 'plan B instead',
    });

    const set = await client.latestTakes();

    if (set === null || set.turnId === null) throw new Error('expected alternate takes bound to a turn');
    expect(set.candidates.map((c) => c.text)).toEqual(['plan A wins', 'plan B instead']);

    const listing = await executeSlashCommand(client, '/takes');

    if (listing.kind !== 'takes') throw new Error(`expected takes outcome, got ${listing.kind}`);
    expect(listing.set.id).toBe(set.id);

    const picked = await executeSlashCommand(client, '/takes 2');

    if (picked.kind !== 'text') throw new Error(`expected text outcome, got ${picked.kind}`);
    expect(picked.text).toContain('Take 2 picked');

    const row = rt.storage.sql<{ score: number; source: string; turn_id: string }>`
      SELECT score, source, turn_id FROM turn_ratings`[0];

    if (row === undefined) throw new Error('expected a take_pick rating row');
    expect(row).toMatchObject({ score: 2, source: 'take_pick', turn_id: set.turnId });

    await observed.until((items) => items.some((event) => event.type === 'turn-start' && event.kind === 'programmatic' && event.event === 'take_pick')
      && items.filter((event) => event.type === 'turn-end').length >= 2);

    const missing = await executeSlashCommand(client, '/takes 9');

    if (missing.kind !== 'text') throw new Error('expected text outcome');
    expect(missing.text).toContain('No take "9"');
    await client.close();
  });
});
