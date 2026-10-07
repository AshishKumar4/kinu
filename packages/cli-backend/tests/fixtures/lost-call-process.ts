// The process that dies: a CLI session whose turn calls the marker MCP tool through `eval`, the tool marks a file and
// never answers, and the test kills this process there. Arguments: the database path, the marks file, the workspace.
import { workspaceDatabase } from '@kinu.run/test-utils';
import { initWorkspaceSchema, mcpToolKey, type LLMProviderConfig } from '@kinu.run/core';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../../src/runtime';
import { LocalAgentSession } from '../../src/local-session';
import { TestLanguageModelV2 } from '../test-language-model';

const [dbPath = '', marks = '', cwd = ''] = process.argv.slice(2);

const DUMMY_LLM: LLMProviderConfig = { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model' };

const db = workspaceDatabase(dbPath);

initWorkspaceSchema(makeWorkspaceSchemaSql(db));

const rt = createCLIRuntime(db, { cwd, llm: DUMMY_LLM });

rt.actor.config.setLearning(false);

const code = `return await tools[${JSON.stringify(mcpToolKey('marker', 'mark'))}](${JSON.stringify({ path: marks })});`;

const session = new LocalAgentSession({
  rt, db,
  model: new TestLanguageModelV2({
    provider: 'fake', modelId: 'fake-model',
    doStream: async () => ({
      stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({ type: 'tool-call', toolCallId: 'call-mark', toolName: 'eval', input: JSON.stringify({ code }) });
        controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 } });
        controller.close();
      } }),
      response: { headers: {} },
    }),
  }),
  onEvent: () => {},
});

await session.connectMcp({ marker: { command: 'node', args: [new URL('./mark-mcp-server.mjs', import.meta.url).pathname] } });

await session.send('mark the file', { id: crypto.randomUUID() });
