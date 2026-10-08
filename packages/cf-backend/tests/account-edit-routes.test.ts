// Issue #34: a model request takes its route from the provider settings the account holds when it is made, never from
// a profile handed out once. The owner edits the account's catalog through Settings' own route between two rounds, and
// the flow reads what each request asked for: the root's own turn and a child hired before the edit.
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { activeOperationProfile, BUILTIN_PROFILE_CATALOG } from '@kinu.run/core';
import type { AuthIdentity } from '../src/auth/session';
import { userRoutes, type UserRoutesEnv } from '../src/user/routes';
import { serveFamily } from './helpers/api';
import { workspaceObject } from './helpers/bindings';
import { catalogTurn, hostedSubordinateHarness, orchestratorHarness, runDelegatedTask } from './helpers/actor-harness';
import { chatCompletion, GATEWAY_MODEL, stubAiBinding } from './helpers/platform-gateway';
import { createTestUserDO, provisionTestWorkspace, TEST_CREDENTIAL_ENCRYPTION_KEY, testOwner } from './helpers/user-do';

const EDITED = 'ai-gateway/workers-ai/@cf/harness/edited-model';

const OWNER = '0123456789abcdef0123456789abcdef';

const IDENTITY: AuthIdentity = { userId: OWNER, email: 'owner@example.com', sub: 'account-edit', provider: 'test' };

/** The model a request named upstream, read at the binding: the spec without the gateway's own prefix. */
const AskedSchema = v.looseObject({ model: v.string() });

test('after an account edit in Settings, the root\'s next request and an existing child\'s both ask for the new model', async () => {
  const seen: { actor: string | undefined; model: string }[] = [];

  const gateway = stubAiBinding((run) => {
    seen.push({ actor: activeOperationProfile()?.actor.actorId, model: v.parse(AskedSchema, run.query).model });

    return chatCompletion(run, 'done');
  });

  const user = createTestUserDO({ durableObjectId: OWNER });
  await user.userDO.ensureProfile(await testOwner(), IDENTITY.email);
  const token = await provisionTestWorkspace(user, 'account-edit', 'Account edit');
  const workspace = orchestratorHarness(undefined, { userDO: user.userDO, workspace: 'account-edit', ownerUserId: OWNER, aiGateway: gateway });
  workspace.agent.harnessHoldsCapability(token);
  // Both models are ones the provider lists; which one each tier names is the account's.
  workspace.agent.harnessInstallCatalog({ availableModels: [GATEWAY_MODEL, EDITED] });

  const env: UserRoutesEnv<string> = {
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    UserDO: { idFromName: (name) => name, get: () => user.userDO },
    // Settings tells every active workspace of the change, as the route does after it answers.
    OrchestratorAgent: {
      idFromName: (name) => name,
      get: () => workspaceObject({ onModelSettingsChanged: async () => await workspace.agent.onModelSettingsChanged() }),
    },
  };

  // Every tier on one model, saved as Settings saves it.
  const save = async (model: string, expectedVersion: number) => {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } };

    const answered = await serveFamily(userRoutes, { identity: IDENTITY, ctx })(new Request('https://kinu.example.com/api/user/profile-catalog', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catalog: { ...BUILTIN_PROFILE_CATALOG, tiers: { default: { model }, deep: { model }, fast: { model } } }, expectedVersion }),
    }), env);

    expect(answered?.status).toBe(200);
    await Promise.all(pending);
  };

  await save(GATEWAY_MODEL, 0);

  const child = await hostedSubordinateHarness(workspace, {
    name: 'edit-child', displayName: 'Edit Child', nameOrigin: 'user', mission: 'answer once',
  });

  const childId = child.actor.handle.actorId;

  const round = async (label: string) => {
    seen.length = 0;
    await catalogTurn(workspace.agent, `root ${label}`);
    await runDelegatedTask(workspace, childId, `child ${label}`);

    const of = (hired: boolean) => [...new Set(seen.filter((call) => (call.actor === childId) === hired).map((call) => call.model))];

    return { root: of(false), child: of(true) };
  };

  const before = await round('before');
  await save(EDITED, 1);
  const after = await round('after');
  const upstream = (spec: string) => spec.slice('ai-gateway/'.length);

  expect({ before, after }).toEqual({
    before: { root: [upstream(GATEWAY_MODEL)], child: [upstream(GATEWAY_MODEL)] },
    after: { root: [upstream(EDITED)], child: [upstream(EDITED)] },
  });
  await user.joinFibers();
});
