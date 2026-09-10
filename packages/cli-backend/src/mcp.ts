// Local MCP — connect the CLI agent to configured stdio MCP servers and
// discover their tools as descriptors the session admits. The cf backend
// reaches MCP via the per-user UserDO; locally we are the MCP CLIENT directly
// over child processes. Discovery and dispatch live here; the admission policy
// lives in core (`admitMcpDescriptors`) and the session applies it, because
// only the session knows the resolved model figures the budget divides.

import { describeMcpTool, decodeJsonValue, JsonObjectSchema, McpToolError, NO_TIMER_DEADLINE_MS, type JsonObject, type SerializableToolDescriptor } from '@kinu.run/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as v from 'valibot';
import { renderThrownChain } from '@kinu.run/core/obs';

/**
 * No wall clock on a startup and none on a tool call.
 *
 * A startup spawns a third-party stdio child and lists its tools. It ends when
 * that child answers, when the child exits or errors (the SDK rejects every
 * pending request on transport close), or when the operator stops `kinu`. A
 * 5_000 ms bound here would be a number nobody measured, and it costs a slow
 * `npx` server its whole tool set for the session.
 *
 * A tool CALL is the server doing real work — a fetch, a query, a build. It
 * ends the same three ways, plus the turn's own AbortSignal, which `call`
 * takes and hands the SDK.
 *
 * {@link NO_TIMER_DEADLINE_MS} is how "no deadline" is spelled to a mechanism
 * that insists on a timer: the MCP SDK reads an absent `timeout` as its own
 * 60_000 ms default, so omitting the field restores the bound instead of
 * removing it.
 */

/** One stdio MCP server (the standard mcpServers config shape). */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Per-call deadline in ms, CALLER-REQUESTED ONLY. Absent means the call runs
   *  until the server answers, the child dies, or the turn is cancelled. */
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
  /** Dispatch a tool call. It ends on the server's answer, on a transport
   *  failure, on `signal`, or on this server's own `timeoutMs` when its config
   *  named one. Native protocol and transport failures reject. */
  call(serverName: string, toolName: string, args: JsonObject, signal?: AbortSignal): Promise<string>;
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
 *
 * `signal` is the OWNER's shutdown, and it is the thing that ends a startup
 * that would otherwise not end. A stdio child that exits or errors rejects the
 * pending request through the SDK's transport close; a child that stays alive
 * and answers nothing does not, and the SDK offers no way to run a request
 * without a timer (`Protocol._setupTimeout` is private and always arms one), so
 * cancellation is the honest ending rather than a shorter clock. On abort the
 * transport is closed in the catch below, which kills that child instead of
 * leaking it.
 */
export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
  onLog?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<McpConnection> {
  const clients = new Map<string, Client>();
  const callTimeoutByServer = new Map<string, number>();
  const descriptors: SerializableToolDescriptor[] = [];
  const diagnostics: McpConnectionDiagnostic[] = [];

  for (const [serverName, cfg] of Object.entries(servers)) {
    const client = new Client({ name: 'kinu-cli', version: '0.1.0' });
    let stderr = '';

    try {
      signal?.throwIfAborted();

      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: cfg.env,
        stderr: 'pipe',
      });

      transport.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-4_000);
      });
      await client.connect(transport, { timeout: NO_TIMER_DEADLINE_MS, signal });
      const { tools: mcpTools } = await client.listTools(undefined, { timeout: NO_TIMER_DEADLINE_MS, signal });

      if (cfg.timeoutMs !== undefined) callTimeoutByServer.set(serverName, cfg.timeoutMs);

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
    async call(serverName, toolName, args, callSignal) {
      const client = clients.get(serverName);

      if (!client) throw new Error(`Unknown MCP server: ${serverName}`);
      const timeout = callTimeoutByServer.get(serverName) ?? NO_TIMER_DEADLINE_MS;

      const res = await client.callTool(
        { name: toolName, arguments: v.parse(JsonObjectSchema, args ?? {}) },
        undefined,
        { timeout, signal: callSignal },
      );

      if (res.isError === true) throw new McpToolError(decodeJsonValue({ value: res }));

      return formatMcpResult(res);
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

  return text || '(no output)';
}

