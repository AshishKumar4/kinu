/**
 * `/api/user/*` account-authority routes. They are mounted ahead of `userRoutes` because their UserDO
 * methods are floored at the `owner_only` `account` capability; no workspace token reaches them.
 */
import { Effect, Cause } from 'effect';
import { settle } from '@kinu.run/core/obs';
import { Hono, type Context } from 'hono';
import * as v from 'valibot';
import type { UserDO } from './user-do';
import { forgetSharesGiven, type ShareRosterAuthority, type SharesGivenEnv } from './shares-given';
import type { ObjectNamespace } from '@kinu.run/core';
import {
  confirmsAccountDelete,
  displayNameProblem,
  EXPERIENCE_KINDS,
  err, json, safeJson,
  type OwnerCapabilityEnv, type UserCaller,
} from '@kinu.run/core';
import { ownerGate, type ApiVariables, type FamilyEnv } from '../api/context';

const ProfilePatch = v.object({ displayName: v.string() });

const DeleteConfirm = v.object({ confirm: v.string() });

const ExperienceQuery = v.object({
  kind: v.picklist(EXPERIENCE_KINDS),
  limit: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
});

type AccountAuthority = Pick<
  UserDO, 'completeOnboarding' | 'searchExperience' | 'deleteAccount' | 'setDisplayName' | 'heldRows'
>;

export interface AccountRoutesEnv<Id> extends SharesGivenEnv<Id>, OwnerCapabilityEnv {
  UserDO: ObjectNamespace<Id, ShareRosterAuthority & AccountAuthority>;
}

interface AccountVariables extends ApiVariables {
  owner: UserCaller;
}

type AccountEnv = FamilyEnv<AccountRoutesEnv<unknown>, AccountVariables>;

function account(c: Context<AccountEnv>): ShareRosterAuthority & AccountAuthority {
  return c.env.UserDO.get(c.env.UserDO.idFromName(c.get('identity').userId));
}

export const accountRoutes = new Hono<AccountEnv>();

accountRoutes.post('/api/user/onboarding/complete', ownerGate(), async (c) =>
  json({ body: await account(c).completeOnboarding(c.get('owner')) }));

accountRoutes.get('/api/user/experience', ownerGate(), async (c) => {
  const url = new URL(c.req.url);
  const limitRaw = url.searchParams.get('limit');

  const query = v.safeParse(ExperienceQuery, {
    kind: url.searchParams.get('kind'),
    limit: limitRaw === null ? 50 : Number(limitRaw),
  });

  if (!query.success) return err(400, `kind must be one of ${EXPERIENCE_KINDS.join(', ')} and limit an integer from 1 to 100.`);

  return json({ body: await account(c).searchExperience(c.get('owner'), query.output) });
});

accountRoutes.get('/api/user/held-rows', ownerGate(), async (c) => {
  if (c.get('identity').provider !== 'dev') return Response.json({ error: 'Not found' }, { status: 404 });

  return json({ body: await account(c).heldRows(c.get('owner')) });
});

// The typed confirmation is the account email, not a password: the session authenticates,
// the phrase separates a stray click from a decision. No rate limit; the phrase is the gate.
accountRoutes.delete('/api/user/account', ownerGate(), (c) => {
  return settle(Effect.gen(function* () {
    const identity = c.get('identity');
    const owner = c.get('owner');
    const body = yield* Effect.promise(async () => safeJson(c.req.raw, DeleteConfirm));

    if (!body || !confirmsAccountDelete(body.confirm, identity.email)) {
      return err(400, 'Type the account email to confirm.');
    }

    // The account's record of share recipients goes with it; each is told to forget its cards first.
    yield* Effect.promise(async () => forgetSharesGiven(c.env, identity.userId, owner));

    yield* Effect.catchCause(Effect.gen(function* () {
      yield* Effect.promise(async () => account(c).deleteAccount(owner, identity.userId));
    }), (failed) => Effect.gen(function* () {
      const cause = Cause.squash(failed);
      // The SDK's destroy aborts its own isolate after the durable wipe; the 'destroyed' sentinel
      // means success (same rule as `tearDownWorkspace`).

      if (!(cause instanceof Error) || cause.message !== 'destroyed') return yield* Effect.failCause(failed);
    }));

    return json({ body: { deleted: true } });
  }));
});

accountRoutes.patch('/api/user/profile', ownerGate(), async (c) => {
  const body = await safeJson(c.req.raw, ProfilePatch);

  if (!body) return err(400, 'Body must be { displayName }');

  const problem = displayNameProblem(body.displayName);

  if (problem !== null) return err(400, problem);

  return json({ body: await account(c).setDisplayName(c.get('owner'), body.displayName) });
});
