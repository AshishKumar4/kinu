import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { largeMcpCatalog } from './large-mcp-catalog';

const server = new Server({ name: 'large-catalog', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: largeMcpCatalog }));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
  content: [{ type: 'text', text: JSON.stringify({ tool: params.name, input: params.arguments }) }],
  structuredContent: { tool: params.name, input: params.arguments },
}));

await server.connect(new StdioServerTransport());
