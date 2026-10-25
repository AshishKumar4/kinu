/** Ownership of `:name` is proven before any workspace route runs, and only then indexed. */
import type { MiddlewareHandler } from 'hono';
import { Result } from 'effect';
import { err, extractOrchestratorAgentName, isWorkspaceName } from '@kinu.run/core';
import { claimOwnedWorkspace } from '../user/workspace-ownership';
import { observeWorkspaceUse } from '../control-plane/index-feed';
import { appendIdentityHeaders } from '../cli/rpc-gate';
import { rawParam, type ApiVariables, type FamilyEnv } from './context';
import type { AuthIdentity } from '../auth/session';

/** The workspace object a claim hands back: the `OrchestratorAgent` namespace's stub. Each call it takes is async, so the
 *  SDK starts the object before the first one runs (agents 0.26, `tests/workerd/start-before-rpc.test.ts`). */
export type ClaimedWorkspace = Env['OrchestratorAgent'] extends DurableObjectNamespace<infer Agent> ? DurableObjectStub<Agent> : never;

interface OwnedWorkspace<Agent> {
  readonly name: string;
  /** The claimed stub, as a family reads it: the members it calls. */
  readonly agent: Agent;
  /** Identity headers rewritten from the verified identity. */
  readonly request: Request;
}

/** Old matchers compared the path with the decoded name: only an escape-free spelling matches. */
export const LITERAL_WORKSPACE = '/api/workspaces/:name{[^/%]+}';

/** The workspace a request's path names, a well-formed name only: its API, its agent socket or its page. The session
 *  check reads its admission in the same call, so the ownership gate asks the registry nothing more. */
export function addressedWorkspace(request: Request): string | undefined {
  const { pathname } = new URL(request.url);
  const name = extractOrchestratorAgentName(pathname) ?? /^\/(?:api\/workspaces|workspace)\/([^/%]+)/u.exec(pathname)?.[1];

  return name !== undefined && isWorkspaceName(name) ? name : undefined;
}

/** What the gate proved, for a family that calls `Agent`'s members of the claimed workspace; every family reads the one
 *  stub the gate claimed, never one of its own. */
export interface WorkspaceVariables<Agent = ClaimedWorkspace> extends ApiVariables {
  workspace: OwnedWorkspace<Agent>;
}

export type WorkspaceEnv = FamilyEnv<Env, WorkspaceVariables>;

/**
 * The one ownership gate a workspace's routes pass, the API's and the agent socket's: the caller's claim on `name`,
 * then its use noted, and `request` rewritten to carry who asks. A refusal is the claim's own answer.
 */
export async function ownedWorkspace(
  c: { readonly env: Env; readonly executionCtx: Pick<ExecutionContext, 'waitUntil'> },
  identity: AuthIdentity,
  name: string,
  request: Request,
): Promise<Result.Result<{ readonly agent: ClaimedWorkspace; readonly request: Request }, Response>> {
  const claim = await claimOwnedWorkspace(c.env, identity.userId, name, identity.workspace);

  if (Result.isFailure(claim)) return Result.fail(err(claim.failure.status, claim.failure.error));
  observeWorkspaceUse(c.env, identity, name, { retain: c.executionCtx });

  return Result.succeed({ agent: claim.success, request: new Request(request, { headers: appendIdentityHeaders(request.headers, identity) }) });
}

export const workspaceGate: MiddlewareHandler<WorkspaceEnv> = async (c, next) => {
  const name = decodeURIComponent(rawParam(c, 'name'));
  const owned = await ownedWorkspace(c, c.get('identity'), name, c.req.raw);

  if (Result.isFailure(owned)) return owned.failure;
  c.set('workspace', { name, ...owned.success });
  await next();
};
