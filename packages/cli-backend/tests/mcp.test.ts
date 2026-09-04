// Local MCP integration — verifies that the CLI backend can connect to a stdio
// MCP server, expose its tools, proxy calls, and merge them into a local turn.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import { TestLanguageModelV2 } from './test-language-model';
import { isMcpToolKey, mcpToolKey, type LLMProviderConfig } from '@kinu.run/core';
import { createCLIRuntime } from '../src/runtime';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';
import { connectMcpServers } from '../src/mcp';
import { scratchPath } from '@kinu.run/test-utils';

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
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT 'default', parent_id TEXT,
    role TEXT NOT NULL, content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
  const rt = createCLIRuntime(db, {
    dbPath: scratchPath('mcp', 'agent.db'),
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

  test('a tool call gets the full call budget, not the startup budget', async () => {
    // The 5s startup timeout used to apply to tool calls too, so any MCP tool
    // doing real work (a fetch, a query, a build) failed. The fixture sleeps
    // past that budget; cfg.timeoutMs still bounds it.
    const conn = await connectMcpServers({
      echo: { command: 'node', args: [fixtureServer] },
    });
    try {
      await expect(conn.call('echo', 'slow', { ms: 6_000 })).resolves.toBe('slept 6000ms');
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
    } finally {
      await conn.close();
    }
  });
});

describe('LocalAgentSession MCP surface', () => {
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
