import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { GITHUB_MCP_TOOLS } from '@kinu.run/test-utils/github-mcp-catalog';

/** GitHub's catalog over stdio, and one tool that carries no description, as some servers' do. */
const UNDESCRIBED = { name: 'archive_000', inputSchema: { type: 'object' as const, properties: { record: { type: 'string' } }, required: ['record'] } };

const server = new Server({ name: 'github-catalog', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...GITHUB_MCP_TOOLS, UNDESCRIBED] }));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
  content: [{ type: 'text', text: JSON.stringify({ tool: params.name, input: params.arguments }) }],
  structuredContent: { tool: params.name, input: params.arguments },
}));

await server.connect(new StdioServerTransport());
