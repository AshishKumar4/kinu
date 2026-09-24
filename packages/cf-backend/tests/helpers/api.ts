/**
 * One `/api` route family served the way `api/app.ts` serves it once the app's gates have passed: the
 * variables those gates set are preset, a throw is answered by the app's own error mapping, and a path
 * the family does not answer comes back as `null`, the fall-through to the next family. Runtime-neutral:
 * the workerd probes import it, so nothing here may reach a Bun-only helper.
 */
import { Hono } from 'hono';
import { apiError, apiPath, type FamilyEnv } from '../../src/api/context';
import type { WorkspaceAgent, WorkspaceVariables } from '../../src/api/workspace';
import type { AuthIdentity } from '../../src/auth/session';
import type { AccessIdentity } from '../../src/control-plane/access-gate';

export interface Gates {
  /** What the session gate proved. */
  readonly identity?: AuthIdentity;
  /** What Cloudflare Access proved, on `/api/control*`. */
  readonly access?: AccessIdentity;
  /**
   * What the workspace gate proved: the decoded name and the claimed object, whose unbuilt calls refuse.
   * Its request is the one sent, identity headers as the test wrote them.
   */
  readonly workspace?: { readonly name: string; readonly agent?: Partial<WorkspaceAgent> };
  /** The request's context; a family that retains work reaches it through `executionCtx`. */
  readonly ctx?: Pick<ExecutionContext, 'waitUntil'>;
}

function claimed(built: Partial<WorkspaceAgent> = {}): WorkspaceAgent {
  const refuse = (member: string) => (): never => {
    throw new Error(`OrchestratorAgent.${member}: not reachable in this test`);
  };

  return {
    getWorkspaceOverview: built.getWorkspaceOverview ?? refuse('getWorkspaceOverview'),
    evalAbortActivation: built.evalAbortActivation ?? refuse('evalAbortActivation'),
  };
}

export type Served<Bindings> = (request: Request, env: Bindings) => Promise<Response | null>;

export function serveFamily<Bindings extends object, Variables extends object>(
  family: Hono<FamilyEnv<Bindings, Variables>>,
  gates: Gates = {},
): Served<Bindings> {
  const fellThrough = new Response(null, { status: 404 });
  const app = new Hono<FamilyEnv<Bindings, WorkspaceVariables>>({ getPath: apiPath });

  app.use('*', async (c, next) => {
    if (gates.identity) c.set('identity', gates.identity);

    if (gates.access) c.set('access', gates.access);

    if (gates.workspace) c.set('workspace', { name: gates.workspace.name, agent: claimed(gates.workspace.agent), request: c.req.raw });
    await next();
  });

  app.route('/', family);
  app.notFound(() => fellThrough);
  app.onError(apiError);

  const { ctx } = gates;

  const executionCtx = ctx && {
    waitUntil: (promise: Promise<unknown>) => { ctx.waitUntil(promise); },
    passThroughOnException: () => {},
    props: {},
  };

  return async (request, env) => {
    const response = await app.fetch(request, env, executionCtx);

    return response === fellThrough ? null : response;
  };
}
