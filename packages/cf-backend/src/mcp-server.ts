/**
 * Proteus MCP server surface.
 *
 *   GET /mcp/v1/<agentName> / POST / DELETE → MCP streamable-HTTP transport
 *
 * Auth (handled here, before the transport — server.ts routes /mcp/v1/*
 * straight to this handler, bypassing the browser-session gate external
 * clients can never pass):
 *   • `Authorization: Bearer ptc_…` — the caller's CLI token (the per-user
 *     credential external MCP clients obtain via `proteus auth`).
 *   • Otherwise the browser session / DEV_USER_EMAIL identity.
 * Every request then runs the same ownership claim as the rest of the
 * per-agent API (registry membership + claimOwner).
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
 * v1 read tools:
 *   • search_memory      — FTS over agent memory
 *   • save_note          — append to agent memory
 *   • list_skills        — list crafted tools + their quality scores
 *   • run_scaffold_once  — fire the current scaffold for a test task
 *   • get_shadow_status  — pending scaffold rollout + decision
 *   • list_run_events    — paginated query of the event log
 *   • list_runs          — recent runs
 *
 * v1 write/act tools — thin wrappers over existing @callable orchestrator RPCs
 * (no new execution path; the same seams the built-in tools and reactor use):
 *   • run_task           — enqueue a turn into the agent's serialized loop
 *   • send_peer          — message one of the owner's other agents (agents `send`)
 *   • list_peers         — the owner's other agents (send_peer roster helper)
 *   • release     — list / create / advance a release request
 *
 * v1 resources:
 *   • proteus://workspace/<name>/memory       — full memory content
 *   • proteus://workspace/<name>/scaffold     — current scaffold code
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { getAgentByName } from "agents";
import type {
  EnqueueTurnResult,
  HybridHit,
  Page,
  PageRequest,
  PeerSendOutcome,
  ReleaseBoard,
  ReleaseChange,
  ReleaseStatus,
  RunEventQuery,
  RunListEntry,
  ShadowStatus,
  ToolListEntry,
} from "@proteus/core";
import { RELEASE_STATUSES, isEngineOwnedTransitionTarget } from "@proteus/core";
import type { OrchestratorAgent } from "./orchestrator";
import { AuthError, authenticateRequest } from "./auth/session";
import { authenticateCliToken, readBearer } from "./cli/auth-store";
import { claimOwnedWorkspace } from "./user/workspace-access";
import { decodeRunEventWire, decodeScaffoldRunWire } from './lib/orchestrator-wire';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, mcp-session-id, mcp-protocol-version, authorization",
  "Access-Control-Expose-Headers": "mcp-session-id",
  "Access-Control-Max-Age": "86400",
};
interface PeerMessageInput { agent: string; message: string; topic?: string }

/** The callable surface this HTTP adapter uses. Keeping the boundary explicit
 * avoids asking the Agents SDK to recursively serialize the entire agent class
 * (including recursive run-event JSON) at each method access. */
interface McpAgentClient {
  searchMemoryHybrid(query: string, limit: number): Promise<HybridHit[]>;
  saveNoteFromMcp(content: string): Promise<{ ok: true }>;
  getToolList(): Promise<{ builtIn: string[]; crafted: ToolListEntry[] }>;
  runScaffoldOnceWire(
    task: string,
    opts?: { useShadowOverride?: boolean; timeoutMs?: number },
  ): Promise<string>;
  getShadowStatus(): Promise<ShadowStatus>;
  listRuns(request: PageRequest): Promise<Page<RunListEntry>>;
  getRunEventsWire(runId: string, opts?: RunEventQuery): Promise<string>;
  runTaskFromMcp(text: string): Promise<EnqueueTurnResult>;
  sendPeerFromMcp(input: PeerMessageInput): Promise<PeerSendOutcome>;
  listPeersFromMcp(): Promise<Array<{ name: string; displayName?: string }>>;
  getReleaseBoard(limit: number): Promise<ReleaseBoard>;
  createReleaseChange(input: {
    bindingId: string;
    userPrompt: string;
    plan?: string | null;
  }): Promise<ReleaseChange>;
  transitionReleaseChange(changeId: string, status: ReleaseStatus): Promise<ReleaseChange>;
  getMemoryContent(): Promise<string>;
}

function withCors(response: Response): Response {
  for (const [k, v] of Object.entries(corsHeaders)) response.headers.set(k, v);
  return response;
}

async function resolveAgent(env: Env, agentName: string): Promise<McpAgentClient> {
  const stub = await getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, agentName);
  return {
    searchMemoryHybrid: (query, limit) => stub.searchMemoryHybrid(query, limit),
    saveNoteFromMcp: (content) => stub.saveNoteFromMcp(content),
    getToolList: () => stub.getToolList(),
    runScaffoldOnceWire: (task, opts) => stub.runScaffoldOnceWire(task, opts),
    getShadowStatus: () => stub.getShadowStatus(),
    listRuns: (request) => stub.listRuns(request),
    getRunEventsWire: (runId, opts) => stub.getRunEventsWire(runId, opts),
    runTaskFromMcp: (text) => stub.runTaskFromMcp(text),
    sendPeerFromMcp: (input) => stub.sendPeerFromMcp(input),
    listPeersFromMcp: () => stub.listPeersFromMcp(),
    getReleaseBoard: (limit) => stub.getReleaseBoard(limit),
    createReleaseChange: (input) => stub.createReleaseChange(input),
    transitionReleaseChange: (changeId, status) => stub.transitionReleaseChange(changeId, status),
    getMemoryContent: () => stub.getMemoryContent(),
  };
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
        return { content: [{ type: "text", text: `search_memory error: ${errorMessage(err)}` }] };
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
        await agent.saveNoteFromMcp(content);
        return { content: [{ type: "text", text: "Note saved." }] };
      } catch (err) {
        return { content: [{ type: "text", text: `save_note error: ${errorMessage(err)}` }] };
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
        return { content: [{ type: "text", text: `list_skills error: ${errorMessage(err)}` }] };
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
        // The agents-SDK stub doesn't resolve the @callable's return type, so
        // annotate from the source-of-truth ScaffoldRunResult shape.
        const result = decodeScaffoldRunWire(
          await agent.runScaffoldOnceWire(
            task,
            useShadowOverride ? { useShadowOverride: true } : undefined,
          ),
        );
        const summary = [
          `ok=${result.ok}, doneEmitted=${result.doneEmitted}, emits=${result.emitCount}, ms=${result.durationMs}`,
          result.error ? `error: ${result.error}` : '',
          `events:`,
          ...result.events.slice(0, 10).map((e) => `  - ${e.type}: ${JSON.stringify(e).slice(0, 120)}`),
        ].filter(Boolean).join("\n");
        return { content: [{ type: "text", text: summary }] };
      } catch (err) {
        return { content: [{ type: "text", text: `run_scaffold_once error: ${errorMessage(err)}` }] };
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
        return { content: [{ type: "text", text: `get_shadow_status error: ${errorMessage(err)}` }] };
      }
    },
  );

  server.registerTool(
    "list_runs",
    {
      description: "List the agent's recent runs (turns) with their event counts. "
        + "Pass `after` from a previous call's last line to continue past the page.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
        after: z.string().optional(),
      },
    },
    async ({ limit, after }) => {
      try {
        const agent = await resolveAgent(env, agentName);
        const page = await agent.listRuns({ limit: limit ?? 20, cursor: after ? { after } : undefined });
        const lines = page.items.map((r) => `- ${r.runId} — ${r.eventCount} events @ ${r.lastTs}`);
        if (lines.length === 0) return { content: [{ type: "text", text: "(no runs yet)" }] };
        // A model reading a truncated list as the whole history is the same
        // defect as a surface doing it, so the boundary is stated in words.
        lines.push(page.status === 'more'
          ? `(more runs before these — call again with after: ${JSON.stringify(page.next.after)})`
          : "(that is every run)");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `list_runs error: ${errorMessage(err)}` }] };
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
        const events = decodeRunEventWire(
          await agent.getRunEventsWire(runId, { since, limit: limit ?? 100 }),
        );
        const text = events.length === 0
          ? "(no events)"
          : events.map((e) => `[${e.eventIndex}] ${e.type}: ${JSON.stringify(e).slice(0, 200)}`).join("\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: `list_run_events error: ${errorMessage(err)}` }] };
      }
    },
  );

  // ── Write / act tools ────────────────────────────────────────────
  // Each proxies an existing @callable on the orchestrator. Ownership is
  // already enforced at the transport gate (claimOwnedWorkspace); the peer/turn
  // seams re-check the owner + same-owner roster inside the DO, so a caller
  // can never reach an agent or peer they do not own.

  server.registerTool(
    "run_task",
    {
      description:
        "Enqueue a task for the agent: inject a user turn into its serialized loop — the exact " +
        "path the event→turn reactor and background-job wake use. Fire-and-forget; the turn runs " +
        "asynchronously. Returns whether it was queued or skipped (a newer turn pre-empted it, " +
        "or the turn queue rejected it — either way nothing ran).",
      inputSchema: { text: z.string().min(1).describe("The task / instruction for the agent to act on.") },
    },
    async ({ text }) => {
      try {
        const agent = await resolveAgent(env, agentName);
        const result: EnqueueTurnResult = await agent.runTaskFromMcp(text);
        const msg = result.status === "queued"
          ? "Task queued — the agent will run it on its turn loop."
          : "Task skipped — a newer turn pre-empted it, or the turn queue rejected it. Nothing ran.";
        return { content: [{ type: "text", text: msg }] };
      } catch (err) {
        return { content: [{ type: "text", text: `run_task error: ${errorMessage(err)}` }] };
      }
    },
  );

  server.registerTool(
    "send_peer",
    {
      description:
        "Send a fire-and-forget message to one of the owner's other agents over the peer transport. " +
        "The target must be a peer on the owner's roster (see list_peers) — cross-owner messaging is refused.",
      inputSchema: {
        agent: z.string().describe("Peer agent name (from list_peers)."),
        message: z.string().describe("Message body."),
        topic: z.string().optional().describe("Short topic label (default \"message\")."),
      },
    },
    async ({ agent: peer, message, topic }) => {
      try {
        const agent = await resolveAgent(env, agentName);
        const peerMessage: PeerMessageInput = { agent: peer, message };
        if (topic) peerMessage.topic = topic;
        const outcome: PeerSendOutcome = await agent.sendPeerFromMcp(peerMessage);
        const text = outcome.status === "rejected"
          ? `send_peer rejected: ${outcome.reason}`
          : `Message ${outcome.status} to ${peer} (id ${outcome.message_id}).`;
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: `send_peer error: ${errorMessage(err)}` }] };
      }
    },
  );

  server.registerTool(
    "list_peers",
    {
      description: "List the owner's other agents (this agent excluded) — the valid targets for send_peer.",
      inputSchema: {},
    },
    async () => {
      try {
        const agent = await resolveAgent(env, agentName);
        const peers = await agent.listPeersFromMcp();
        const text = peers.length === 0
          ? "(no other agents on this owner's roster)"
          : peers.map((p) => `- ${p.name}${p.displayName ? ` (${p.displayName})` : ""}`).join("\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: `list_peers error: ${errorMessage(err)}` }] };
      }
    },
  );

  server.registerTool(
    "release",
    {
      description:
        "Drive the agent's release board. Actions: `list` (recent changes + bindings), " +
        "`create` (open a change against a bound release source — needs bindingId + prompt), " +
        "`advance` (transition a change to a new status — the lifecycle validates the move).",
      inputSchema: {
        action: z.enum(["list", "create", "advance"]),
        bindingId: z.string().optional().describe("create: the release source to change (see list)."),
        prompt: z.string().optional().describe("create: what to change, in the owner's words."),
        plan: z.string().optional().describe("create: an optional up-front plan."),
        changeId: z.string().optional().describe("advance: the change to transition."),
        status: z.enum(RELEASE_STATUSES).optional().describe("advance: the target status (e.g. planning, patching, awaiting_approval)."),
      },
    },
    async ({ action, bindingId, prompt, plan, changeId, status }) => {
      try {
        const agent = await resolveAgent(env, agentName);
        if (action === "list") {
          const board: ReleaseBoard = await agent.getReleaseBoard(20);
          return { content: [{ type: "text", text: JSON.stringify(board, null, 2) }] };
        }
        if (action === "create") {
          if (!bindingId || !prompt) {
            return { content: [{ type: "text", text: "release create requires bindingId and prompt." }] };
          }
          const change: ReleaseChange = await agent.createReleaseChange({ bindingId, userPrompt: prompt, plan: plan ?? null });
          return { content: [{ type: "text", text: `Created change ${change.id} (${change.status}) for binding ${change.bindingId}.` }] };
        }
        // advance
        if (!changeId || !status) {
          return { content: [{ type: "text", text: "release advance requires changeId and status." }] };
        }
        // Same governance gate as the builtin release tool: on this
        // backend the execution engine owns validating/preview_ready/applying/
        // deployed/rolled_back — those states are earned by real execution,
        // never asserted by an external MCP actor.
        if (isEngineOwnedTransitionTarget(status)) {
          return {
            content: [{
              type: "text",
              text:
                `release advance refused: status '${status}' is earned by execution, not asserted — ` +
                `use the agent's release tool actions apply / run_checks / deploy / rollback to get there for real.`,
            }],
          };
        }
        const advanced: ReleaseChange = await agent.transitionReleaseChange(changeId, status);
        return { content: [{ type: "text", text: `Change ${advanced.id} → ${advanced.status}.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `release error: ${errorMessage(err)}` }] };
      }
    },
  );

  // ── Resources ────────────────────────────────────────────────────

  server.registerResource(
    "memory",
    `proteus://workspace/${agentName}/memory`,
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
        return { contents: [{ uri: uri.href, text: `(error: ${errorMessage(err)})`, mimeType: "text/plain" }] };
      }
    },
  );

  return server;
}

/** Resolve the calling user: CLI bearer token first (the external-client
 *  path), then browser session / DEV_USER_EMAIL. */
async function authenticateMcpCaller(request: Request, env: Env): Promise<{ userId: string } | Response> {
  if (readBearer(request)) {
    const result = await authenticateCliToken(request, env);
    if (!result.ok) return withCors(Response.json({ error: result.error }, { status: 401 }));
    if (result.identity.kind !== 'session') {
      // Scoped CI access tokens are CLI-API-only; the MCP surface stays
      // bound to interactive session tokens.
      return withCors(Response.json({ error: 'MCP requires an interactive CLI session token. Sign in with: proteus auth' }, { status: 403 }));
    }
    return { userId: result.identity.userId };
  }
  try {
    return { userId: (await authenticateRequest(request, env)).userId };
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 500;
    const message = e instanceof Error ? e.message : String(e);
    return withCors(Response.json({ error: message }, { status }));
  }
}

export async function handleMcpRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/mcp/v1/")) return null;

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // /mcp/v1/<agentName>[/...] — agentName is the second segment after /mcp/v1/
  const segments = url.pathname.replace(/^\/mcp\/v1\//, "").split("/").filter(Boolean);
  const agentName = segments[0] ? decodeURIComponent(segments[0]) : '';
  if (!agentName) {
    return withCors(Response.json(
      { error: "missing agent name in MCP path; use /mcp/v1/<agentName>" },
      { status: 400 },
    ));
  }

  const caller = await authenticateMcpCaller(request, env);
  if (caller instanceof Response) return caller;
  const owned = await claimOwnedWorkspace(env, caller.userId, agentName);
  if (!owned.ok) {
    return withCors(Response.json({ error: owned.error }, { status: owned.status }));
  }

  try {
    const transport = new WebStandardStreamableHTTPServerTransport();
    const server = buildServer(env, agentName);
    await server.connect(transport);
    const resp = await transport.handleRequest(request);
    return withCors(resp);
  } catch (err) {
    return withCors(Response.json({ error: errorMessage(err) }, { status: 500 }));
  }
}

function errorMessage<Thrown>(thrown: Thrown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
