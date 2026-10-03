// Worker-side helpers for creating a user's workspace and notifying live workspaces of credential
// changes. Shared by user/routes.ts and cli/routes.ts so status mapping cannot drift.
import { Effect, Cause } from 'effect';
import type { ActorAgent } from '../actor-agent';
import type { UserDO } from './user-do';
import type { ObjectNamespace } from '@kinu.run/core';
import type { OwnerCapabilityEnv } from '@kinu.run/core';
import {
  createCloudWorkspaceForUser,
  type CloudWorkspaceBirth, type CloudWorkspaceRegistry, type CreateCloudWorkspaceEnv,
  CreateCloudWorkspaceInputSchema,
} from './workspace-create';
import { err, json, safeJson } from '@kinu.run/core';
import { ownerCaller } from '@kinu.run/core';
import { authoredRefusal, diagnostics, toKinuError, settle } from '@kinu.run/core/obs';
import type { AccountLedgerTarget } from './account-usage';

export interface CreateWorkspaceEnv<Id> extends CreateCloudWorkspaceEnv<Id>, ModelSettingsFanoutEnv<Id> {
  OrchestratorAgent: ObjectNamespace<Id, CloudWorkspaceBirth & ModelSettingsFanoutTarget & AccountLedgerTarget>;
}

export interface CreateWorkspaceRequest<Id> {
  request: Request;
  env: CreateWorkspaceEnv<Id>;
  userId: string;
  userDO: CloudWorkspaceRegistry;
}

/** POST /workspaces body → created WorkspaceEntry (201) | mapped error response. */
export function handleCreateWorkspaceRequest<Id>(call: CreateWorkspaceRequest<Id>): Promise<Response> {
  return settle(Effect.gen(function* () {
    const { request, env, userId, userDO } = call;

    const input = yield* Effect.promise(async () => safeJson(request, CreateCloudWorkspaceInputSchema));

    if (!input) return err(400, 'Body must be JSON');

    if (!input.name?.trim() && !input.purpose?.trim()) return err(400, 'purpose required');

    return yield* Effect.catchCause(Effect.gen(function* () {
      const entry = yield* Effect.promise(async () => createCloudWorkspaceForUser({
        env, userId, userDO, caller: await ownerCaller(env), input,
      }));

      return json({ body: entry }, { status: 201 });
    }), (failed) => Effect.gen(function* () {
      const cause = Cause.squash(failed);
      const error = authoredRefusal({ doing: 'creating this workspace', cause });

      // Two of workspace-create.ts's refusals are conflicts (409): an unserved provider, and a name held by an unfinished transfer.
      const conflict = error.message.startsWith('Cloudflare Workers AI is not connected')
        || error.message.startsWith('Workspace name conflict');

      if (conflict) return err(409, error.message);

      return yield* Effect.die(error);
    }));
  }));
}

export type ModelSettingsFanoutTarget = Pick<ActorAgent, 'onModelSettingsChanged'>;

export interface ModelSettingsFanoutEnv<Id> extends OwnerCapabilityEnv {
  OrchestratorAgent: ObjectNamespace<Id, ModelSettingsFanoutTarget>;
}

/** Tell active workspaces their owner's credentials or model profile moved: each drops cached provider state
 *  and releases the effects a refusal parked. The request's waitUntil owns it. A missed notify heals for the
 *  caches (workspaces check the credential revision) and for parked effects at the workspace's next settled turn. */
export function notifyWorkspacesModelSettingsChanged<Id>(
  env: ModelSettingsFanoutEnv<Id>,
  userDO: Pick<UserDO, 'listActiveWorkspaces'>,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
): void {
  ctx.waitUntil(settle(Effect.gen(function* () {
    const workspaces = yield* Effect.catchCause(
      Effect.promise(async (): Promise<Array<{ name: string }> | null> => userDO.listActiveWorkspaces(await ownerCaller(env))),
      (failed) => Effect.sync(() => {
        diagnostics.failure('workspace.model_settings_fanout_failed', toKinuError({
          doing: 'notifying the user\'s workspaces of a model settings change',
          cause: Cause.squash(failed),
          otherwise: 'unavailable',
        }));

        return null;
      }),
    );

    // Unreadable roster: skip; the write landed and each workspace reconciles on next use.
    if (workspaces === null) return;

    const settled = yield* Effect.promise(() => Promise.allSettled(workspaces
      .map((a) => env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(a.name)).onModelSettingsChanged())));

    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === 'fulfilled') continue;
      diagnostics.failure('workspace.model_settings_notify_failed', toKinuError({
        doing: 'telling a workspace its owner\'s model settings changed',
        cause: outcome.reason,
        otherwise: 'unavailable',
      }), { workspace: workspaces[index].name });
    }
  })));
}
