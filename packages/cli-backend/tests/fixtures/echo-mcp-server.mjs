import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo-server', version: '0.0.1' });

server.registerTool(
  'echo',
  { description: 'Echo the input text back.', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
);

await server.connect(new StdioServerTransport());
process.stdin.resume();

const keepAlive = setInterval(() => undefined, 60_000);
process.once('SIGTERM', () => {
  clearInterval(keepAlive);
  process.exit(0);
});
