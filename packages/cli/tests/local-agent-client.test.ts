// LocalAgentClient — the local AgentClient adapter over LocalAgentSession,
// driven by the authentic createCLIRuntime and a fake streaming model (no
// network LLM). Verifies the unified seam: event stream, turn results, JSONL
// recording, history hydration, resume, and stop() reaching the session abort.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import type { LLMProviderConfig } from '@proteus/core';
import { createCLIRuntime, type LocalModelResolver, type resolveChatModel } from '@proteus/cli-backend';
import { LocalAgentClient } from '../src/local-agent-client.js';
import type { AgentClientEvent } from '../src/agent-client.js';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'openai-compat', baseURL: 'http://localhost:0', headers: { Authorization: 'x' }, model: 'fake-model',
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeModel(answer: string): LanguageModel {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  const [a, b] = [answer.slice(0, answer.length >> 1), answer.slice(answer.length >> 1)];
  return {
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doStream: async () => ({
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
    }),
  } as unknown as LanguageModel;
}

/** Emits one delta then stalls until the turn abort signal fires. */
function stallingModel(): LanguageModel {
  return {
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doStream: async ({ abortSignal }: { abortSignal?: AbortSignal }) => ({
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
  } as unknown as LanguageModel;
}

function fakeResolver(model: LanguageModel): LocalModelResolver {
  return {
    normalizeSpecSync: (spec) => spec?.trim() || 'fake/fake-model',
    resolveModel: () => model,
    listProviders: async () => [{ id: 'fake', label: 'Fake', available: true }],
    listModels: async () => [{ id: 'fake-model', label: 'Fake Model', provider: 'fake' }],
  };
}

function setup(model: LanguageModel) {
  const home = mkdtempSync(join(tmpdir(), 'proteus-client-'));
  tempDirs.push(home);
  const dbPath = join(home, 'agent.db');
  writeFileSync(dbPath, '');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT 'default', parent_id TEXT,
    role TEXT NOT NULL, content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
  const rt = createCLIRuntime(db as never, { dbPath, llm: DUMMY_LLM });
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
    refreshInfo: () => info,
    model: model as ReturnType<typeof resolveChatModel>,
    modelResolver: fakeResolver(model),
    mcpServers: {},
    noAutoEvolve: true,
    sessionOptions: { sessionDir: join(home, 'sessions') },
  });
  return { client, home };
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

  test('listSessions and resumeConversation re-point the terminal log', async () => {
    const { client } = setup(fakeModel('first answer'));
    await client.connect();
    await client.send('first question');
    const originalId = client.cliSession.id;

    const sessions = client.listSessions();
    expect(sessions.map((session) => session.id)).toContain(originalId);

    await client.resumeConversation(originalId);
    expect(client.cliSession.id).toBe(originalId);
    const history = await client.history();
    expect(history.map((message) => message.role)).toEqual(['user', 'assistant']);
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
