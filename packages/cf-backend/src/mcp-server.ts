/**
 * Kinu MCP server: GET/POST/DELETE /mcp/v1/<agentName>, streamable HTTP, one stateless
 * McpServer per request proxying to the workspace DO's @callable RPCs.
 * Auth runs here because server.ts routes /mcp/v1/* past the browser-session gate:
 * `Bearer ptc_…` CLI token, else browser session / DEV_USER_EMAIL, then the same
 * ownership claim as the per-agent API.
 */

import { Cause, Effect, Result } from 'effect';
import { getAgentByName } from "agents";
import { Hono } from "hono";
import type {
  EnqueueTurnResult,
  HybridHit,
  Page,
  PageRequest,
  PeerSendOutcome,
  RunEvent,
  RunEventQuery,
  RunListEntry,
  ScaffoldRunReport,
  EvolutionStatus,
  ToolListEntry,
} from "@kinu.run/core";
import type { OrchestratorAgent } from "./orchestrator";
import { AuthError, authenticateRequest, crossSiteRejection } from "./auth/session";
import { authenticateCliToken, readBearer, type CliAuthAuthority } from "./cli/auth-store";
import { claimOwnedWorkspace, type WorkspaceOwnerClaim, type WorkspaceRegistry } from "./user/workspace-ownership";
import type { SessionAuthority } from "./auth/store";
import type { ObjectNamespace } from '@kinu.run/core';
import type { KvStore } from '@kinu.run/agent-utils';
import { authoredRefusal, diagnostics, renderThrownChain, settle, toKinuError, type KinuError } from '@kinu.run/core/obs';
import { beneath, routeError, type FamilyEnv } from './api/context';
import type { McpAnswering } from './mcp-tools';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, mcp-session-id, mcp-protocol-version, authorization",
  "Access-Control-Expose-Headers": "mcp-session-id",
  "Access-Control-Max-Age": "86400",
};

export interface PeerMessageInput { agent: string; message: string; topic?: string }

/**
 * A resolver, not the namespace binding: the SDK's `getAgentByName` (agents@0.26.0,
 * `dist/agent-routing.js:176-183`, read 2026-10-06) awaits `__unsafe_ensureInitialized`
 * so `onStart` runs before the first RPC.
 */
export type McpResolver = (name: string) => Promise<McpAgentClient>;

export const mcpAgentResolver = (env: Env): McpResolver =>
  (name) => getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, name);

/** Explicit boundary so the Agents SDK does not recursively serialize the whole agent class per method access. */
export interface McpAgentClient {
  searchMemoryHybrid(query: string, limit: number): Promise<HybridHit[]>;
  saveNoteFromMcp(content: string): Promise<{ ok: true }>;
  getToolList(): Promise<{ builtIn: string[]; crafted: ToolListEntry[] }>;
  runScaffoldOnce(task: string, opts?: { useShadowOverride?: boolean }): Promise<ScaffoldRunReport>;
  getEvolutionStatus(): Promise<EvolutionStatus>;
  listRuns(request: PageRequest): Promise<Page<RunListEntry>>;
  getRunEvents(runId: string, opts?: RunEventQuery): Promise<RunEvent[]>;
  runTaskFromMcp(text: string): Promise<EnqueueTurnResult>;
  sendPeerFromMcp(input: PeerMessageInput): Promise<PeerSendOutcome>;
  listPeersFromMcp(): Promise<Array<{ name: string; displayName?: string }>>;
  getMemoryContent(): Promise<string>;
}

function withCors(response: Response): Response {
  for (const [k, v] of Object.entries(corsHeaders)) response.headers.set(k, v);

  return response;
}

/** A tool's failure as the owner's MCP client reads it: logged and answered with its chain. */
function mcpToolFailure(failure: { tool: string; cause: unknown }): string {
  const { tool, cause } = failure;
  const error = authoredRefusal({ doing: `running the MCP tool ${tool}`, cause });
  diagnostics.failure('mcp.tool_failed', error, { tool });

  return renderThrownChain({ cause: error });
}

export type McpAuthority = CliAuthAuthority & SessionAuthority & WorkspaceRegistry;

export interface McpEnv<Id> extends
  Pick<Env, 'CREDENTIAL_ENCRYPTION_KEY' | 'DEV_USER_EMAIL' | 'DEV_IDENTITY_SECRET'> {
  /** Cookie path only; checked so "no session" is a 401 rather than a 500. */
  AUTH_KV: KvStore;
  UserDO: ObjectNamespace<Id, McpAuthority>;
  /** The ownership gate's own binding: the claim runs before any resolver does. */
  OrchestratorAgent: ObjectNamespace<Id, WorkspaceOwnerClaim>;
}

/** CLI bearer token first, then browser session / DEV_USER_EMAIL. */
function authenticateMcpCaller<Id>(
  request: Request,
  env: McpEnv<Id>,
): Effect.Effect<{ userId: string } | Response> {
  if (readBearer(request)) {
    return Effect.map(Effect.promise(() => authenticateCliToken(request, env)), (result) => {
      if (Result.isFailure(result)) return withCors(Response.json({ error: result.failure }, { status: 401 }));

      if (result.success.kind !== 'session') {
        // Scoped CI access tokens are CLI-API-only; MCP accepts interactive session tokens only.
        return withCors(Response.json({ error: 'MCP requires an interactive CLI session token. Sign in with: kinu auth' }, { status: 403 }));
      }

      return { userId: result.success.userId };
    });
  }

  // A session cookie travels with any same-site request, a preview's included: the Worker's cross-site rule holds here too.
  const crossSite = crossSiteRejection(request);

  if (crossSite !== null) return Effect.succeed(withCors(crossSite));

  return Effect.catchCause(Effect.map(Effect.promise(() => authenticateRequest(request, env)), (identity) => ({ userId: identity.userId })), (failed) => {
    const e = Cause.squash(failed);

    return e instanceof AuthError ? Effect.succeed(withCors(Response.json({ error: e.message }, { status: e.status }))) : Effect.failCause(failed);
  });
}

const MCP_PREFIX = '/mcp/v1';

export function mcpRoutes<Bindings extends McpEnv<unknown>>(
  resolveAgent: (env: Bindings) => McpResolver,
): Hono<FamilyEnv<Bindings, object>> {
  const routes = new Hono<FamilyEnv<Bindings, object>>();

  routes.options('/mcp/v1/*', beneath<FamilyEnv<Bindings, object>>(MCP_PREFIX, async () => new Response(null, { headers: corsHeaders })));

  routes.all('/mcp/v1/*', beneath<FamilyEnv<Bindings, object>>(MCP_PREFIX, (c) => settle(serveMcp(c.req.raw, c.env, resolveAgent(c.env), (tool, work, failed) => settle(
    Effect.catchCause(Effect.promise(work), (cause) => Effect.sync(() => failed(mcpToolFailure({ tool, cause: Cause.squash(cause) })))),
  )))));

  routes.onError((cause, c) => withCors(routeError(cause, c)));

  return routes;
}

function serveMcp<Id>(request: Request, env: McpEnv<Id>, resolveAgent: McpResolver, answer: McpAnswering): Effect.Effect<Response, KinuError> {
  return Effect.gen(function* () {
    const segments = new URL(request.url).pathname.slice(`${MCP_PREFIX}/`.length).split("/").filter(Boolean);
    const agentName = segments[0] ? decodeURIComponent(segments[0]) : '';

    if (!agentName) {
      return withCors(Response.json(
        { error: "missing agent name in MCP path; use /mcp/v1/<agentName>" },
        { status: 400 },
      ));
    }

    const caller = yield* authenticateMcpCaller(request, env);

    if (caller instanceof Response) return caller;
    const owned = yield* Effect.promise(() => claimOwnedWorkspace(env, caller.userId, agentName));

    if (Result.isFailure(owned)) {
      return withCors(Response.json({ error: owned.failure.error }, { status: owned.failure.status }));
    }

    return yield* Effect.tryPromise({
      try: async () => {
        // The server SDK loads at the first MCP request: the startup closure 6,981 to 6,533 KiB (12d8c7440).
        const { answerMcp } = await import("./mcp-tools");

        return withCors(await answerMcp(request, resolveAgent, agentName, answer));
      },
      catch: (cause) => toKinuError({ doing: 'serving an MCP request', cause, otherwise: 'io' }),
    });
  });
}

