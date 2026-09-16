/**
 * `POST /api/workspaces/<name>/eval/abort` — end the workspace object's
 * activation, for the eval tier and nobody else.
 *
 * The deployed product has no way to end an activation, and the first-run
 * `background-wake` row needs one: the continuation of a multi-step turn
 * across activations is a property only an ended activation can show, and the
 * platform's own idle eviction is neither forcible nor repeatable. So this
 * route exists, under the one identity the eval tier acts as — the
 * eval-service account `DEV_USER_EMAIL` + `DEV_IDENTITY_SECRET` mint, which
 * `authenticateRequest` marks `provider: 'dev'`. Every other identity is
 * answered as if the route did not exist. ARCHITECTURE-DECISIONS C3.
 *
 * The object ends its activation with `ctx.abort`, which rejects the stub call
 * that asked for it: that rejection is the abort having happened, not a
 * failure of it, and it is recorded and answered as such.
 */
import { diagnostics, renderThrownChain } from '@kinu.run/core/obs';
import type { AuthIdentity } from '../auth/session';

const ROUTE = /^\/api\/workspaces\/([^/]+)\/eval\/abort\/?$/;

/** The identity the eval tier acts as. Never a person's session. */
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
    // The abort ended the activation this call was in flight on; the
    // rejection is its receipt.
    diagnostics.event('eval.activation_aborted', { workspace, receipt: renderThrownChain({ cause }) });

    return Response.json({ aborted: true }, { status: 202 });
  }

  diagnostics.event('eval.activation_abort_returned', { workspace });

  return Response.json({ aborted: true }, { status: 202 });
}
