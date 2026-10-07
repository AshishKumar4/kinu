// Local MCP integration: stdio server connect, tool exposure, call proxying, merge into a local turn.
import { afterAll, beforeAll, describe, test, expect, spyOn } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { jsonSchema, tool, type LanguageModel } from 'ai';
import { TestLanguageModelV2 } from './test-language-model';
import { isMcpToolKey, narrowToolSurface, NO_TIMER_DEADLINE_MS, WORKSPACE_ROOT, type JsonObject, type LLMProviderConfig } from '@kinu.run/core';
import { initWorkspaceSchema } from '@kinu.run/core';
import { createCLIRuntime , makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';
import { connectMcpServers } from '../src/mcp';
import { createNodeCodemodeToolFactory } from '../src/codemode-tool-factory';
import type { LocalModelResolver } from '../src/model-resolver';
import { createLocalProfileAuthority, resolverModelPlane } from '../src/profile-authority';
import { scratchPath, scriptedTurnModel, toolExecute, scratchDir, type ScriptedTurnOptions, type ScriptedTurnResult, workspaceDatabase } from '@kinu.run/test-utils';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

const fixtureServer = new URL('./fixtures/echo-mcp-server.mjs', import.meta.url).pathname;

const badRootServer = new URL('./fixtures/bad-root-mcp-server.mjs', import.meta.url).pathname;

function mcpServers() {
  return {
    echo: {
      command: 'node',
      args: [fixtureServer],
    },
  };
}

/** What one request carried: its native tool names, and its prompt, where `eval`'s external tools are declared. */
interface CapturedRequest { readonly native: string[]; readonly prompt: string }

function capturingModel(sink: (request: CapturedRequest) => void): LanguageModel {
  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async (options) => {
      sink({ native: (options.tools ?? []).map((t) => t.name), prompt: JSON.stringify(options.prompt) });

      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: '0' });
            controller.enqueue({ type: 'text-delta', id: '0', delta: 'ok' });
            controller.enqueue({ type: 'text-end', id: '0' });
            controller.enqueue({
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            controller.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });
}

function sessionWithModel(model: LanguageModel) {
  const db = workspaceDatabase(scratchPath('mcp', 'agent.db'), { create: true });
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));

  const rt = createCLIRuntime(db, {
    cwd: scratchDir('workspace-folder'),
    llm: DUMMY_LLM,
  });

  const events: SessionEvent[] = [];

  rt.actor.config.setLearning(false);

  const session = new LocalAgentSession({
    rt, db, model, onEvent: (e) => events.push(e),
  });

  return { session, events };
}

describe('connectMcpServers', () => {
  test('no configured timeout means no deadline at the SDK seam, not the SDK\'s own 60 s default', async () => {
    // The SDK reads an absent `timeout` as 60_000 ms, so "no deadline" is the sentinel on every request.
    const connect = spyOn(Client.prototype, 'connect');
    const listTools = spyOn(Client.prototype, 'listTools');
    const callTool = spyOn(Client.prototype, 'callTool');

    try {
      const conn = await connectMcpServers({
        echo: { command: 'node', args: [fixtureServer] },
        bounded: { command: 'node', args: [fixtureServer], timeoutMs: 1_234 },
      });

      try {
        await conn.call('echo', 'echo', { text: 'x' });
        await conn.call('bounded', 'echo', { text: 'y' });
      } finally {
        await conn.close();
      }

      expect(connect.mock.calls.map(([, options]) => options?.timeout)).toEqual([NO_TIMER_DEADLINE_MS, NO_TIMER_DEADLINE_MS]);
      expect(listTools.mock.calls.map(([, options]) => options?.timeout)).toEqual([NO_TIMER_DEADLINE_MS, NO_TIMER_DEADLINE_MS]);
      expect(callTool.mock.calls.map(([, , options]) => options?.timeout)).toEqual([NO_TIMER_DEADLINE_MS, 1_234]);
    } finally {
      connect.mockRestore();
      listTools.mockRestore();
      callTool.mockRestore();
    }
  });

  test('the caller cancels a running tool call; nothing else ends it early', async () => {
    const conn = await connectMcpServers({
      echo: { command: 'node', args: [fixtureServer] },
    });

    try {
      const stop = new AbortController();
      const running = conn.call('echo', 'held', {}, stop.signal);
      expect(Bun.peek.status(running)).toBe('pending');
      stop.abort();
      await expect(running).rejects.toBeInstanceOf(Error);
    } finally {
      await conn.close();
    }
  });

  // Release review, 2026-10-04: eval bound a tool without eval's signal, so a stopped eval left the server's call running.
  test('stopping eval cancels the MCP call its program is waiting on', async () => {
    const conn = await connectMcpServers({
      echo: { command: 'node', args: [fixtureServer] },
    });

    const stop = new AbortController();
    const calls: Promise<string>[] = [];
    const object = jsonSchema<JsonObject>({ type: 'object' });

    // Bound as the session binds a server's tool, with the call's own signal.
    const external = {
      held: tool({ description: 'Held until cancelled.', inputSchema: object, execute: async (_input, options) => {
        const call = conn.call('echo', 'held', {}, options.abortSignal);
        calls.push(call);

        return await call;
      } }),
      stop: tool({ description: 'The person stops the turn.', inputSchema: object, execute: async () => {
        stop.abort();

        return 'stopped';
      } }),
    };

    try {
      const run = toolExecute<{ code: string }, unknown>(createNodeCodemodeToolFactory({ reach: narrowToolSurface(undefined) })({
        cwd: WORKSPACE_ROOT,
        native: {}, providers: [], craftedTools: () => [], external: () => external,
      }));

      await Promise.allSettled([run(
        { code: 'const held = tools.held({}); await tools.stop({}); return await held;' },
        { toolCallId: 'eval-held', messages: [], context: undefined, abortSignal: stop.signal },
      )]);
      expect(calls).toHaveLength(1);
      await expect(calls[0]).rejects.toBeInstanceOf(Error);
    } finally {
      await conn.close();
    }
  });

  test('connects to a stdio MCP server, lists tools, and proxies a call', async () => {
    const logs: string[] = [];
    const conn = await connectMcpServers(mcpServers(), (msg) => logs.push(msg));

    try {
      expect(conn.descriptors.map((d) => d.toolKey))
        .toEqual(['mcp_echo_echo', 'mcp_echo_held', 'mcp_echo_huge']);
      expect(conn.diagnostics).toEqual([{ server: 'echo', status: 'connected', toolCount: 3 }]);
      expect(logs.some((m) => m.includes('mcp: echo'))).toBe(true);
      await expect(conn.call('echo', 'echo', { text: 'hello' })).resolves.toBe('echo: hello');
      await conn.close();
      await expect(conn.call('echo', 'echo', { text: 'after disconnect' })).rejects.toBeInstanceOf(Error);
    } finally {
      await conn.close();
    }
  });

  test('a listed tool that breaks the spec is refused alone and named; the rest of its server still works', async () => {
    const logs: string[] = [];
    const conn = await connectMcpServers({ bad: { command: 'node', args: [badRootServer] } }, (msg) => logs.push(msg));

    try {
      expect(conn.descriptors.map((d) => d.toolKey)).toEqual(['mcp_bad_good']);
      expect(conn.refused.map((r) => [r.server, r.reason.includes('"scalar_root"')])).toEqual([['bad', true]]);
      expect(conn.diagnostics.map((d) => d.status)).toEqual(['connected']);
      expect(logs.filter((m) => m.includes('"scalar_root" is not offered'))).toHaveLength(1);
      await expect(conn.call('bad', 'good', { q: 'x' })).resolves.toBe('ran good');
    } finally {
      await conn.close();
    }
  });
});

const USAGE = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };

/** One session and one echo server for every surface case: a session's startup and an MCP connection cost seconds
 *  each, and no case here depends on another's turn. Each case sets the script its turns answer from. */
describe('LocalAgentSession MCP surface', () => {
  let script: (options: ScriptedTurnOptions) => ScriptedTurnResult = () => ({
    content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: undefined }, usage: USAGE, warnings: [],
  });

  const shared = sessionWithModel(scriptedTurnModel({ doGenerate: (options) => script(options) }));

  beforeAll(async () => { await shared.session.connectMcp(mcpServers()); });
  afterAll(async () => { await shared.session.end(); });

  test.each([false, true])('MCP isError=%s decides the eval call outcome, not content fields', async (fail) => {
    const text = '{"reason":"denied","error":"historical incident"}';
    const code = `return await tools["mcp_echo_echo"](${JSON.stringify({ text, fail })});`;
    const toolCallId = `mcp-outcome-${String(fail)}`;
    let step = 0;

    script = () => (++step === 1
      ? { content: [{ type: 'tool-call', toolCallId, toolName: 'eval', input: JSON.stringify({ code }) }], finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE, warnings: [] }
      : { content: [{ type: 'text', text: 'done' }], finishReason: { unified: 'stop', raw: undefined }, usage: USAGE, warnings: [] });

    await shared.session.send('Call the MCP tool.', { id: crypto.randomUUID() });
    const result = shared.events.find((event) => event.type === 'tool-result' && event.toolName === 'eval' && event.toolCallId === toolCallId);

    if (fail) {
      expect(result).toMatchObject({ success: false, result: expect.stringContaining('remote failure') });
    } else {
      expect(result).toMatchObject({ success: true, output: { result: 'echo: ' + text } });
    }
  });

  test('connected MCP tools appear in /tools and reach the next turn through eval, not as native tools', async () => {
    let captured: CapturedRequest = { native: [], prompt: '' };

    script = (options) => {
      captured = { native: (options.tools ?? []).map((t) => t.name), prompt: JSON.stringify(options.prompt) };

      return { content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: undefined }, usage: USAGE, warnings: [] };
    };

    expect(shared.session.toolNames()).toContain('mcp_echo_echo');
    expect(shared.session.describeTools().some((t) => t.name === 'mcp_echo_echo' && t.description.includes('Echo'))).toBe(true);

    await shared.session.send('which tools can you see?', { id: crypto.randomUUID() });
    expect(captured.native).toContain('eval');
    expect(captured.native).not.toContain('mcp_echo_echo');
    expect(captured.prompt).toContain('tools[\\"mcp_echo_echo\\"]');
  });
});

// m1984: a turn that cannot reach MCP tools, as `eval` is their only way in, was still told which servers were down.
describe('a server that is down is named only to a turn that can reach MCP tools', () => {
  test('a build turn is told the server is down; a planning turn, whose eval is refused, is told nothing of MCP', async () => {
    const told: Record<string, boolean> = {};

    for (const role of ['task', 'planner'] as const) {
      let prompt = '';
      const { session } = sessionWithModel(capturingModel((request) => { prompt = request.prompt; }));

      try {
        await session.connectMcp({ ...mcpServers(), down: { command: 'node', args: [scratchPath('mcp', 'no-such-server.mjs')] } });
        await session.setRole(role);
        await session.send('what can you reach?', { id: crypto.randomUUID() });
        told[role] = prompt.includes('MCP server \\"down\\"');
      } finally {
        await session.end();
      }
    }

    expect(told).toEqual({ task: true, planner: false });
  });
});

/** What the request's latest context declares; an earlier turn's block stays in the history it was sent in. */
function latestDeclarations(prompt: string): string {
  return prompt.slice(prompt.lastIndexOf('MCP and extension tools available through eval'));
}

/** Two models known by their windows: the session switches between them through its public `setModel`. */
function sessionWithWindows(model: LanguageModel, windows: Readonly<Record<string, number>>) {
  const db = workspaceDatabase(scratchPath('mcp', 'agent.db'), { create: true });
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { cwd: scratchDir('workspace-folder'), llm: DUMMY_LLM });

  rt.actor.config.setLearning(false);

  const modelResolver: LocalModelResolver = {
    normalizeSpecSync: (spec) => (spec === null || spec === undefined || spec.trim() === '' ? 'local/small' : spec.trim()),
    resolveModel: () => model,
    credentialFor: async () => null,
    listProviders: async () => [],
    listModels: async () => ({ models: Object.keys(windows).map((spec) => ({ provider: 'local', id: spec.slice('local/'.length), label: spec })), failures: [] }),
    modelInfo: async (spec) => ({ id: spec ?? 'local/small', contextWindow: windows[spec ?? 'local/small'], modelOutputLimit: 4_000 }),
    countInputTokens: async () => ({ kind: 'unsupported', provider: 'local', reason: 'no endpoint behind the stand-in' }),
    getAuth: async () => null,
  };

  rt.actor.config.setModel('local/small');
  const authority = createLocalProfileAuthority({ config: rt.actor.config, plane: resolverModelPlane(modelResolver) });

  const events: SessionEvent[] = [];

  const session = new LocalAgentSession({
    rt, db, model, modelResolver, onEvent: (e) => events.push(e),
    profileAuthority: () => authority.envelope(),
  });

  return { session, events };
}

describe('LocalAgentSession MCP admission', () => {
  // Rank 26: the CLI admitted the catalog once, at connect, against whatever window it had then.
  test("a model switch re-admits the catalog against the new model's window, both ways", async () => {
    let captured = '';

    const { session } = sessionWithWindows(capturingModel((request) => { captured = request.prompt; }), {
      'local/small': 128_000, 'local/large': 4_000_000,
    });

    try {
      await session.connectMcp(mcpServers());
      await session.send('which tools can you see?', { id: crypto.randomUUID() });
      expect(latestDeclarations(captured)).toContain('tools[\\"mcp_echo_echo\\"]');
      expect(latestDeclarations(captured)).not.toContain('mcp_echo_huge');

      await session.setModel('local/large');
      await session.send('and now?', { id: crypto.randomUUID() });
      expect(latestDeclarations(captured)).toContain('tools[\\"mcp_echo_huge\\"]');

      await session.setModel('local/small');
      await session.send('and now?', { id: crypto.randomUUID() });
      expect(latestDeclarations(captured)).toContain('tools[\\"mcp_echo_echo\\"]');
      expect(latestDeclarations(captured)).not.toContain('mcp_echo_huge');
    } finally {
      await session.end();
    }
  });

  test('a tool larger than the session step allocation is deferred with its arithmetic', async () => {
    // `huge` carries ~600KB each of description and schema against a ~113k-token step remainder;
    // schemas are never truncated, so it defers whole.
    let captured: CapturedRequest = { native: [], prompt: '' };
    const { session, events } = sessionWithWindows(capturingModel((request) => { captured = request; }), { 'local/small': 128_000 });

    try {
      await session.connectMcp(mcpServers());
      expect(session.toolNames()).toContain('mcp_echo_echo');
      expect(session.toolNames()).not.toContain('mcp_echo_huge');

      await session.send('which tools can you see?', { id: crypto.randomUUID() });
      expect(captured.prompt).toContain('tools[\\"mcp_echo_echo\\"]');
      expect(captured.prompt).not.toContain('mcp_echo_huge');

      const deferrals: string[] = [];

      for (const e of events) {
        if (e.type === 'background' && e.event === 'mcp' && e.message.includes('deferred')) {
          deferrals.push(e.message);
        }
      }

      expect(deferrals).toHaveLength(1);
      expect(deferrals[0]).toContain('mcp: echo deferred:');
      expect(deferrals[0]).toContain('did not fit this turn');
      expect(deferrals[0]).toContain('remaining tool budget of');
    } finally {
      await session.end();
    }
  });

  test('tools admit in (server, tool) order regardless of config map order', async () => {
    // Admission sorts by (server, tool) name, not config key order: `zulu` is configured first and must still lose.
    const { session } = sessionWithWindows(capturingModel(() => {}), { 'local/small': 128_000 });

    try {
      await session.connectMcp({
        zulu: { command: 'node', args: [fixtureServer] },
        alpha: { command: 'node', args: [fixtureServer] },
      });
      expect(session.toolNames().filter((name) => isMcpToolKey(name))).toEqual([
        'mcp_alpha_echo', 'mcp_alpha_held',
        'mcp_zulu_echo', 'mcp_zulu_held',
      ]);
    } finally {
      await session.end();
    }
  });
});
