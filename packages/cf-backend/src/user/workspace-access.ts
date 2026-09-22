// Worker-side helpers for operating on a user's workspaces: creating one, and
// telling a user's live workspaces that their credentials changed. Shared by the
// web routes (user/routes.ts) and the CLI control plane (cli/routes.ts), so
// status mapping cannot drift between them.
//
// Ownership-claiming lives in `./workspace-ownership`, which four surfaces ask
// and only this one creates — see that module's header.
import type { ActorAgent } from '../actor-agent';
import type { UserDO } from './user-do';
import type { ObjectNamespace } from '../bindings';
import type { OwnerCapabilityEnv } from '@kinu.run/core';
import {
  createCloudWorkspaceForUser,
  type CloudWorkspaceBirth, type CloudWorkspaceRegistry, type CreateCloudWorkspaceEnv,
  type CreateCloudWorkspaceInput,
} from './workspace-create';
import { err, json, safeJson } from '@kinu.run/core';
import { ownerCaller } from '@kinu.run/core';
import { diagnostics, toKinuError, renderThrownChain } from '@kinu.run/core/obs';
import * as v from 'valibot';

/** Every binding a create route reads: the create's own, and the fanout's
 *  workspace namespace, which the create already addresses. */
export interface CreateWorkspaceEnv<Id> extends CreateCloudWorkspaceEnv<Id>, CredentialFanoutEnv<Id> {
  OrchestratorAgent: ObjectNamespace<Id, CloudWorkspaceBirth & CredentialFanoutTarget>;
}

export interface CreateWorkspaceRequest<Id> {
  request: Request;
  env: CreateWorkspaceEnv<Id>;
  userId: string;
  userDO: CloudWorkspaceRegistry;
  ctx?: Pick<ExecutionContext, 'waitUntil'>;
}

/** POST /workspaces body → created WorkspaceEntry (201) | mapped error response. */
export async function handleCreateWorkspaceRequest<Id>(call: CreateWorkspaceRequest<Id>): Promise<Response> {
  const { request, env, userId, userDO, ctx } = call;

  const body = await safeJson(request, v.object({
    name: v.optional(v.string()),
    displayName: v.optional(v.string()),
    purpose: v.optional(v.string()),
    model: v.optional(v.string()),
    reasoningEffort: v.optional(v.picklist(['low', 'medium', 'high'])),
    role: v.optional(v.string()),
  }));

  if (!body) return err(400, 'Body must be JSON');

  if (!body.name?.trim() && !body.purpose?.trim()) return err(400, 'purpose required');

  // The wire shape and the create input are two types. Passing the parsed body
  // straight through made them one object by structure, so a field either side
  // gained crossed silently in whichever direction: the `role` a `kinu create
  // --role` asks for, the `model` and `reasoningEffort` the CLI sends from its
  // config defaults, are read by `createCloudWorkspaceForUser`, and each
  // arrives only because this mapping names it.
  const input: CreateCloudWorkspaceInput = {
    name: body.name,
    displayName: body.displayName,
    purpose: body.purpose,
    model: body.model,
    reasoningEffort: body.reasoningEffort,
    role: body.role,
  };

  try {
    const createOptions = ctx === undefined
      ? {}
      : { waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise) };

    const entry = await createCloudWorkspaceForUser({
      env, userId, userDO, caller: await ownerCaller(env), input, options: createOptions,
    });

    return json({ body: entry }, { status: 201 });
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

/** The one call the fanout makes on a workspace object. Named so the fanout
 *  states its reach and a stand-in workspace satisfies it. */
export type CredentialFanoutTarget = Pick<ActorAgent, 'onCredentialsChanged'>;

/** What the fanout reads: the roster's workspaces, and the owner secret the
 *  roster read is authorized with. */
export interface CredentialFanoutEnv<Id> extends OwnerCapabilityEnv {
  OrchestratorAgent: ObjectNamespace<Id, CredentialFanoutTarget>;
}

/** Fan a credential-change notification out to the user's active workspaces so
 *  each drops its cached provider/model state (onCredentialsChanged) —
 *  otherwise a disconnected provider stays "available" until the next
 *  claimOwner/setModel. The request's waitUntil owns the fanout.
 *
 *  The fanout is a TIMELINESS mechanism, not a correctness one: every
 *  mutation also bumps the account credential revision, and a workspace
 *  compares that number before using its cached state, so a notification that
 *  never landed is healed at the next use rather than left standing. Each
 *  rejected workspace is named and classified here, so a persistent failure is
 *  a diagnosable line rather than an allSettled outcome nobody reads. */
export function notifyWorkspacesCredentialsChanged<Id>(
  env: CredentialFanoutEnv<Id>,
  userDO: Pick<UserDO, 'listActiveWorkspaces'>,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): void {
  if (ctx === undefined) {
    throw new Error('Credential fanout requires the request ExecutionContext owner');
  }

  ctx.waitUntil((async (): Promise<void> => {
    let workspaces: Array<{ name: string }> | null;

    try {
      workspaces = await userDO.listActiveWorkspaces(await ownerCaller(env));
    } catch (cause) {
      diagnostics.failure('workspace.credential_fanout_failed', toKinuError({
        doing: 'notifying the user\'s workspaces of a credential change',
        cause,
        otherwise: 'unavailable',
      }));
      workspaces = null;
    }

    // A roster that could not be read is a fan-out that reaches nobody — the
    // credential write itself already landed, and the next workspace touch
    // reconciles its own copy.
    if (workspaces === null) return;

    const settled = await Promise.allSettled(workspaces
      .map((a) => env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(a.name)).onCredentialsChanged()));

    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === 'fulfilled') continue;
      diagnostics.failure('workspace.credential_notify_failed', toKinuError({
        doing: 'telling a workspace its owner\'s credentials changed',
        cause: outcome.reason,
        otherwise: 'unavailable',
      }), { workspace: workspaces[index].name });
    }
  })());
}
