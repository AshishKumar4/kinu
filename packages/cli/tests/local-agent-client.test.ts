import { scratchDir } from '../../test-utils/src/scratch';
import { present, readTranscriptRows } from '@kinu.run/test-utils';
import { existsSync } from 'node:fs';

import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import type { LanguageModelV2Prompt } from '@ai-sdk/provider';
import { NO_COUNT_ENDPOINT, openWorkspaceMainActor, type LLMProviderConfig } from '@kinu.run/core';
import { initWorkspaceSchema } from '@kinu.run/core';
import { createCLIRuntime, makeSql, type LocalModelResolver , makeWorkspaceSchemaSql } from '@kinu.run/cli-backend';
import { TestLanguageModelV2 } from '../../cli-backend/tests/test-language-model';
import { LocalAgentClient } from '../src/local-agent-client';
import type { CliSessionOptions } from '../src/session';
import type { AgentClientEvent } from '../src/agent-client';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'openai-compat', baseURL: 'http://localhost:0', headers: { Authorization: 'x' }, model: 'fake-model',
};

function fakeModel(answer: string, onPrompt?: (prompt: LanguageModelV2Prompt) => void): LanguageModel {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  const [a, b] = [answer.slice(0, answer.length >> 1), answer.slice(answer.length >> 1)];

  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
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
    listProviders: async () => [{ id: 'fake', label: 'Fake', available: true }],
    listModels: async () => ({ models: [{ id: 'fake-model', label: 'Fake Model', provider: 'fake' }], failures: [] }),
    modelInfo: async () => null,
    judgeCandidates: async () => [],
    getAuth: async () => null,
    // The fake vendor has no count endpoint, so the turn is assembled ungated.
    countInputTokens: async () => ({
      kind: 'unsupported' as const,
      provider: 'fake',
      reason: NO_COUNT_ENDPOINT,
    }),
  };
}

function setup(model: LanguageModel) {
  const home = scratchDir('client');
  const dbPath = join(home, 'agent.db');
  // `createCLIRuntime` requires the actor database to be `dbPath` on disk (`requireLocalDatabasePath`),
  // which no in-memory handle satisfies.
  const db = new Database(dbPath, { create: true });
  // The production initializer, not a copy of its DDL.
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { dbPath, llm: DUMMY_LLM });

  const info = {
    id: 'agent-1', name: 'jarvis', purpose: 'test agent', soul: '', scaffoldVersion: 1,
    craftedToolCount: 0, searchNodeCount: 0, taskCount: 0, memorySize: 0, createdAt: Date.now(),
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
    profileAuthority: async () => null,
    mcpServers: {},
    noAutoEvolve: true,
    transcript: { transcriptDir: join(home, 'sessions') },
    naming: { generate: async () => JSON.stringify({ title: 'Named By Test' }) },
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
  const db = new Database(dbPath);
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { dbPath, llm: DUMMY_LLM });

  const info = {
    id: 'agent-1', name: 'jarvis', purpose: 'test agent', soul: '', scaffoldVersion: 1,
    craftedToolCount: 0, searchNodeCount: 0, taskCount: 0, memorySize: 0, createdAt: Date.now(),
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
    noAutoEvolve: true,
    transcript: transcriptOptions,
    naming: { generate: async () => JSON.stringify({ title: 'Named By Test' }) },
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
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const types = events.map((event) => event.type);
    expect(types[0]).toBe('turn-start');
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

    const db = new Database(join(home, 'agent.db'));
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
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));
    await client.connect();

    const turn = client.send('long task');
    const deadline = Date.now() + 2_000;

    while (!events.some((event) => event.type === 'text-delta') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

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
                  input: JSON.stringify({ action: 'search', query: 'probe' }),
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
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));
    await client.connect();

    expect(await client.send('too early')).toMatchObject({ landed: 'turn' });

    armed = true;
    const turn = client.send('start');
    const deadline = Date.now() + 2_000;

    while (!events.some((event) => event.type === 'tool-call') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

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

    rt.craftStore.create({ params: null, name: 'csv_summarizer', description: 'summarize CSVs', code: 'async () => 1', scope: 'local' });
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
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));
    await client.connect();
    const { executeSlashCommand } = await import('../src/slash-commands');
    const { initSearchTables, initAlternateTakesTable, captureAlternateTakes } = await import('@kinu.run/core');

    const empty = await executeSlashCommand(client, '/takes');

    if (empty.kind !== 'text') throw new Error(`expected text outcome, got ${empty.kind}`);
    expect(empty.text).toContain('No alternate takes yet');

    initSearchTables(rt.storage.execRaw);
    initAlternateTakesTable(rt.storage.execRaw);
    void rt.storage.sql`INSERT INTO search_nodes (actor_id, root_id, id, task, action, observation, value, visits, depth, status)
        VALUES (${rt.actor.actorId}, 'r', 'win', 'choose a plan', 'A', 'plan A wins', 0.9, 3, 1, 'open')`;
    void rt.storage.sql`INSERT INTO search_nodes (actor_id, root_id, id, task, action, observation, value, visits, depth, status)
        VALUES (${rt.actor.actorId}, 'r', 'alt', 'choose a plan', 'B', 'plan B instead', 0.84, 2, 1, 'open')`;
    // Seeded before send(), so place it inside the turn's claim window rather than rely on same-millisecond timing.
    captureAlternateTakes(rt.storage.sql, rt.actor, {
      rootId: 'r', task: 'choose a plan', winnerId: 'win', epsilon: 0.1, now: Date.now() + 1_000,
    });
    await client.send('solve it');

    const set = await client.latestTakes();

    if (set === null || set.turnId === null) throw new Error('expected alternate takes bound to the just-run turn');
    expect(set.turnId.length).toBeGreaterThan(0);
    expect(set.candidates.map((c) => c.nodeId)).toEqual(['win', 'alt']);

    const listing = await executeSlashCommand(client, '/takes');

    if (listing.kind !== 'takes') throw new Error(`expected takes outcome, got ${listing.kind}`);
    expect(listing.set.id).toBe(set.id);

    const picked = await executeSlashCommand(client, '/takes 2');

    if (picked.kind !== 'text') throw new Error(`expected text outcome, got ${picked.kind}`);
    expect(picked.text).toContain('Take 2 picked');

    const row = rt.storage.sql<{ outcome: string; source: string; turn_id: string }>`
      SELECT outcome, source, turn_id FROM turn_outcomes`[0];

    if (row === undefined) throw new Error('expected a take_pick outcome row');
    expect(row).toMatchObject({ outcome: 'corrected', source: 'take_pick', turn_id: set.turnId });
    const altNode = rt.storage.sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'alt'`[0];

    if (altNode === undefined) throw new Error('expected the sibling take node');
    expect(altNode.status).toBe('terminal');

    const deadline = Date.now() + 2000;

    while (!events.some((e) => e.type === 'turn-start' && e.kind === 'programmatic' && e.event === 'take_pick')
        || events.filter((e) => e.type === 'turn-end').length < 2) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the take_pick continuation turn');
      await new Promise((r) => setTimeout(r, 5));
    }

    const missing = await executeSlashCommand(client, '/takes 9');

    if (missing.kind !== 'text') throw new Error('expected text outcome');
    expect(missing.text).toContain('No take "9"');
    await client.close();
  });
});
