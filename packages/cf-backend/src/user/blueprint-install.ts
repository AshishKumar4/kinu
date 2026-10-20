/**
 * Installing a workspace blueprint: a new workspace of the owner's, born with the blueprint's soul, layout, main agent
 * and schedules before its first turn. The Personal assistant is the owner's one: installing it again opens the one
 * they have, and it may become their Home (`ASSISTANT_CONFIG_KEY`).
 */
import { Cause, Effect } from 'effect';
import * as v from 'valibot';
import { attempt, authoredRefusal, diagnostics, KinuError, settle } from '@kinu.run/core/obs';
import {
  blueprintSeed, err, json, kinuBlueprint, PERSONAL_ASSISTANT_ID, safeJson,
  type UserCaller, type WorkspaceEntry,
} from '@kinu.run/core';
import type { UserDO } from './user-do';
import { createCloudWorkspaceForUser, isCreateConflict, type CloudWorkspaceRegistry, type CreateCloudWorkspaceEnv } from './workspace-create';

/** user_config: the workspace the owner's Home opens on, while it is theirs. */
const ASSISTANT_CONFIG_KEY = 'assistant';

const InstallBodySchema = v.strictObject({
  /** The workspace's title; absent, the blueprint's. */
  displayName: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(60))),
  /** The main agent's name; absent, the blueprint's. */
  agent: v.optional(v.pipe(v.string(), v.maxLength(60))),
  /** The daily brief's time, `HH:MM`, in the owner's day. */
  brief: v.optional(v.pipe(v.string(), v.regex(/^([01]\d|2[0-3]):[0-5]\d$/))),
  utcOffsetMinutes: v.pipe(v.number(), v.integer(), v.minValue(-14 * 60), v.maxValue(14 * 60)),
  /** The assistant only: Home opens on its chat. */
  home: v.optional(v.boolean()),
});

export type InstallBody = v.InferOutput<typeof InstallBodySchema>;

/** The account reads and writes an install makes. */
export type InstallAuthority = CloudWorkspaceRegistry & Pick<UserDO, 'getConfig' | 'setConfig' | 'listActiveWorkspaces' | 'getProfile'>;

/** The owner's assistant workspace while it is still theirs; a removed one is no Home. */
export async function installedAssistant(userDO: Pick<InstallAuthority, 'getConfig' | 'listActiveWorkspaces'>, caller: UserCaller): Promise<string | null> {
  const [named, active] = await Promise.all([userDO.getConfig(caller, ASSISTANT_CONFIG_KEY), userDO.listActiveWorkspaces(caller)]);

  return named !== null && active.some((entry) => entry.name === named) ? named : null;
}

export interface InstallRequest<Id> {
  readonly env: CreateCloudWorkspaceEnv<Id>;
  readonly userId: string;
  readonly userDO: InstallAuthority;
  readonly owner: UserCaller;
  readonly id: string;
  readonly body: InstallBody;
  /** Counts the install on its Explore listing. */
  readonly counted: (blueprint: string) => Promise<void>;
}

/** The new workspace, or the assistant the owner already has. */
function installBlueprint<Id>(request: InstallRequest<Id>): Effect.Effect<WorkspaceEntry | { readonly name: string }, KinuError> {
  return Effect.gen(function* () {
    const { env, userId, userDO, owner, id, body } = request;
    const blueprint = kinuBlueprint(id);

    if (blueprint === undefined) return yield* Effect.fail(new KinuError('missing', `No workspace blueprint "${id}".`));
    const assistant = id === PERSONAL_ASSISTANT_ID;

    if (assistant) {
      const held = yield* Effect.promise(async () => installedAssistant(userDO, owner));

      if (held !== null) return { name: held };
    }

    const profile = yield* Effect.promise(async () => userDO.getProfile(owner));
    // The owner as the soul names them: their name, else their address's first part.
    const ownerName = [profile?.displayName?.trim(), profile?.email.split('@')[0]].find((name) => name !== undefined && name !== '') ?? 'you';

    const { soul, seed } = blueprintSeed(blueprint, {
      utcOffsetMinutes: body.utcOffsetMinutes, owner: ownerName,
      ...(body.agent !== undefined && { agent: body.agent }), ...(body.brief !== undefined && { brief: body.brief }),
    });

    const entry = yield* Effect.promise(async () => createCloudWorkspaceForUser({
      env, userId, userDO, caller: owner, input: { displayName: body.displayName ?? blueprint.title, purpose: blueprint.line }, soul, seed,
    }));

    if (assistant && body.home !== false) yield* Effect.promise(async () => userDO.setConfig(owner, ASSISTANT_CONFIG_KEY, entry.name));

    // The workspace is the person's either way: a count Explore missed is said, not their install undone.
    yield* attempt({ doing: `counting an install of ${id} on Explore`, otherwise: 'unavailable' }, async () => request.counted(id)).pipe(
      Effect.catch((failure) => Effect.sync(() => { diagnostics.failure('explore.install_uncounted', failure, { blueprint: id }); })),
    );

    return entry;
  });
}

/** POST /api/user/blueprints/:id/install → 201 the workspace | 404 no such blueprint | 409 a name taken. */
export function handleInstallRequest<Id>(call: Omit<InstallRequest<Id>, 'body'> & { readonly request: Request }): Promise<Response> {
  return settle(Effect.gen(function* () {
    const body = yield* Effect.promise(async () => safeJson(call.request, InstallBodySchema));

    if (body === null) return err(400, 'Body must be { displayName?, agent?, brief?, utcOffsetMinutes, home? }.');

    return yield* Effect.catchCause(
      Effect.map(installBlueprint({ ...call, body }), (workspace) => json({ body: { workspace: workspace.name } }, { status: 201 })),
      (failed) => Effect.gen(function* () {
        const cause = Cause.squash(failed);
        const error = authoredRefusal({ doing: 'installing this workspace', cause });

        if (isCreateConflict({ cause })) return err(409, error.message);

        if (error.code === 'missing') return err(404, error.message);

        return yield* Effect.die(error);
      }),
    );
  }));
}
