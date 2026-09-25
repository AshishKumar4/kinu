// Worker-side helpers for creating a user's workspace and notifying live workspaces of credential
// changes. Shared by user/routes.ts and cli/routes.ts so status mapping cannot drift.
import type { ActorAgent } from '../actor-agent';
import type { UserDO } from './user-do';
import type { ObjectNamespace } from '@kinu.run/core';
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
import type { AccountLedgerTarget } from './account-usage';

export interface CreateWorkspaceEnv<Id> extends CreateCloudWorkspaceEnv<Id>, CredentialFanoutEnv<Id> {
  OrchestratorAgent: ObjectNamespace<Id, CloudWorkspaceBirth & CredentialFanoutTarget & AccountLedgerTarget>;
}

export interface CreateWorkspaceRequest<Id> {
  request: Request;
  env: CreateWorkspaceEnv<Id>;
  userId: string;
  userDO: CloudWorkspaceRegistry;
}

/** POST /workspaces body → created WorkspaceEntry (201) | mapped error response. */
export async function handleCreateWorkspaceRequest<Id>(call: CreateWorkspaceRequest<Id>): Promise<Response> {
  const { request, env, userId, userDO } = call;

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

  // Wire shape and create input are distinct types; a field reaches `createCloudWorkspaceForUser`
  // only if this mapping names it.
  const input: CreateCloudWorkspaceInput = {
    name: body.name,
    displayName: body.displayName,
    purpose: body.purpose,
    model: body.model,
    reasoningEffort: body.reasoningEffort,
    role: body.role,
  };

  try {
    const entry = await createCloudWorkspaceForUser({
      env, userId, userDO, caller: await ownerCaller(env), input,
    });

    return json({ body: entry }, { status: 201 });
  } catch (e) {
    const message = renderThrownChain({ cause: e });

    // workspace-create.ts throws plain Errors; these two messages are conflicts (409), not bad
    // requests: an unserved provider, and a name held by an unfinished transfer.
    const conflict = message.startsWith('Cloudflare Workers AI is not connected')
      || message.startsWith('Workspace name conflict');

    return err(conflict ? 409 : 400, message);
  }
}

export type CredentialFanoutTarget = Pick<ActorAgent, 'onCredentialsChanged'>;

export interface CredentialFanoutEnv<Id> extends OwnerCapabilityEnv {
  OrchestratorAgent: ObjectNamespace<Id, CredentialFanoutTarget>;
}

/** Tell active workspaces to drop cached provider/model state; the request's waitUntil owns it.
 *  Timeliness only: workspaces also check the credential revision, so a missed notify heals. */
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

    // Unreadable roster: skip; the credential write landed and each workspace reconciles on next use.
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
