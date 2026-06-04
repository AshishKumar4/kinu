// Local MCP — connect the CLI agent to configured stdio MCP servers, discover
// their tools, and expose them as ai-SDK tools merged into the agent's surface
// (the BackendHost.resolveExtraTools seam). The cf backend reaches MCP via the
// per-user UserDO; locally we are the MCP CLIENT directly over child processes.

import { tool, jsonSchema, type ToolSet } from 'ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

/** One stdio MCP server (the standard mcpServers config shape). */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConnection {
  /** Discovered tools, keyed `mcp_<server>_<tool>`. */
  readonly tools: ToolSet;
  /** Disconnect every server (kills the child processes). */
  close(): Promise<void>;
}

/**
 * Connect to each configured stdio MCP server, list its tools, and wrap them as
 * ai-SDK tools that proxy back over MCP. A server that fails to start is logged
 * and skipped — the rest still load. Empty config ⇒ a no-op connection.
 */
export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
  onLog?: (msg: string) => void,
): Promise<McpConnection> {
  const clients: Client[] = [];
  const tools: ToolSet = {};

  for (const [serverName, cfg] of Object.entries(servers)) {
    try {
      const client = new Client({ name: 'proteus-cli', version: '0.1.0' });
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: cfg.env ? { ...getDefaultEnvironment(), ...cfg.env } : getDefaultEnvironment(),
      });
      await client.connect(transport);
      const { tools: mcpTools } = await client.listTools();
      for (const t of mcpTools) {
        tools[`mcp_${serverName}_${t.name}`] = tool({
          description: t.description ?? `${serverName}/${t.name}`,
          inputSchema: jsonSchema((t.inputSchema ?? { type: 'object' }) as Parameters<typeof jsonSchema>[0]),
          execute: async (args: unknown) => {
            try {
              const res = await client.callTool({ name: t.name, arguments: (args ?? {}) as Record<string, unknown> });
              return formatMcpResult(res as McpToolResult);
            } catch (err) {
              return `mcp error: ${err instanceof Error ? err.message : String(err)}`;
            }
          },
        });
      }
      clients.push(client);
      onLog?.(`mcp: ${serverName} → ${mcpTools.length} tool(s)`);
    } catch (err) {
      onLog?.(`mcp: ${serverName} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    tools,
    async close() {
      for (const c of clients) { try { await c.close(); } catch { /* best effort */ } }
    },
  };
}

interface McpToolResult { content?: Array<{ type: string; text?: string }>; isError?: boolean }

/** Flatten an MCP CallTool result's content blocks into a string the model reads. */
function formatMcpResult(res: McpToolResult): string {
  const content = Array.isArray(res?.content) ? res.content : [];
  const text = content.map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`)).join('\n');
  return (res?.isError ? 'MCP tool error: ' : '') + (text || '(no output)');
}
