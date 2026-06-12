// Local MCP integration — verifies that the CLI backend can connect to a stdio
// MCP server, expose its tools, proxy calls, and merge them into a local turn.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import type { LLMProviderConfig } from '@proteus/core';
import { createCLIRuntime } from '../src/runtime.js';
import { LocalAgentSession, type SessionEvent } from '../src/local-session.js';
import { connectMcpServers } from '../src/mcp.js';

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
  test('connects to a stdio MCP server, lists tools, and proxies a call', async () => {
    const logs: string[] = [];
    const conn = await connectMcpServers(mcpServers(), (msg) => logs.push(msg));
    try {
      expect(Object.keys(conn.tools)).toEqual(['mcp_echo_echo']);
      expect(conn.diagnostics).toEqual([{ server: 'echo', status: 'connected', toolCount: 1 }]);
      expect(logs.some((m) => m.includes('mcp: echo'))).toBe(true);
      const tool = conn.tools.mcp_echo_echo as { execute(input: unknown): Promise<string> };
      await expect(tool.execute({ text: 'hello' })).resolves.toBe('echo: hello');
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
