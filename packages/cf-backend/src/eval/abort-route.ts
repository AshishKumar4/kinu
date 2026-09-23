/**
 * `POST /api/workspaces/<name>/eval/abort`: end the workspace object's activation. Eval-service identity only;
 * every other identity is answered as if the route did not exist. ARCHITECTURE-DECISIONS C3.
 * `ctx.abort` rejects the stub call that asked for it: that rejection is the abort's receipt, not a failure.
 */
import { Hono } from 'hono';
import { diagnostics, renderThrownChain } from '@kinu.run/core/obs';
import type { AuthIdentity } from '../auth/session';
import { rawParam, type FamilyEnv } from '../api/context';
import type { WorkspaceVariables } from '../api/workspace';

const ABORT = '/api/workspaces/:name/eval/abort';

function isEvalServiceIdentity(identity: AuthIdentity): boolean {
  return identity.provider === 'dev';
}

export const evalAbortRoutes = new Hono<FamilyEnv<object, WorkspaceVariables>>();

evalAbortRoutes.on('POST', [ABORT, `${ABORT}/`], async (c) => {
  if (!isEvalServiceIdentity(c.get('identity'))) return Response.json({ error: 'Not found' }, { status: 404 });
  const workspace = rawParam(c, 'name');

  try {
    await c.get('workspace').agent.evalAbortActivation();
  } catch (cause) {
    diagnostics.event('eval.activation_aborted', { workspace, receipt: renderThrownChain({ cause }) });

    return Response.json({ aborted: true }, { status: 202 });
  }

  diagnostics.event('eval.activation_abort_returned', { workspace });

  return Response.json({ aborted: true }, { status: 202 });
});
