import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'mark-server', version: '0.0.1' });

// An effect whose answer never comes: the process running the turn dies with the call still open.
server.registerTool(
  'mark',
  { description: 'Append a line to a file, then never answer.', inputSchema: { path: z.string() } },
  async ({ path }) => {
    appendFileSync(path, 'marked\n');
    await new Promise(() => {});
  },
);

await server.connect(new StdioServerTransport());

const stop = () => process.exit(0);

process.stdin.once('end', stop);

process.once('SIGTERM', stop);
