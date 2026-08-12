// Local MCP integration — verifies that the CLI backend can connect to a stdio
// MCP server, expose its tools, proxy calls, and merge them into a local turn.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import { mcpToolKey, type LLMProviderConfig } from '@proteus/core';
import { createCLIRuntime } from '../src/runtime.js';
import { LocalAgentSession, type SessionEvent } from '../src/local-session.js';
import { connectMcpServers } from '../src/mcp.js';
import { toolExecute } from '@proteus/test-utils';

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
  return {
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doStream: async (options: { tools?: Array<{ name: string }> }) => {
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
  } as unknown as LanguageModel;
}

function sessionWithModel(model: LanguageModel) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT 'default', parent_id TEXT,
    role TEXT NOT NULL, content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
  const rt = createCLIRuntime(db as never, {
    dbPath: `/tmp/proteus-mcp-test-${Math.floor(performance.now())}.db`,
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
    // reference to an MCP tool was portable. Both now go through mcpToolKey.
    const conn = await connectMcpServers(mcpServers());
    try {
      expect(Object.keys(conn.tools)).toEqual(
        [mcpToolKey('echo', 'echo'), mcpToolKey('echo', 'slow')],
      );
    } finally {
      await conn.close();
    }
  });

  test('a tool call gets the full call budget, not the startup budget', async () => {
    // The 5s startup timeout used to apply to tool calls too, so any MCP tool
    // doing real work (a fetch, a query, a build) failed. The fixture sleeps
    // past that budget; cfg.timeoutMs still bounds it.
    const conn = await connectMcpServers({
      echo: { command: 'node', args: [fixtureServer] },
    });
    try {
      const slow = toolExecute<unknown, string>(conn.tools[mcpToolKey('echo', 'slow')]);
      await expect(slow({ ms: 6_000 })).resolves.toBe('slept 6000ms');
    } finally {
      await conn.close();
    }
  }, 20_000);

  test('connects to a stdio MCP server, lists tools, and proxies a call', async () => {
    const logs: string[] = [];
    const conn = await connectMcpServers(mcpServers(), (msg) => logs.push(msg));
    try {
      expect(Object.keys(conn.tools)).toEqual(['mcp_echo_echo', 'mcp_echo_slow']);
      expect(conn.diagnostics).toEqual([{ server: 'echo', status: 'connected', toolCount: 2 }]);
      expect(logs.some((m) => m.includes('mcp: echo'))).toBe(true);
      const echo = toolExecute<unknown, string>(conn.tools.mcp_echo_echo);
      await expect(echo({ text: 'hello' })).resolves.toBe('echo: hello');
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
