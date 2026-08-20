#!/usr/bin/env bun
/**
 * The research eval's controlled source, as a REAL stdio MCP server.
 *
 * The eval spawns this through `LocalAgentSession.connectMcp` — the same
 * `connectMcpServers` path `kinu chat` takes for a user's configured servers
 * — so what is under test is the product's own MCP client: discovery, the
 * `mcp_<server>_<tool>` keying, the result clamp, and the turn surface merge.
 * A workspace-file stand-in would test none of that, and the file tool instead.
 *
 * Low-level `Server` + JSON-Schema tool declarations rather than the SDK's zod
 * conveniences: the fixture owns two static tools, and arguments are parsed at
 * the call boundary with the repo's own valibot, so a bad call is refused by
 * the field it got wrong rather than answered with everything.
 *
 * TWO tools on purpose. Search returns ids and titles, read returns one body —
 * so answering requires at least one search and two reads, which is what makes
 * "the agent used the controlled channel" a claim about research behaviour
 * rather than about a single lucky call.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as v from 'valibot';

import { ENTRIES } from './veldmar-corpus';

const server = new Server(
  { name: 'veldmar-archive', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: 'archive_search',
      description: 'Search the Veldmar Hollow archive. Returns entry ids, titles and a snippet '
        + 'for every entry matching any query term; read an entry with archive_read.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'search terms' } },
        required: ['query'],
      },
    },
    {
      name: 'archive_read',
      description: 'Read one archive entry in full, by the id archive_search returned.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'entry id from archive_search' } },
        required: ['id'],
      },
    },
  ],
}));

/** Case-insensitive any-term match over title+body. Terms under three chars are
 *  ignored so "the" does not return the whole archive; a query with no usable
 *  term is refused by name rather than answered with everything. */
function search(query: string): string {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  if (terms.length === 0) {
    return `no usable search term in ${JSON.stringify(query)} — terms under three characters are ignored`;
  }
  const hits = ENTRIES.filter((entry) => {
    const haystack = `${entry.title}\n${entry.body}`.toLowerCase();
    return terms.some((term) => haystack.includes(term));
  });
  if (hits.length === 0) return `no entry matches ${JSON.stringify(query)}`;
  return hits
    .map((hit) => `${hit.id} — ${hit.title}\n  ${hit.body.slice(0, 120).replace(/\n/g, ' ')}…`)
    .join('\n');
}

function read(id: string): string {
  const entry = ENTRIES.find((candidate) => candidate.id === id);
  if (!entry) {
    return `no entry ${JSON.stringify(id)} — the archive holds: ${ENTRIES.map((e) => e.id).join(', ')}`;
  }
  return `# ${entry.title}\n\n${entry.body}`;
}

const SearchArgsSchema = v.object({ query: v.string() });
const ReadArgsSchema = v.object({ id: v.string() });

server.setRequestHandler(CallToolRequestSchema, (request) => {
  const args: unknown = request.params.arguments ?? {};
  let text: string;
  switch (request.params.name) {
    case 'archive_search': {
      const parsed = v.safeParse(SearchArgsSchema, args);
      text = parsed.success ? search(parsed.output.query) : 'archive_search: `query` must be a string';
      break;
    }
    case 'archive_read': {
      const parsed = v.safeParse(ReadArgsSchema, args);
      text = parsed.success ? read(parsed.output.id) : 'archive_read: `id` must be a string';
      break;
    }
    default:
      text = `unknown tool ${JSON.stringify(request.params.name)}`;
  }
  return { content: [{ type: 'text', text }] };
});

await server.connect(new StdioServerTransport());
