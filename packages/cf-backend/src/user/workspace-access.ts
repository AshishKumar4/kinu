// Worker-side helpers for operating on a user's workspaces: creating one, and
// telling a user's live workspaces that their credentials changed. Shared by the
// web routes (user/routes.ts) and the CLI control plane (cli/routes.ts), so
// status mapping cannot drift between them.
//
// Ownership-claiming lives in `./workspace-ownership`, which four surfaces ask
// and only this one creates — see that module's header.
import type { UserDO } from './user-do';
import { createCloudWorkspaceForUser, type CreateCloudWorkspaceInput } from './workspace-create';
import { err, json, safeJson } from '../lib/http';
import { ownerCaller } from './workspace-capability';
import { diagnostics, toKinuError, renderThrownChain } from '@kinu.run/core/obs';
import * as v from 'valibot';

/** POST /workspaces body → created WorkspaceEntry (201) | mapped error response. */
export async function handleCreateWorkspaceRequest(
  request: Request,
  env: Env,
  userId: string,
  userDO: DurableObjectStub<UserDO>,
  ctx?: ExecutionContext,
): Promise<Response> {
  const body = await safeJson(request, v.object({
    name: v.optional(v.string()),
    displayName: v.optional(v.string()),
    purpose: v.optional(v.string()),
    role: v.optional(v.string()),
  }));
  if (!body) return err(400, 'Body must be JSON');
  if (!body.name?.trim() && !body.purpose?.trim()) return err(400, 'purpose required');
  // The wire shape and the create input are two types. Passing the parsed body
  // straight through made them one object by structure, so a field either side
  // gained crossed silently in whichever direction: the `role` a `kinu create
  // --role` asks for is read by `createCloudWorkspaceForUser`, and it arrives
  // only because this mapping names it.
  const input: CreateCloudWorkspaceInput = {
    name: body.name,
    displayName: body.displayName,
    purpose: body.purpose,
    role: body.role,
  };
  try {
    const createOptions = ctx === undefined
      ? {}
      : { waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise) };
    const entry = await createCloudWorkspaceForUser(
      env, userId, userDO, await ownerCaller(env), input, createOptions,
    );
    return json(entry, { status: 201 });
  } catch (e) {
    const message = renderThrownChain({ cause: e });
    // workspace-create.ts throws plain Errors; this is the single home for the
    // two answers that are conflicts rather than bad requests — a provider the
    // account cannot serve, and a name an unfinished transfer is still holding.
    const conflict = message.startsWith('Cloudflare Workers AI is not connected')
      || message.startsWith('Workspace name conflict');
    return err(conflict ? 409 : 400, message);
  }
}

/** Fan a credential-change notification out to the user's active workspaces so
 *  each drops its cached provider/model state (onCredentialsChanged) —
 *  otherwise a disconnected provider stays "available" until the next
 *  claimOwner/setModel. The request's waitUntil owns the fanout. */
export function notifyWorkspacesCredentialsChanged(
  env: Env,
  userDO: DurableObjectStub<UserDO>,
  ctx?: ExecutionContext,
): void {
  if (ctx === undefined) {
    throw new Error('Credential fanout requires the request ExecutionContext owner');
  }
  ctx.waitUntil((async (): Promise<void> => {
    try {
      const workspaces = await userDO.listActiveWorkspaces(await ownerCaller(env));
      await Promise.allSettled(workspaces
        .map((a) => env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(a.name)).onCredentialsChanged()));
    } catch (cause) {
      diagnostics.failure('workspace.credential_fanout_failed', toKinuError({
        doing: 'notifying the user\'s workspaces of a credential change',
        cause,
        otherwise: 'unavailable',
      }));
    }
  })());
}
