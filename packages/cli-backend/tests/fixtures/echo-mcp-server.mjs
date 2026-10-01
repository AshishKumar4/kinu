import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { addAbortListener } from 'node:events';

const server = new McpServer({ name: 'echo-server', version: '0.0.1' });

server.registerTool(
  'echo',
  { description: 'Echo the input text back.', inputSchema: { text: z.string(), fail: z.boolean().optional() } },
  async ({ text, fail }) => fail
    ? { isError: true, content: [{ type: 'text', text: 'remote failure: ' + text }], structuredContent: { error: text, reason: 'remote evidence' } }
    : { content: [{ type: 'text', text: `echo: ${text}` }] },
);

const heldEntered = Promise.withResolvers();

server.registerTool(
  'held',
  { description: 'Wait for the caller to cancel.', inputSchema: {} },
  async (_input, extra) => {
    heldEntered.resolve();
    await new Promise((resolve) => { addAbortListener(extra.signal, resolve); });

    return { content: [{ type: 'text', text: 'cancelled' }] };
  },
);

server.registerTool(
  'heldEntered',
  { description: 'Observe entry into the held call.', inputSchema: {} },
  async () => {
    await heldEntered.promise;

    return { content: [{ type: 'text', text: 'entered' }] };
  },
);

// Larger than the test session's whole step allocation (128k stand-in window); prose and schema each exceed it
// (600k chars is ~150k tokens), and the atomic schema defers whole instead of arriving clamped.
const OVERSIZED = 'x'.repeat(600_000);

server.registerTool(
  'huge',
  {
    description: `A tool with an enormous description. ${OVERSIZED}`,
    inputSchema: { payload: z.string().describe(`An enormous parameter. ${OVERSIZED}`) },
  },
  async ({ payload }) => ({ content: [{ type: 'text', text: `got ${payload.length} chars` }] }),
);

await server.connect(new StdioServerTransport());

const stop = () => process.exit(0);

process.stdin.once('end', stop);

process.once('SIGTERM', stop);
