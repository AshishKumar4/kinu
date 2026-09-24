// Lists one usable tool and one whose input schema root is not an object, which the MCP spec forbids.
// The handlers sit on the protocol server because the high-level API cannot emit a non-object root.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const mcp = new McpServer({ name: 'bad-root', version: '0.0.1' }, { capabilities: { tools: {} } });

mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'good', description: 'Answers.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
    { name: 'scalar_root', description: 'Its root schema is a string.', inputSchema: { type: 'string' } },
  ],
}));

mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: 'text', text: `ran ${request.params.name}` }] }));

await mcp.connect(new StdioServerTransport());

const stop = () => process.exit(0);

process.stdin.once('end', stop);

process.once('SIGTERM', stop);
