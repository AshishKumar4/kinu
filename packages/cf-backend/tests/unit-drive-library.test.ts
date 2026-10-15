// The Drive's library: a person's own slates, from the tiles their workspaces pushed, asking no workspace. What reaches
// a person from others' slates comes through those slates' rooms (`slates/room.ts`), not this route.
import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { afterEach, expect, test } from 'bun:test';
import * as v from 'valibot';
import { DriveLibrarySchema } from '@kinu.run/core';
import { resetRecordedMcp } from './helpers/agents-sdk';
import { orchestratorHarness, workspaceFiles, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';
import { createTestUserDO, provisionTestWorkspace, testOwner, TEST_USER_ENV, type TestUserDO } from './helpers/user-do';
import { serveFamily } from './helpers/api';
import type { AuthIdentity } from '../src/auth/session';
import { present } from '@kinu.run/test-utils';

const OWNER_ID = '0123456789abcdef0123456789abcdef';

const owner: AuthIdentity = { userId: OWNER_ID, email: 'owner@example.test', sub: `sub-${OWNER_ID}` };

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetRecordedMcp();
});

async function ownerWorld(): Promise<{ env: Env; user: TestUserDO; agent: ActorHarness<HarnessOrchestratorAgent>; acquired: string[]; tile: Promise<void> }> {
  const user = createTestUserDO({ durableObjectId: OWNER_ID });
  const token = await provisionTestWorkspace(user, 'issues-owner');
  const agent = orchestratorHarness(undefined, { userDO: user.userDO, workspace: 'issues-owner', ownerUserId: OWNER_ID });
  const put = user.userDO.putWorkspaceOverview.bind(user.userDO);
  const landed = Promise.withResolvers<void>();

  Object.assign(user.userDO, {
    putWorkspaceOverview: async (...args: Parameters<typeof put>) => {
      await put(...args);
      landed.resolve();
    },
  });
  agent.agent.harnessHoldsCapability(token);
  await user.userDO.ensureProfile(await testOwner(), owner.email);
  const files = workspaceFiles(agent.agent);

  await files.mkdir('/slates/issues/src', { recursive: true });
  await writeText(files, '/slates/issues/package.json', JSON.stringify({ name: 'issues', main: 'src/server.ts', slate: { title: 'Issue triage' } }));
  await writeText(files, '/slates/issues/src/server.ts', 'export default {};');
  const acquired: string[] = [];
  const partialEnv: Partial<Env> = {};

  Object.assign(partialEnv, {
    ...TEST_USER_ENV,
    OrchestratorAgent: { idFromName: (name: string) => name, get: (id: string) => { acquired.push(id);

 return agent.agent; } },
    UserDO: { idFromName: (name: string) => name, get: () => user.userDO },
  });

  // SAFETY: constructed above is every member the shared routes read: the account namespace whose tiles the library
  // lists and the workspace namespace it must not touch. Nothing unassigned is reachable from the requests driven.
  const env = partialEnv as Env;

  cleanups.push(() => { user.close(); });

  return { env, user, agent, acquired, tile: landed.promise };
}

test("the owner's Drive lists their slates from the tiles their workspaces pushed, asking no workspace", async () => {
  const world = await ownerWorld();

  // The tile a workspace pushes after any change of its slates.
  await world.agent.agent.requestOverviewPush();
  await world.tile;
  world.acquired.length = 0;
  // After the harness: the routes reach the slate host, which imports the platform the harness stands in for.
  const { sharedRoutes } = await import('../src/shared/routes');
  const res = present(await serveFamily(sharedRoutes, { identity: owner })(new Request('https://app.test/api/shared'), world.env), 'the library');
  const library = v.parse(DriveLibrarySchema, await res.json());

  expect(library.slates).toEqual([{ id: 'issues', title: 'Issue triage', workspace: 'issues-owner' }]);
  expect({ shared: library.shared, used: library.used, starred: library.starred }).toEqual({ shared: [], used: [], starred: [] });
  expect(world.acquired).toEqual([]);
});
