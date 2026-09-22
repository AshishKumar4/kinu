/**
 * `POST /api/workspaces/<name>/eval/abort`: end the workspace object's activation. Eval-service identity only;
 * every other identity is answered as if the route did not exist. ARCHITECTURE-DECISIONS C3.
 * `ctx.abort` rejects the stub call that asked for it: that rejection is the abort's receipt, not a failure.
 */
import { diagnostics, renderThrownChain } from '@kinu.run/core/obs';
import type { AuthIdentity } from '../auth/session';

const ROUTE = /^\/api\/workspaces\/([^/]+)\/eval\/abort\/?$/;

function isEvalServiceIdentity(identity: AuthIdentity): boolean {
  return identity.provider === 'dev';
}

export async function handleEvalAbortRequest(
  request: Request,
  identity: AuthIdentity,
  abort: () => Promise<void>,
): Promise<Response | null> {
  const match = ROUTE.exec(new URL(request.url).pathname);

  if (match === null || request.method !== 'POST') return null;

  if (!isEvalServiceIdentity(identity)) return Response.json({ error: 'Not found' }, { status: 404 });
  const workspace = match[1] ?? '';

  try {
    await abort();
  } catch (cause) {
    diagnostics.event('eval.activation_aborted', { workspace, receipt: renderThrownChain({ cause }) });

    return Response.json({ aborted: true }, { status: 202 });
  }

  diagnostics.event('eval.activation_abort_returned', { workspace });

  return Response.json({ aborted: true }, { status: 202 });
}
