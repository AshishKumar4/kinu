/** Ownership of `:name` is proven before any workspace route runs, and only then indexed. */
import type { MiddlewareHandler } from 'hono';
import { err, type WorkspaceOverview } from '@kinu.run/core';
import { claimOwnedWorkspace } from '../user/workspace-ownership';
import { observeWorkspaceUse } from '../control-plane/index-feed';
import { appendIdentityHeaders } from '../cli/rpc-gate';
import { rawParam, type ApiVariables, type FamilyEnv } from './context';

export interface WorkspaceAgent {
  getWorkspaceOverview(): Promise<WorkspaceOverview>;
  evalAbortActivation(): Promise<void>;
}

export interface OwnedWorkspace {
  readonly name: string;
  readonly agent: WorkspaceAgent;
  /** Identity headers rewritten from the verified identity. */
  readonly request: Request;
}

/** Old matchers compared the path with the decoded name: only an escape-free spelling matches. */
export const LITERAL_WORKSPACE = '/api/workspaces/:name{[^/%]+}';

export interface WorkspaceVariables extends ApiVariables {
  workspace: OwnedWorkspace;
}

export type WorkspaceEnv = FamilyEnv<Env, WorkspaceVariables>;

export const workspaceGate: MiddlewareHandler<WorkspaceEnv> = async (c, next) => {
  const identity = c.get('identity');
  const name = decodeURIComponent(rawParam(c, 'name'));
  const claim = await claimOwnedWorkspace(c.env, identity.userId, name);

  if (!claim.ok) return err(claim.status, claim.error);

  observeWorkspaceUse(c.env, identity, name, { retain: c.executionCtx });

  c.set('workspace', {
    name,
    agent: claim.agent,
    request: new Request(c.req.raw, { headers: appendIdentityHeaders(c.req.raw.headers, identity) }),
  });
  await next();
};
