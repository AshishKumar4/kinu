// Local MCP — connect the CLI agent to configured stdio MCP servers and
// discover their tools as descriptors the session admits. The cf backend
// reaches MCP via the per-user UserDO; locally we are the MCP CLIENT directly
// over child processes. Discovery and dispatch live here; the admission policy
// lives in core (`admitMcpDescriptors`) and the session applies it, because
// only the session knows the resolved model figures the budget divides.

import { describeMcpTool, JsonObjectSchema, type JsonObject, type SerializableToolDescriptor } from '@kinu.run/core';
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
  /** Every discovered tool as a descriptor, in discovery order — UNADMITTED.
   *  The session admits these through core's `admitMcpDescriptors` and builds
   *  the ToolSet from what survives, so a third party's catalog is bounded by
   *  the same policy on both backends. The descriptor's `serverId` is the
   *  config key: server names are unique per agent by construction on the CLI
   *  (the config is a `mcpServers` object), so it routes `call` directly. */
  readonly descriptors: SerializableToolDescriptor[];
  /** Dispatch one call on the server the tool was discovered from, with that
   *  server's call budget. A failure is rendered, not thrown: a broken tool
   *  reports its breakage to the model instead of failing the turn. */
  call(serverName: string, toolName: string, args: JsonObject): Promise<string>;
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
 * Connect to each configured stdio MCP server, list its tools, and describe
 * them for the session's admission. A server that fails to start is logged
 * and skipped — the rest still load. Empty config ⇒ a no-op connection.
 */
export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
  onLog?: (msg: string) => void,
): Promise<McpConnection> {
  const clients = new Map<string, Client>();
  const callTimeoutByServer = new Map<string, number>();
  const descriptors: SerializableToolDescriptor[] = [];
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
      callTimeoutByServer.set(serverName, cfg.timeoutMs ?? MCP_CALL_TIMEOUT_MS);
      for (const t of mcpTools) {
        // One bad tool must not take down its server's good ones: describe the
        // rest and state the loss on the background channel, the way a server
        // that fails to start is skipped while the rest still load.
        try {
          descriptors.push(describeMcpTool(
            { id: serverName, name: serverName },
            {
              name: t.name,
              description: t.description,
              annotations: t.annotations,
              inputSchema: t.inputSchema ?? { type: 'object' },
            },
          ));
        } catch (err) {
          onLog?.(`mcp: ${serverName} tool '${t.name}' skipped: ${renderThrownChain({ cause: err })}`);
        }
      }
      clients.set(serverName, client);
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
    descriptors,
    diagnostics,
    async call(serverName, toolName, args) {
      const client = clients.get(serverName);
      if (!client) throw new Error(`Unknown MCP server: ${serverName}`);
      const timeout = callTimeoutByServer.get(serverName) ?? MCP_CALL_TIMEOUT_MS;
      try {
        const res = await client.callTool(
          { name: toolName, arguments: v.parse(JsonObjectSchema, args ?? {}) },
          undefined,
          { timeout },
        );
        return formatMcpResult(res);
      } catch (err) {
        return `mcp error: ${renderThrownChain({ cause: err })}`;
      }
    },
    async close() {
      // Every client is closed before anything is thrown — one server that will
      // not shut down must not leave the other children running — but a close
      // that failed is a surviving child process, not a completed teardown.
      const failures: unknown[] = [];
      for (const c of clients.values()) {
        try {
          await c.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `${failures.length} of ${clients.size} MCP server(s) failed to disconnect`,
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

