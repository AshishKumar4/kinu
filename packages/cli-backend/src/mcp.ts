// Local MCP — connect the CLI agent to configured stdio MCP servers, discover
// their tools, and expose them as ai-SDK tools merged into the agent's surface.
// The cf backend reaches MCP via the per-user UserDO; locally we are the MCP
// CLIENT directly over child processes.

import { tool, jsonSchema, type ToolSet } from 'ai';
import { JsonObjectSchema, mcpToolKey } from '@kinu.run/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as v from 'valibot';
import { renderThrownChain } from '@kinu.run/core/obs';

/**
 * Startup budget for spawning a stdio child and listing its tools.
 *
 * THIS IS A SETUP COMMAND, NOT A TURN. `connectMcpServers` is reached only from
 * `LocalSession.connectMcp`, and that is called once at session open —
 * `agent-host/host.ts` while building the session entry, and
 * `cli/src/local-agent-client.ts`'s `connect()` before any `send()`. The tools it
 * returns are merged into the session's surface once and reused by every turn
 * after, so nothing here runs on a turn's critical path.
 *
 * That is why the bound stays while cf-backend's mirror of it is gone. cf read
 * its MCP surface per turn and had no place to defer to but the next turn, so a
 * deadline there bounded the wrong thing (and, because hydration awaited the
 * connect before the timer started, bounded nothing at all). Here there is no
 * next turn to defer to: the process connects once, an interactive `kinu` is
 * waiting on it, and a hung `npx` resolving a package would hang startup with no
 * turn to report into.
 *
 * PENDING MEASUREMENT, and named as such rather than defended: 5_000 is a round
 * number and what it bounds is a THIRD-PARTY process starting up. A vendored
 * binary is milliseconds; an `npx`-launched server on a cold cache is not, and
 * nothing records either. Missing it costs that server's tools for the session
 * with a diagnostic the model is shown (`LocalSession.mcpUnavailable`), so the
 * failure is reported rather than silent. The measurement that settles it:
 * connect-to-listTools wall clock for one vendored and one `npx` server, cold
 * and warm.
 */
const MCP_STARTUP_TIMEOUT_MS = 5_000;

/** A tool CALL is the server doing real work — a fetch, a query, a build — and
 *  gets the MCP SDK's own default, which is what cf's dispatch path uses too.
 *  The 5s startup budget used to apply here as well, which killed any MCP tool
 *  that took longer than a trivial round-trip. Per-server `timeoutMs` overrides. */
const MCP_CALL_TIMEOUT_MS = 60_000;

/** One stdio MCP server (the standard mcpServers config shape). */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Per-call timeout in ms for this server's tools (default 60s). */
  timeoutMs?: number;
}

export interface McpConnection {
  /** Discovered tools, keyed by core's `mcpToolKey` — `mcp_<server>_<tool>`. */
  readonly tools: ToolSet;
  /** Per-server connection status for UI/CLI diagnostics. */
  readonly diagnostics: McpConnectionDiagnostic[];
  /** Disconnect every server (kills the child processes). */
  close(): Promise<void>;
}

export interface McpConnectionDiagnostic {
  server: string;
  status: 'connected' | 'failed';
  toolCount: number;
  reason?: string;
  stderr?: string;
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
  const diagnostics: McpConnectionDiagnostic[] = [];

  for (const [serverName, cfg] of Object.entries(servers)) {
    const client = new Client({ name: 'kinu-cli', version: '0.1.0' });
    let stderr = '';
    try {
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: cfg.env,
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-4_000);
      });
      await client.connect(transport, { timeout: MCP_STARTUP_TIMEOUT_MS });
      const { tools: mcpTools } = await client.listTools(undefined, { timeout: MCP_STARTUP_TIMEOUT_MS });
      const callTimeout = cfg.timeoutMs ?? MCP_CALL_TIMEOUT_MS;
      for (const t of mcpTools) {
        tools[mcpToolKey(serverName, t.name)] = tool({
          description: t.description ?? `${serverName}/${t.name}`,
          inputSchema: jsonSchema(t.inputSchema ?? { type: 'object' }),
          execute: async (args) => {
            try {
              const res = await client.callTool(
                { name: t.name, arguments: v.parse(JsonObjectSchema, args ?? {}) },
                undefined,
                { timeout: callTimeout },
              );
              return formatMcpResult(res);
            } catch (err) {
              return `mcp error: ${renderThrownChain({ cause: err })}`;
            }
          },
        });
      }
      clients.push(client);
      diagnostics.push({ server: serverName, status: 'connected', toolCount: mcpTools.length });
      onLog?.(`mcp: ${serverName} → ${mcpTools.length} tool(s)`);
    } catch (err) {
      // The connect failure is this server's diagnostic. A close that ALSO fails
      // on the half-open transport is a second, different fact — a child process
      // still running — so it is appended to the reason instead of dropped,
      // which is what made a leaked server read as a clean skip.
      const reasons = [renderThrownChain({ cause: err })];
      try {
        await client.close();
      } catch (closeError) {
        reasons.push(`closing it also failed: ${renderThrownChain({ cause: closeError })}`);
      }
      const reason = reasons.join('; ');
      const stderrText = stderr.trim();
      diagnostics.push({
        server: serverName,
        status: 'failed',
        toolCount: 0,
        reason,
        stderr: stderrText || undefined,
      });
      onLog?.(`mcp: ${serverName} failed: ${stderrText ? `${reason}; stderr: ${stderrText}` : reason}`);
    }
  }

  return {
    tools,
    diagnostics,
    async close() {
      // Every client is closed before anything is thrown — one server that will
      // not shut down must not leave the other children running — but a close
      // that failed is a surviving child process, not a completed teardown.
      const failures: unknown[] = [];
      for (const c of clients) {
        try {
          await c.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `${failures.length} of ${clients.length} MCP server(s) failed to disconnect`,
        );
      }
    },
  };
}

type McpToolResult = Awaited<ReturnType<Client['callTool']>>;

/** Flatten an MCP CallTool result's content blocks into a string the model reads. */
function formatMcpResult(res: McpToolResult): string {
  const content = Array.isArray(res?.content) ? res.content : [];
  const text = content.map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`)).join('\n');
  return (res?.isError ? 'MCP tool error: ' : '') + (text || '(no output)');
}

