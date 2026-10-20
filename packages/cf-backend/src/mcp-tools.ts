/**
 * The MCP server a workspace answers on: its tools and resources over the agent, built for one request. Its SDK and the
 * zod its schemas are written in load with this module, at a worker's first MCP request (`mcp-server.ts`), so neither is
 * linked into every isolate's startup (L27).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { RUN_EVENT_LIMIT_MAX, type EnqueueTurnResult, type PeerSendOutcome } from "@kinu.run/core";
import type { McpResolver, PeerMessageInput } from "./mcp-server";

export type McpAnswering = <A>(tool: string, work: () => Promise<A>, failed: (failure: string) => A) => Promise<A>;

function buildServer(resolveAgent: McpResolver, agentName: string, answer: McpAnswering): McpServer {
  const server = new McpServer({
    name: `kinu-${agentName}`,
    version: "1.0.0",
  });

  server.registerTool(
    "search_memory",
    {
      description:
        "Hybrid search over the agent's long-term memory: FTS5 (lexical) + Vectorize " +
        "(semantic) merged via Reciprocal Rank Fusion when Vectorize is configured; " +
        "FTS5-only otherwise. Returns matching passages with merged scores.",
      inputSchema: {
        query: z.string().describe("Search query (natural language or FTS5 syntax)."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)."),
      },
    },
    async ({ query, limit }) => answer("search_memory", async () => {
      const agent = await resolveAgent(agentName);
      const hits = await agent.searchMemoryHybrid(query, limit ?? 10);

      const text = hits.length === 0
        ? "(no matches)"
        : hits.map((h) =>
            `[${h.path}:${h.startLine}-${h.endLine}] ` +
            `(rrf ${h.rrfScore.toFixed(3)}, sources: ${h.sources.join('+')})\n${h.snippet}`,
          ).join("\n\n");

      return { content: [{ type: "text", text }] };
    }, (failure) => ({ content: [{ type: "text", text: `search_memory error: ${failure}` }] })),
  );

  server.registerTool(
    "save_note",
    {
      description: "Append a note to the agent's long-term memory (memory/MEMORY.md). FTS-indexed for later search.",
      inputSchema: { content: z.string().describe("Note text.") },
    },
    async ({ content }) => answer("save_note", async () => {
      const agent = await resolveAgent(agentName);
      await agent.saveNoteFromMcp(content);

      return { content: [{ type: "text", text: "Note saved." }] };
    }, (failure) => ({ content: [{ type: "text", text: `save_note error: ${failure}` }] })),
  );

  server.registerTool(
    "list_skills",
    {
      description: "List the agent's built-in and crafted tools (skills), each with a quality score.",
      inputSchema: {},
    },
    async () => answer("list_skills", async () => {
      const agent = await resolveAgent(agentName);
      const out = await agent.getToolList();
      const lines: string[] = [];
      lines.push(`## Built-in (${out.builtIn.length})`);

      for (const b of out.builtIn) lines.push(`- ${b}`);
      lines.push("");
      lines.push(`## Crafted (${out.crafted.length})`);

      for (const c of out.crafted) {
        lines.push(`- ${c.name} (q=${c.qualityScore.toFixed(2)}, uses=${c.usageCount}): ${c.description}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }, (failure) => ({ content: [{ type: "text", text: `list_skills error: ${failure}` }] })),
  );

  server.registerTool(
    "run_scaffold_once",
    {
      description: "Execute the agent's current scaffold (or its pending proposal) for a one-shot test task. Returns captured events.",
      inputSchema: {
        task: z.string(),
        useShadowOverride: z.boolean().optional().describe("If true, runs the pending proposed scaffold instead of the current one."),
      },
    },
    async ({ task, useShadowOverride }) => answer("run_scaffold_once", async () => {
      const agent = await resolveAgent(agentName);

      const result = await agent.runScaffoldOnce(task, useShadowOverride ? { useShadowOverride: true } : undefined);

      const summary = [
        `ok=${result.ok}, doneEmitted=${result.doneEmitted}, emits=${result.emitCount}, ms=${result.durationMs}`,
        result.error ? `error: ${result.error}` : '',
        `events:`,
        ...result.events.slice(0, 10).map((e) => `  - ${e.type}: ${JSON.stringify(e).slice(0, 120)}`),
        result.nativeEvents > 0 ? `  (+${String(result.nativeEvents)} native model chunks not carried)` : '',
      ].filter(Boolean).join("\n");

      return { content: [{ type: "text", text: summary }] };
    }, (failure) => ({ content: [{ type: "text", text: `run_scaffold_once error: ${failure}` }] })),
  );

  server.registerTool(
    "get_evolution_status",
    {
      description: "Return what evolution has in flight: the scaffold proposal awaiting the owner, and the edits staged for the next fresh turn.",
      inputSchema: {},
    },
    async () => answer("get_evolution_status", async () => {
      const agent = await resolveAgent(agentName);
      const status = await agent.getEvolutionStatus();

      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    }, (failure) => ({ content: [{ type: "text", text: `get_evolution_status error: ${failure}` }] })),
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
    async ({ limit, after }) => answer("list_runs", async () => {
      const agent = await resolveAgent(agentName);
      const page = await agent.listRuns({ limit: limit ?? 20, cursor: after ? { after } : undefined });
      const lines = page.items.map((r) => `- ${r.runId}: ${r.eventCount} events @ ${r.lastTs}`);

      if (lines.length === 0) return { content: [{ type: "text", text: "(no runs yet)" }] };
      lines.push(page.status === 'more'
        ? `(more runs before these: call again with after: ${JSON.stringify(page.next.after)})`
        : "(that is every run)");

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }, (failure) => ({ content: [{ type: "text", text: `list_runs error: ${failure}` }] })),
  );

  server.registerTool(
    "list_run_events",
    {
      description: "Paginated read of a run's event log. Same shape as the SSE stream.",
      inputSchema: {
        runId: z.string(),
        since: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(RUN_EVENT_LIMIT_MAX).optional(),
      },
    },
    async ({ runId, since, limit }) => answer("list_run_events", async () => {
      const agent = await resolveAgent(agentName);

      const events = await agent.getRunEvents(runId, { since, limit: limit ?? 100 });

      const text = events.length === 0
        ? "(no events)"
        : events.map((e) => `[${e.eventIndex}] ${e.type}: ${JSON.stringify(e).slice(0, 200)}`).join("\n");

      return { content: [{ type: "text", text }] };
    }, (failure) => ({ content: [{ type: "text", text: `list_run_events error: ${failure}` }] })),
  );

  // Ownership is enforced at the transport gate (claimOwnedWorkspace); peer/turn seams re-check it inside the DO.

  server.registerTool(
    "run_task",
    {
      description:
        "Enqueue a task for the agent: inject a user turn into its serialized loop; the exact " +
        "path the event->turn reactor and background-job wake use. Fire-and-forget; the turn runs " +
        "asynchronously. Returns whether it was queued or skipped (a newer turn pre-empted it, " +
        "or the turn queue rejected it: either way nothing ran).",
      inputSchema: { text: z.string().min(1).describe("The task / instruction for the agent to act on.") },
    },
    async ({ text }) => answer("run_task", async () => {
      const agent = await resolveAgent(agentName);
      const result: EnqueueTurnResult = await agent.runTaskFromMcp(text);

      const msg = result.status === "queued"
        ? "Task queued: the agent will run it on its turn loop."
        : "Task skipped: a newer turn pre-empted it, or the turn queue rejected it. Nothing ran.";

      return { content: [{ type: "text", text: msg }] };
    }, (failure) => ({ content: [{ type: "text", text: `run_task error: ${failure}` }] })),
  );

  server.registerTool(
    "send_peer",
    {
      description:
        "Send a fire-and-forget message to one of the owner's other agents over the peer transport. " +
        "The target must be a peer on the owner's roster (see list_peers): cross-owner messaging is refused.",
      inputSchema: {
        agent: z.string().describe("Peer agent name (from list_peers)."),
        message: z.string().describe("Message body."),
        topic: z.string().optional().describe("Short topic label (default \"message\")."),
      },
    },
    async ({ agent: peer, message, topic }) => answer("send_peer", async () => {
      const agent = await resolveAgent(agentName);
      const peerMessage: PeerMessageInput = { agent: peer, message };

      if (topic) peerMessage.topic = topic;
      const outcome: PeerSendOutcome = await agent.sendPeerFromMcp(peerMessage);

      const text = outcome.status === "rejected"
        ? `send_peer rejected: ${outcome.reason}`
        : `Message ${outcome.status} to ${peer} (id ${outcome.message_id}).`;

      return { content: [{ type: "text", text }] };
    }, (failure) => ({ content: [{ type: "text", text: `send_peer error: ${failure}` }] })),
  );

  server.registerTool(
    "list_peers",
    {
      description: "List the owner's other agents (this agent excluded): the valid targets for send_peer.",
      inputSchema: {},
    },
    async () => answer("list_peers", async () => {
      const agent = await resolveAgent(agentName);
      const peers = await agent.listPeersFromMcp();

      const text = peers.length === 0
        ? "(no other agents on this owner's roster)"
        : peers.map((p) => `- ${p.name}${p.displayName ? ` (${p.displayName})` : ""}`).join("\n");

      return { content: [{ type: "text", text }] };
    }, (failure) => ({ content: [{ type: "text", text: `list_peers error: ${failure}` }] })),
  );

  server.registerResource(
    "memory",
    `kinu://workspace/${agentName}/memory`,
    {
      title: "Agent memory (MEMORY.md)",
      description: "Full content of the agent's long-term memory file.",
      mimeType: "text/markdown",
    },
    async (uri) => answer("memory", async () => {
      const agent = await resolveAgent(agentName);
      const content = await agent.getMemoryContent();

      return { contents: [{ uri: uri.href, text: content, mimeType: "text/markdown" }] };
    }, (failure) => ({ contents: [{ uri: uri.href, text: `(error: ${failure})`, mimeType: "text/plain" }] })),
  );

  return server;
}

/** One MCP request answered by the server built for `agentName`. */
export async function answerMcp(request: Request, resolveAgent: McpResolver, agentName: string, answer: McpAnswering): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport();
  const server = buildServer(resolveAgent, agentName, answer);

  await server.connect(transport);

  return await transport.handleRequest(request);
}
