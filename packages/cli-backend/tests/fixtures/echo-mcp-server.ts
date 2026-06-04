// Minimal stdio MCP server fixture — one `echo` tool. Spawned by the local-MCP
// integration test to exercise connect → listTools → callTool end to end.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo-server', version: '0.0.1' });
server.registerTool(
  'echo',
  { description: 'Echo the input text back.', inputSchema: { text: z.string() } },
  async ({ text }: { text: string }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
);
await server.connect(new StdioServerTransport());
