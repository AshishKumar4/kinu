// LocalAgentClient — the local AgentClient adapter over LocalAgentSession,
// driven by the authentic createCLIRuntime and a fake streaming model (no
// network LLM). Verifies the unified seam: event stream, turn results, JSONL
// recording, history hydration, walk-back fork, and stop() reaching the abort.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import type { LanguageModelV2Prompt } from '@ai-sdk/provider';
import type { LLMProviderConfig } from '@kinu.run/core';
import { createCLIRuntime, type LocalModelResolver } from '@kinu.run/cli-backend';
import { TestLanguageModelV2 } from '../../cli-backend/tests/test-language-model';
import { LocalAgentClient } from '../src/local-agent-client';
import type { CliSessionOptions } from '../src/session';
import type { AgentClientEvent } from '../src/agent-client';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'openai-compat', baseURL: 'http://localhost:0', headers: { Authorization: 'x' }, model: 'fake-model',
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
  };
}

function setup(model: LanguageModel) {
  const home = mkdtempSync(join(tmpdir(), 'kinu-client-'));
  tempDirs.push(home);
  const dbPath = join(home, 'agent.db');
  writeFileSync(dbPath, '');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT 'default', parent_id TEXT,
    role TEXT NOT NULL, content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
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
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT 'default', parent_id TEXT,
    role TEXT NOT NULL, content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
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
    expect(result.text).toBe('hello there');
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
    expect(history[0]!.content).toBe('hi');
    expect(history[1]!.content).toBe('hello there');
    await client.close();
  });

  test('the diagnostic recorder never chooses or disables the durable conversation', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kinu-client-persistent-'));
    tempDirs.push(home);
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
    const sessions = db.query<{ session_id: string }, []>(
      'SELECT DISTINCT session_id FROM messages ORDER BY session_id',
    ).all();
    const conversation = db.query<{ value: string }, []>(
      "SELECT value FROM agent_config WHERE key = 'conversation.id'",
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
    expect(result.hadError).toBe(true);
    expect(events.some((event) => event.type === 'error')).toBe(true);
    await client.close();
  });

  test('steer mid-turn records a steered user entry and reaches the agent', async () => {
    // Single-step model held open until release() — a deterministic steer window.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    const model = new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
      doStream: async () => ({
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: '0' });
            controller.enqueue({ type: 'text-delta', id: '0', delta: 'working on it' });
            await gate;
            controller.enqueue({ type: 'text-end', id: '0' });
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
            controller.close();
          },
        }),
        response: { headers: {} },
      }),
    });

    const { client } = setup(model);
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));
    await client.connect();

    expect(client.steer('too early')).toBe(false);

    const turn = client.send('start');
    const deadline = Date.now() + 2_000;
    while (!events.some((event) => event.type === 'text-delta') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(client.steer('actually, use yaml')).toBe(true);
    release();
    await turn;
    // The undrained steer cascades as the immediate next turn.
    const settled = Date.now() + 2_000;
    while (events.filter((event) => event.type === 'turn-end').length < 2 && Date.now() < settled) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const history = await client.history();
    const steered = history.find((message) => message.content === 'actually, use yaml');
    expect(steered).toMatchObject({ role: 'user', steered: true });
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
    void rt.storage.sql`INSERT INTO agent_facts (key, value_json, confidence, source, last_observed_at)
                   VALUES ('favorite_shell', '"fish"', 1.0, NULL, ${Date.now() - 1000})`;
    void rt.storage.sql`INSERT INTO agent_facts (key, value_json, confidence, source, last_observed_at)
                   VALUES ('editor', '"helix"', 1.0, NULL, ${Date.now() - 500})`;

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
    expect(rt.craftStore.get('csv_summarizer')).toBeTruthy();

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
    initSearchTables(rt.storage.execRaw, rt.storage.sql);
    initAlternateTakesTable(rt.storage.execRaw, rt.storage.sql);
    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, task, action, observation, value, visits, depth, status)
        VALUES ('r', 'win', 'choose a plan', 'A', 'plan A wins', 0.9, 3, 1, 'open')`;
    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, task, action, observation, value, visits, depth, status)
        VALUES ('r', 'alt', 'choose a plan', 'B', 'plan B instead', 0.84, 2, 1, 'open')`;
    // Production captures happen mid-turn. This fixture seeds before send(), so
    // place it inside the upcoming turn's claim window instead of depending on
    // capture and turn start landing in the same millisecond.
    captureAlternateTakes(rt.storage.sql, {
      rootId: 'r', task: 'choose a plan', winnerId: 'win', epsilon: 0.1, now: Date.now() + 1_000,
    });
    await client.send('solve it');

    const set = await client.latestTakes();
    expect(set).not.toBeNull();
    expect(set!.turnId).toBeTruthy();
    expect(set!.candidates.map((c) => c.nodeId)).toEqual(['win', 'alt']);

    const listing = await executeSlashCommand(client, '/takes');
    if (listing.kind !== 'takes') throw new Error(`expected takes outcome, got ${listing.kind}`);
    expect(listing.set.id).toBe(set!.id);

    // Pick by number through the shared command path (take 2 = the sibling).
    const picked = await executeSlashCommand(client, '/takes 2');
    if (picked.kind !== 'text') throw new Error(`expected text outcome, got ${picked.kind}`);
    expect(picked.text).toContain('Take 2 picked');
    const row = rt.storage.sql<{ outcome: string; source: string; turn_id: string }>`
      SELECT outcome, source, turn_id FROM turn_outcomes`[0]!;
    expect(row).toMatchObject({ outcome: 'corrected', source: 'take_pick', turn_id: set!.turnId });
    expect(rt.storage.sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'alt'`[0]!.status).toBe('terminal');

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
