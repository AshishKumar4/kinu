/**
 * Proteus MCP server surface.
 *
 *   GET /mcp/v1/<agentName> / POST / DELETE → MCP streamable-HTTP transport
 *
 * Stateless server per request (per the @modelcontextprotocol/sdk
 * "WebStandardStreamableHTTPServerTransport" pattern in
 * external/agents/examples/mcp-server). Each request:
 *   1. Builds a fresh McpServer instance
 *   2. Registers Proteus tools that proxy back to the OrchestratorAgent DO
 *      by `agentName` via getAgentByName (using @callable RPCs already
 *      defined on the orchestrator)
 *   3. Connects the transport, handles the request, returns the response
 *
 * This makes Proteus a real MCP server — external clients (Cursor, Claude
 * Code, browser AI, other agents) can connect, list tools, invoke them,
 * read memory, trigger splits, manage scaffold versions. The distribution
 * play: Proteus becomes a tool other agents can use, not just a chat app.
 *
 * v1 tools:
 *   • search_memory      — FTS over agent memory
 *   • save_note          — append to agent memory
 *   • list_skills        — list crafted tools + their quality scores
 *   • run_scaffold_once  — fire the current scaffold for a test task
 *   • get_shadow_status  — pending scaffold rollout + decision
 *   • list_run_events    — paginated query of the event log
 *   • list_runs          — recent runs
 *
 * v1 resources:
 *   • proteus://agent/<name>/memory       — full memory content
 *   • proteus://agent/<name>/scaffold     — current scaffold code
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { getAgentByName } from "agents";
import type { OrchestratorAgent } from "./orchestrator.js";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, mcp-session-id, mcp-protocol-version, authorization",
  "Access-Control-Expose-Headers": "mcp-session-id",
  "Access-Control-Max-Age": "86400",
};

/** Constant-time string comparison — guards against timing-side-channel
 *  enumeration of MCP_AUTH_TOKEN by attackers. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function withCors(response: Response): Response {
  for (const [k, v] of Object.entries(corsHeaders)) response.headers.set(k, v);
  return response;
}

async function resolveAgent(env: Env, agentName: string) {
  const ns = (env as Env & { OrchestratorAgent: DurableObjectNamespace }).OrchestratorAgent;
  return getAgentByName<Env, OrchestratorAgent>(ns, agentName);
}

function buildServer(env: Env, agentName: string): McpServer {
  const server = new McpServer({
    name: `proteus-${agentName}`,
    version: "1.0.0",
  });

  // ── Tools ────────────────────────────────────────────────────────

  server.registerTool(
    "search_memory",
    {
      description:
        "Hybrid search over the agent's long-term memory — FTS5 (lexical) + Vectorize " +
        "(semantic) merged via Reciprocal Rank Fusion when Vectorize is configured; " +
        "FTS5-only otherwise. Returns matching passages with merged scores.",
      inputSchema: {
        query: z.string().describe("Search query (natural language or FTS5 syntax)."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)."),
      },
    },
    async ({ query, limit }) => {
      try {
        const agent = await resolveAgent(env, agentName);
        const hits = await agent.searchMemoryHybrid(query, limit ?? 10);
        const text = hits.length === 0
          ? "(no matches)"
          : hits.map((h) =>
              `[${h.path}:${h.startLine}-${h.endLine}] ` +
              `(rrf ${h.rrfScore.toFixed(3)}, sources: ${h.sources.join('+')})\n${h.snippet}`,
            ).join("\n\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: `search_memory error: ${(err as Error).message}` }] };
      }
    },
  );

  server.registerTool(
    "save_note",
    {
      description: "Append a note to the agent's long-term memory (memory/MEMORY.md). FTS-indexed for later search.",
      inputSchema: { content: z.string().describe("Note text.") },
    },
    async ({ content }) => {
      try {
        const agent = await resolveAgent(env, agentName);
        // Use the existing search_memory tool route via @callable; the
        // orchestrator doesn't yet expose a direct save_note RPC, so we
        // route through doSearchMemory's underlying memory primitive by
        // calling the chat-side save_note tool's same SQL path manually.
        // Cleaner: add an @callable saveNote(). For now, defer to the
        // builtin tool by invoking it through a tiny callable below.
        await agent.saveNoteFromMcp(content);
        return { content: [{ type: "text", text: "Note saved." }] };
      } catch (err) {
        return { content: [{ type: "text", text: `save_note error: ${(err as Error).message}` }] };
      }
    },
  );

  server.registerTool(
    "list_skills",
    {
      description: "List the agent's built-in and crafted tools (skills), each with a quality score.",
      inputSchema: {},
    },
    async () => {
      try {
        const agent = await resolveAgent(env, agentName);
        const out = await agent.getToolList();
        const lines: string[] = [];
        lines.push(`## Built-in (${out.builtIn.length})`);
        for (const b of out.builtIn) lines.push(`- ${b}`);
        lines.push("");
        lines.push(`## Crafted (${out.crafted.length})`);
        for (const c of out.crafted) {
          lines.push(`- ${c.name} (q=${c.qualityScore.toFixed(2)}, uses=${c.usageCount}) — ${c.description}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `list_skills error: ${(err as Error).message}` }] };
      }
    },
  );

  server.registerTool(
    "run_scaffold_once",
    {
      description: "Execute the agent's current scaffold (or its pending shadow) for a one-shot test task. Returns captured events.",
      inputSchema: {
        task: z.string(),
        useShadowOverride: z.boolean().optional().describe("If true, runs the pending shadow scaffold instead of the current one."),
      },
    },
    async ({ task, useShadowOverride }) => {
      try {
        const agent = await resolveAgent(env, agentName);
        const result = await agent.runScaffoldOnce(task, useShadowOverride ? { useShadowOverride: true } : undefined);
        const summary = [
          `ok=${result.ok}, doneEmitted=${result.doneEmitted}, emits=${result.emitCount}, ms=${result.durationMs}`,
          result.error ? `error: ${result.error}` : '',
          `events:`,
          ...result.events.slice(0, 10).map((e) => `  - ${e.type}: ${JSON.stringify(e).slice(0, 120)}`),
        ].filter(Boolean).join("\n");
        return { content: [{ type: "text", text: summary }] };
      } catch (err) {
        return { content: [{ type: "text", text: `run_scaffold_once error: ${(err as Error).message}` }] };
      }
    },
  );

  server.registerTool(
    "get_shadow_status",
    {
      description: "Return the current scaffold shadow-rollout state: pending version, trial counts, recommendation.",
      inputSchema: {},
    },
    async () => {
      try {
        const agent = await resolveAgent(env, agentName);
        const status = await agent.getShadowStatus();
        return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `get_shadow_status error: ${(err as Error).message}` }] };
      }
    },
  );

  server.registerTool(
    "list_runs",
    {
      description: "List the agent's recent runs (turns) with their event counts.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
    },
    async ({ limit }) => {
      try {
        const agent = await resolveAgent(env, agentName);
        const runs = await agent.listRuns(limit ?? 20);
        const lines = runs.map((r) => `- ${r.runId} — ${r.eventCount} events @ ${r.lastTs}`);
        return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "(no runs yet)" }] };
      } catch (err) {
        return { content: [{ type: "text", text: `list_runs error: ${(err as Error).message}` }] };
      }
    },
  );

  server.registerTool(
    "list_run_events",
    {
      description: "Paginated read of a run's event log. Same shape as the SSE stream.",
      inputSchema: {
        runId: z.string(),
        since: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ runId, since, limit }) => {
      try {
        const agent = await resolveAgent(env, agentName);
        const events = await agent.getRunEvents(runId, { since, limit: limit ?? 100 });
        const text = events.length === 0
          ? "(no events)"
          : events.map((e) => `[${e.eventIndex}] ${e.type}: ${JSON.stringify(e).slice(0, 200)}`).join("\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: `list_run_events error: ${(err as Error).message}` }] };
      }
    },
  );

  // ── Resources ────────────────────────────────────────────────────

  server.registerResource(
    "memory",
    `proteus://agent/${agentName}/memory`,
    {
      title: "Agent memory (MEMORY.md)",
      description: "Full content of the agent's long-term memory file.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      try {
        const agent = await resolveAgent(env, agentName);
        const content = await agent.getMemoryContent();
        return { contents: [{ uri: uri.href, text: content, mimeType: "text/markdown" }] };
      } catch (err) {
        return { contents: [{ uri: uri.href, text: `(error: ${(err as Error).message})`, mimeType: "text/plain" }] };
      }
    },
  );

  return server;
}

export async function handleMcpRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/mcp/v1/")) return null;

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Optional shared-secret auth. If env.MCP_AUTH_TOKEN is set, require it.
  // When unset (dev mode / personal account), the endpoint is open — same
  // behaviour as before. Set the secret in prod:
  //   echo "<long-random>" | npx wrangler secret put MCP_AUTH_TOKEN
  const required = (env as { MCP_AUTH_TOKEN?: string }).MCP_AUTH_TOKEN;
  if (required) {
    const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    // Timing-safe compare so an attacker can't byte-iterate the secret.
    if (!timingSafeEqual(provided, required)) {
      return withCors(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    }
  }

  // /mcp/v1/<agentName>[/...] — agentName is the second segment after /mcp/v1/
  const segments = url.pathname.replace(/^\/mcp\/v1\//, "").split("/").filter(Boolean);
  const agentName = segments[0];
  if (!agentName) {
    return withCors(Response.json(
      { error: "missing agent name in MCP path; use /mcp/v1/<agentName>" },
      { status: 400 },
    ));
  }

  try {
    const transport = new WebStandardStreamableHTTPServerTransport();
    const server = buildServer(env, agentName);
    await server.connect(transport);
    const resp = await transport.handleRequest(request);
    return withCors(resp);
  } catch (err) {
    return withCors(Response.json({ error: (err as Error).message }, { status: 500 }));
  }
}
