// LocalAgentClient — the local AgentClient adapter over LocalAgentSession,
// driven by the authentic createCLIRuntime and a fake streaming model (no
// network LLM). Verifies the unified seam: event stream, turn results, JSONL
// recording, history hydration, walk-back fork, and stop() reaching the abort.
import { scratchDir } from '../../test-utils/src/scratch';
import { readTranscriptRows } from '@kinu.run/test-utils';
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

/** Emits one delta then stalls until the turn abort signal fires. */
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
    normalizeSpecSync: (spec: string | null | undefined) => spec?.trim() || 'fake/fake-model',
    resolveModel: () => model,
    listProviders: async () => [{ id: 'fake', label: 'Fake', available: true }],
    listModels: async () => ({ models: [{ id: 'fake-model', label: 'Fake Model', provider: 'fake' }], failures: [] }),
    modelInfo: async () => null,
    judgeCandidates: async () => [],
    getAuth: async () => null,
    // The fake vendor publishes no count endpoint, which is what the real seam
    // answers for it: the turn is assembled ungated rather than gated on an
    // estimate.
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
  // The database IS `dbPath`: `createCLIRuntime` binds the actor by reading the
  // database's own filename back and refuses a runtime whose declared path is
  // not that one (actor-identity.ts `requireLocalDatabasePath`), which no
  // in-memory handle can satisfy. `create: true` is what puts the file there.
  const db = new Database(dbPath, { create: true });
  // THE PRODUCTION INITIALIZER, not a copy of its DDL.
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
  // THE PRODUCTION INITIALIZER, not a copy of its DDL.
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

    // Recording is owned by the client: user + assistant entries land in JSONL.
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
    // A user's Stop is a choice, not an agent failure. `hadError` is what grades
    // the turn, and folding an interruption into it is the same drift that
    // sealed the durable run 'error' here and 'aborted' in the cloud — pinned
    // now in cli-backend local-session.test.ts, "a user's Stop seals the run
    // 'aborted'". The turn still ENDS abruptly, and the surface is still told.
    expect(result).toMatchObject({ landed: 'turn', hadError: false });
    expect(events.some((event) => event.type === 'error')).toBe(true);
    await client.close();
  });

  test('send mid-turn records a steered user entry and reaches the agent', async () => {
    // The 'start' turn's first model call is a gated tool call — the
    // deterministic window for a mid-turn send — and its finish opens the
    // step boundary the message lands at. The gate is ARMED, not always on:
    // every other call (the 'too early' turn, the post-tool step) answers at
    // once, which is what lets 'too early' resolve before the gate exists.
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

    // Nothing running: the message is a turn of its own, not a splice.
    expect(await client.send('too early')).toMatchObject({ landed: 'turn' });

    armed = true;
    const turn = client.send('start');
    const deadline = Date.now() + 2_000;

    while (!events.some((event) => event.type === 'tool-call') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // Answered where it is decided: the step boundary the gate opens is what
    // makes 'mid-turn' a fact, so the send resolves once that step took it.
    const steer = client.send('actually, use yaml');
    release();
    await turn;
    expect(await steer).toEqual({ landed: 'mid-turn' });

    // The send spliced into the running turn's second step as one user
    // message — the model read it, and no second turn ran for it.
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
    // The armed call is the turn's LAST step, held open on its final words:
    // a message sent while it is held has no step boundary left to land on,
    // so the session reruns it as the operator's next turn. Every other call
    // answers at once, which is what the rerun's own model call does.
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
    // The held turn has streamed its words: the next message arrives with the
    // turn on screen and nothing left for it to ride.
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
    // Both leftovers reran as ONE turn under the first one's id; the turn
    // carried the second, so it is answered with the same result.
    const carried = await third;

    if (carried.landed !== 'turn') throw new Error('a message the turn never read runs as the next turn');
    expect(carried.text).toBe('answer 2');

    // Answered by the rerun, with the rerun's own reply — not by the turn
    // that was writing when the words arrived, and not `mid-turn` at
    // admission, which is what made a harness read the brief's reply as the
    // answer to the question.
    if (result.landed !== 'turn') throw new Error('a message the turn never read runs as the next turn');
    expect(result.text).toBe('answer 2');
    expect(events.filter((event) => event.type === 'turn-start')).toHaveLength(2);

    // The CLI transcript shows it as the operator's own next message, in
    // order, ahead of the answer it got — never as a steer inside the brief's turn.
    const history = await client.history();
    expect(history.map((message) => [message.role, message.content])).toEqual([
      ['user', 'here is your standing brief'], ['assistant', 'standing brief, noted'],
      ['user', 'list every tool you have'], ['user', 'and your version'], ['assistant', 'answer 2'],
    ]);
    expect(history[2]).not.toHaveProperty('steered');
    expect(history[3]).not.toHaveProperty('steered');
    await client.close();
  });

  test('fork walks the conversation back before the picked message and re-points the client', async () => {
    // Capture what the model sees so the forked context is provable.
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

    // The forked conversation keeps turn one but not the walked-back message.
    await client.send('third question');
    const forkedPrompt = seenPrompts.at(-1)!;
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

      // The walk-back re-points the conversation in place: the entries before
      // the pivot are the head's whole ancestry, and the working history the
      // fork's first turn will run on is exactly those messages.
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
        const prompt = seenPrompts.at(-1)!;
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

    // Seed real ledgers: one crafted tool + two learned facts in one aggregate.
    rt.craftStore.create({ params: null, name: 'csv_summarizer', description: 'summarize CSVs', code: 'async () => 1', scope: 'local' });
    void rt.storage.sql`INSERT INTO agent_facts (actor_id, key, value_json, confidence, source, last_observed_at)
                   VALUES (${rt.actor.actorId}, 'favorite_shell', '"fish"', 1.0, NULL, ${Date.now() - 1000})`;
    void rt.storage.sql`INSERT INTO agent_facts (actor_id, key, value_json, confidence, source, last_observed_at)
                   VALUES (${rt.actor.actorId}, 'editor', '"helix"', 1.0, NULL, ${Date.now() - 500})`;

    const listed = await executeSlashCommand(client, '/changelog');

    if (listed.kind !== 'changelog') throw new Error(`expected changelog outcome, got ${listed.kind}`);
    expect(listed.view.unseenCount).toBe(2);
    const tool = listed.view.entries.find((entry) => entry.kind === 'tool')!;
    const facts = listed.view.entries.find((entry) => entry.kind === 'fact')!;
    expect(tool.summary).toBe('Created a tool: csv summarizer');
    expect(facts.summary).toBe('Learned 2 things about your environment');
    expect(facts.items?.map((entry) => entry.summary)).toEqual([
      'Your editor is helix',
      'Your favorite shell is fish',
    ]);

    // Viewing IS the acknowledgement — the next fetch shows nothing unseen.
    const second = await executeSlashCommand(client, '/changelog');

    if (second.kind !== 'changelog') throw new Error('expected changelog outcome');
    expect(second.view.unseenCount).toBe(0);

    // The aggregate is one rendered row/index; reverting it forgets every child.
    const factIndex = second.view.entries.findIndex((entry) => entry.kind === 'fact') + 1;
    const reverted = await executeSlashCommand(client, `/changelog revert ${factIndex}`);

    if (reverted.kind !== 'text') throw new Error('expected text outcome');
    expect(reverted.text).toContain(`Reverted ${factIndex}`);
    expect(rt.storage.sql`SELECT * FROM agent_facts`).toHaveLength(0);
    expect(rt.craftStore.get('csv_summarizer')).toMatchObject({ name: 'csv_summarizer' });

    // Out-of-range and bad indices answer with usage, never throw.
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

    // No takes yet — the command explains instead of opening a comparison.
    const empty = await executeSlashCommand(client, '/takes');

    if (empty.kind !== 'text') throw new Error(`expected text outcome, got ${empty.kind}`);
    expect(empty.text).toContain('No alternate takes yet');

    // Seed a near-tied convergence (what think-mcts captures mid-turn), then
    // run a turn so the session claims it.
    initSearchTables(rt.storage.execRaw);
    initAlternateTakesTable(rt.storage.execRaw);
    void rt.storage.sql`INSERT INTO search_nodes (actor_id, root_id, id, task, action, observation, value, visits, depth, status)
        VALUES (${rt.actor.actorId}, 'r', 'win', 'choose a plan', 'A', 'plan A wins', 0.9, 3, 1, 'open')`;
    void rt.storage.sql`INSERT INTO search_nodes (actor_id, root_id, id, task, action, observation, value, visits, depth, status)
        VALUES (${rt.actor.actorId}, 'r', 'alt', 'choose a plan', 'B', 'plan B instead', 0.84, 2, 1, 'open')`;
    // Production captures happen mid-turn. This fixture seeds before send(), so
    // place it inside the upcoming turn's claim window instead of depending on
    // capture and turn start landing in the same millisecond.
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

    // Pick by number through the shared command path (take 2 = the sibling).
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

    // The pick queued a take_pick continuation turn — let it stream through
    // the same event seam before closing.
    const deadline = Date.now() + 2000;

    while (!events.some((e) => e.type === 'turn-start' && e.kind === 'programmatic' && e.event === 'take_pick')
        || events.filter((e) => e.type === 'turn-end').length < 2) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the take_pick continuation turn');
      await new Promise((r) => setTimeout(r, 5));
    }

    // Out-of-range picks answer with usage, never throw.
    const missing = await executeSlashCommand(client, '/takes 9');

    if (missing.kind !== 'text') throw new Error('expected text outcome');
    expect(missing.text).toContain('No take "9"');
    await client.close();
  });
});
