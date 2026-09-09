// Local MCP integration — verifies that the CLI backend can connect to a stdio
// MCP server, expose its tools, proxy calls, and merge them into a local turn.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import { TestLanguageModelV2 } from './test-language-model';
import { isMcpToolKey, mcpToolKey, type LLMProviderConfig } from '@kinu.run/core';
import { initWorkspaceSchema } from '@kinu.run/core';
import { createCLIRuntime , makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';
import { connectMcpServers } from '../src/mcp';
import { scratchPath, scriptedTurnModel } from '@kinu.run/test-utils';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

const fixtureServer = new URL('./fixtures/echo-mcp-server.mjs', import.meta.url).pathname;

function mcpServers() {
  return {
    echo: {
      command: 'node',
      args: [fixtureServer],
    },
  };
}

function capturingModel(sink: (toolNames: string[]) => void): LanguageModel {
  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async (options) => {
      sink((options.tools ?? []).map((t) => t.name));
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
  // The declared path, not `:memory:`: `createCLIRuntime` binds this actor by
  // reading the database's own filename back, and refuses a runtime whose path
  // does not match it (`requireLocalDatabasePath`).
  const db = new Database(scratchPath('mcp', 'agent.db'), { create: true });
  // THE PRODUCTION INITIALIZER, not a copy of its DDL. A fixture that
  // re-declared `messages` won the CREATE TABLE IF NOT EXISTS race and
  // silently pinned a schema nothing else maintains.
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, {
    dbPath: db.filename,
    llm: DUMMY_LLM,
  });
  const events: SessionEvent[] = [];
  const session = new LocalAgentSession({
    rt, db, model, onEvent: (e) => events.push(e), noAutoEvolve: true,
  });
  return { session, events };
}

describe('connectMcpServers', () => {
  test('keys tools with the same core rule the cf backend uses', async () => {
    // A prompt or skill that names an MCP tool has to resolve to the same tool
    // on both backends. cf used to key on its random registration id
    // (`tool_<nanoid>_<name>`) while the CLI keyed on the server name — so no
    // reference to an MCP tool was portable. Both now go through mcpToolKey,
    // via core's `describeMcpTool`.
    const conn = await connectMcpServers(mcpServers());
    try {
      expect(conn.descriptors.map((d) => d.toolKey)).toEqual(
        [mcpToolKey('echo', 'echo'), mcpToolKey('echo', 'slow'), mcpToolKey('echo', 'huge')],
      );
    } finally {
      await conn.close();
    }
  // Measured 2.6 s on a box at load 66-98 (2026-09-02 sweep, foreign mutation jobs on all
  // 24 threads), where bun's default 5 s bound read red and the test is green alone. A bound
  // on a finite run, stated with its measurement, not a detector.
  }, 15_000);

  test('a tool call outlives every bound this module used to impose', async () => {
    // The 5s startup timeout used to apply to tool calls too, and then a 60s
    // SDK default replaced it. Neither is here now: the fixture sleeps past the
    // first, and only a server's own `timeoutMs` config would bound it.
    const conn = await connectMcpServers({
      echo: { command: 'node', args: [fixtureServer] },
    });
    try {
      await expect(conn.call('echo', 'slow', { ms: 6_000 })).resolves.toBe('slept 6000ms');
    } finally {
      await conn.close();
    }
  }, 20_000);

  test('the caller cancels a running tool call; nothing else ends it early', async () => {
    const conn = await connectMcpServers({
      echo: { command: 'node', args: [fixtureServer] },
    });
    try {
      const stop = new AbortController();
      const running = conn.call('echo', 'slow', { ms: 30_000 }, stop.signal);
      const started = Date.now();
      stop.abort();
      await expect(running).rejects.toBeInstanceOf(Error);
      // The rejection is the abort, not a wait for the fixture's own sleep.
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await conn.close();
    }
  }, 20_000);

  test('connects to a stdio MCP server, lists tools, and proxies a call', async () => {
    const logs: string[] = [];
    const conn = await connectMcpServers(mcpServers(), (msg) => logs.push(msg));
    try {
      expect(conn.descriptors.map((d) => d.toolKey))
        .toEqual(['mcp_echo_echo', 'mcp_echo_slow', 'mcp_echo_huge']);
      expect(conn.diagnostics).toEqual([{ server: 'echo', status: 'connected', toolCount: 3 }]);
      expect(logs.some((m) => m.includes('mcp: echo'))).toBe(true);
      await expect(conn.call('echo', 'echo', { text: 'hello' })).resolves.toBe('echo: hello');
      await conn.close();
      await expect(conn.call('echo', 'echo', { text: 'after disconnect' })).rejects.toBeInstanceOf(Error);
    } finally {
      await conn.close();
    }
  });
});

describe('LocalAgentSession MCP surface', () => {
  test.each([false, true])('MCP isError=%s determines the native SDK outcome, not content fields', async (fail) => {
    const text = '{"reason":"denied","error":"historical incident"}';
    let step = 0;
    const model = scriptedTurnModel({ doGenerate: () => ({
      content: ++step === 1
        ? [{ type: 'tool-call', toolCallId: 'mcp-outcome', toolName: 'mcp_echo_echo', input: JSON.stringify({ text, fail }) }]
        : [{ type: 'text', text: 'done' }],
      finishReason: { unified: step === 1 ? 'tool-calls' : 'stop', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
      warnings: [],
    }) });
    const { session, events } = sessionWithModel(model);
    try {
      await session.connectMcp(mcpServers());
      await session.send('Call the MCP tool.');
      const result = events.find((event) => event.type === 'tool-result' && event.toolName === 'mcp_echo_echo');
      if (fail) {
        expect(result).toMatchObject({ success: false, reason: null, result: expect.stringContaining('remote failure') });
        expect(result).not.toHaveProperty('execution');
      } else {
        expect(result).toMatchObject({ success: true, result: 'echo: ' + text });
      }
    } finally { await session.end(); }
  });

  test('connected MCP tools appear in /tools and in the next model turn', async () => {
    let captured: string[] = [];
    const { session } = sessionWithModel(capturingModel((tools) => { captured = tools; }));
    try {
      await session.connectMcp(mcpServers());
      expect(session.toolNames()).toContain('mcp_echo_echo');
      expect(session.describeTools().some((t) => t.name === 'mcp_echo_echo' && t.description.includes('Echo'))).toBe(true);

      await session.send('which tools can you see?');
      expect(captured).toContain('mcp_echo_echo');
    } finally {
      await session.end();
    }
  });
});
describe('LocalAgentSession MCP admission', () => {
  test('a tool larger than the session step allocation is deferred with its arithmetic', async () => {
    // The fixture's `huge` tool carries ~300KB of description and ~300KB of
    // schema against a ~53k-token step remainder: its schema alone cannot fit,
    // and schemas are never truncated, so it defers whole. Red before the
    // admission: the turn carried all 600KB and nothing reported a bound.
    let captured: string[] = [];
    const { session, events } = sessionWithModel(capturingModel((tools) => { captured = tools; }));
    try {
      await session.connectMcp(mcpServers());
      expect(session.toolNames()).toContain('mcp_echo_echo');
      expect(session.toolNames()).not.toContain('mcp_echo_huge');

      await session.send('which tools can you see?');
      expect(captured).toContain('mcp_echo_echo');
      expect(captured).not.toContain('mcp_echo_huge');

      const deferrals: string[] = [];
      for (const e of events) {
        if (e.type === 'background' && e.event === 'mcp' && e.message.includes('deferred')) {
          deferrals.push(e.message);
        }
      }
      expect(deferrals).toHaveLength(1);
      expect(deferrals[0]).toContain('mcp: echo deferred:');
      // The arithmetic the admission reports: what did not fit, out of what.
      expect(deferrals[0]).toContain('did not fit this turn');
      expect(deferrals[0]).toContain('remaining tool budget of');
    } finally {
      await session.end();
    }
  }, 30_000);

  test('tools admit in (server, tool) order regardless of config map order', async () => {
    // The admitted set must be the same on two sessions that configure the
    // same servers: admission sorts by (server, tool) name, not by the config
    // object's key order. `zulu` is configured first here and must still lose.
    const { session } = sessionWithModel(capturingModel(() => {}));
    try {
      await session.connectMcp({
        zulu: { command: 'node', args: [fixtureServer] },
        alpha: { command: 'node', args: [fixtureServer] },
      });
      expect(session.toolNames().filter((name) => isMcpToolKey(name))).toEqual([
        // `huge` defers on both servers (its schema alone exceeds the
        // remainder), so the admitted set is the four small tools — still in
        // (server, tool) order despite `zulu` being configured first.
        'mcp_alpha_echo', 'mcp_alpha_slow',
        'mcp_zulu_echo', 'mcp_zulu_slow',
      ]);
    } finally {
      await session.end();
    }
  }, 30_000);
});
