// Local MCP client over stdio child processes. Admission policy lives in core
// (`admitMcpDescriptors`); the session applies it.

import { describeMcpTool, decodeJsonValue, JsonObjectSchema, McpToolError, NO_TIMER_DEADLINE_MS, type JsonObject, type SerializableToolDescriptor } from '@kinu.run/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as v from 'valibot';
import { renderThrownChain } from '@kinu.run/core/obs';

/**
 * No wall clock on startup or tool calls; they end on answer, child exit, owner
 * abort, or the turn's signal. {@link NO_TIMER_DEADLINE_MS} spells "no deadline"
 * because the MCP SDK reads an absent `timeout` as its own 60_000 ms default.
 */

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Per-call deadline in ms, caller-requested only. */
  timeoutMs?: number;
}

export interface McpConnection {
  /** Every discovered tool, unadmitted; the session admits them via core's
   *  `admitMcpDescriptors`. `serverId` is the config key, unique per agent. */
  readonly descriptors: SerializableToolDescriptor[];
  call(serverName: string, toolName: string, args: JsonObject, signal?: AbortSignal): Promise<string>;
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
 * Connect each configured server and describe its tools; a server that fails is
 * logged and skipped. `signal` is the only end for a child that stays alive and
 * answers nothing: the SDK always arms a timer, so cancellation replaces a clock.
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
        // One bad tool must not take down its server's good ones.
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
      // A failed close on the half-open transport means a leaked child; report it, never drop it.
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
      // Close every client before throwing; a failed close is a surviving child process.
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

function formatMcpResult(res: McpToolResult): string {
  const content = Array.isArray(res?.content) ? res.content : [];
  const text = content.map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`)).join('\n');

  return text || '(no output)';
}

