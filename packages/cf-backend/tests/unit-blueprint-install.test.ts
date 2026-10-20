// Installing a workspace blueprint through the account's route: the new workspace is born with the blueprint's soul,
// layout, main agent and schedules before its first turn, and the Personal assistant becomes the owner's Home, once.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { Hono } from 'hono';
import {
  asFetchFunction, BUILTIN_PROFILE_CATALOG, DEFAULT_WORKERS_AI_MODEL_SPEC, profileCatalogDigest,
  type NameOrigin, type ProfileCatalogEnvelope, type UserCaller, type WorkspaceSeed,
} from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';
import type { FamilyEnv } from '../src/api/context';
import { handleInstallRequest, installedAssistant, type InstallAuthority, type InstallBody } from '../src/user/blueprint-install';
import type { CreateWorkspaceEnv } from '../src/user/workspace-access';
import { serveFamily } from './helpers/api';
import { userAccount, workspaceObject } from './helpers/bindings';
import { TEST_CREDENTIAL_ENCRYPTION_KEY, testOwner } from './helpers/user-do';

const USER_ID = '0123456789abcdef0123456789abcdef';

const ENVELOPE: ProfileCatalogEnvelope = {
  authority: { kind: 'account', accountId: USER_ID }, version: 1,
  digest: profileCatalogDigest({ ...BUILTIN_PROFILE_CATALOG, tiers: { default: { model: DEFAULT_WORKERS_AI_MODEL_SPEC } } }),
  catalog: { ...BUILTIN_PROFILE_CATALOG, tiers: { default: { model: DEFAULT_WORKERS_AI_MODEL_SPEC } } },
};

/** An account and the workspaces it creates, every birth step recorded in order. */
function account() {
  const config = new Map<string, string>();
  const active: string[] = [];
  const counted: string[] = [];
  // A make that fails at its seed, once, as an orchestrator that did not answer fails.
  const failing = { seed: false };
  // `homeWhenListed`: the workspace Home named as this one was listed on the roster.
  const births: { name: string; steps: string[]; soul: string; seed: WorkspaceSeed | null; homeWhenListed: string | null }[] = [];

  const userDO = userAccount({
    async getWorkspaceProfileCatalog(_caller: UserCaller) { return ENVELOPE; },
    async getAuth(_caller: UserCaller) { return { headers: { authorization: 'Bearer token' }, baseURL: 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1' }; },
    async listCredentials(_caller: UserCaller) { return []; },
    async ensureWorkspaceCapability() {},
    async registerWorkspace(_caller: UserCaller, name: string, displayName?: string) {
      // As the account answers a name it already lists: as it is, not made again.
      if (active.includes(name)) return { entry: { name, displayName: displayName ?? name, createdAt: 7, lastVisited: 7 }, status: 'active' as const };
      active.push(name);
      births.push({ name, steps: [], soul: '', seed: null, homeWhenListed: config.get('assistant') ?? null });

      return { entry: { name, displayName: displayName ?? name, createdAt: 7, lastVisited: 7 }, status: 'created' as const };
    },
    async releaseWorkspaceReservation() { return true; },
    // As the account removes one (`workspaces.ts`): off the roster, and no longer the assistant if it was.
    async removeWorkspace(_caller: UserCaller, name: string) {
      active.splice(active.indexOf(name), 1);

      if (config.get('assistant') === name) config.delete('assistant');
    },
    async getConfig(_caller: UserCaller, key: string) { return config.get(key) ?? null; },
    async claimConfig(_caller: UserCaller, key: string, proposed: string) {
      const held = config.get(key) ?? proposed;

      config.set(key, held);

      return held;
    },
    async listActiveWorkspaces(_caller: UserCaller) { return active.map((name) => ({ name, displayName: name, createdAt: 7 })); },
    async getProfile(_caller: UserCaller) {
      return { email: 'ashish@cloudflare.com', displayName: 'Ashish', createdAt: 1, lastSeenAt: 1, onboardedAt: null, workspaceCount: active.length };
    },
  });

  const born = () => present(births.at(-1), 'a workspace being born');

  const step = (name: string) => { born().steps.push(name); };

  const orchestrator = workspaceObject({
    async claimOwner(userId: string) {
      step('claim');

      return { owner: userId, capabilityHash: null };
    },
    async setInitialDisplayName(displayName: string, nameOrigin: NameOrigin) {
      step(`title:${displayName}`);

      return { displayName, nameOrigin };
    },
    async setSoul(soul: string) {
      step('soul');
      born().soul = soul;

      return { soul, purpose: '' };
    },
    async seedBlueprint(seed: WorkspaceSeed) {
      step('seed');

      if (failing.seed) {
        failing.seed = false;
        throw new Error('the workspace did not answer');
      }

      born().seed = seed;
    },
    async resetWorkspaceBaseline() {
      step('baseline');

      return { ok: true as const, capturedAt: 0, cleanupFailures: [] };
    },
    async beginGenesisTurn() {
      step('genesis');

      return { started: true };
    },
  });

  const env: CreateWorkspaceEnv<string> = {
    UserDO: { idFromName: (name) => name, get: () => userDO },
    OrchestratorAgent: { idFromName: (name) => name, get: () => orchestrator },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  };

  const authority: InstallAuthority = userDO;

  // One provider stand-in while any install runs, so installs at once share it.
  let installing = 0;
  const originalFetch = globalThis.fetch;

  const install = async (id: string, body: Partial<InstallBody>) => {
    const owner = await testOwner();

    const family = new Hono<FamilyEnv<CreateWorkspaceEnv<string>, object>>()
      .post('/api/user/blueprints/:id/install', async (c) => handleInstallRequest({
        request: c.req.raw, env: c.env, userId: USER_ID, userDO: authority, owner, id: c.req.param('id'),
        counted: async (blueprint) => {
          if (blueprint === 'release-manager') throw new Error('the control plane is unreachable');
          counted.push(blueprint);
        },
      }));

    // No reachable provider: the menu falls back to the native Workers AI default, as production creates do.
    if (installing++ === 0) globalThis.fetch = asFetchFunction(async () => new Response('{}', { status: 503 }));

    try {
      const response = present(await serveFamily(family)(new Request(`https://kinu.run/api/user/blueprints/${id}/install`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }), env), 'an answer');

      return { status: response.status, body: await response.json() };
    } finally {
      if (--installing === 0) globalThis.fetch = originalFetch;
    }
  };

  const removal = async (name: string) => { await userDO.removeWorkspace(await testOwner(), name, USER_ID); };

  return { install, births, config, active, counted, failing, removal, home: async () => installedAssistant(authority, await testOwner()) };
}

const InstalledSchema = v.object({ workspace: v.string() });

describe('installing a workspace blueprint', () => {
  test('the Personal assistant is born with its soul, focus layout, name and schedules before its first turn, and becomes Home', async () => {
    const owner = account();
    const answer = await owner.install('personal-assistant', { agent: 'Jarvis', brief: '08:30', timeZone: 'Europe/Berlin', home: true });
    const { workspace } = v.parse(InstalledSchema, answer.body);
    const birth = present(owner.births[0], 'the assistant');

    expect(answer.status).toBe(201);
    expect(birth.steps).toEqual(['claim', 'title:Personal assistant', 'soul', 'seed', 'baseline', 'genesis']);
    expect(birth.soul).toStartWith('# Jarvis\n\n## Mission\n\nBe Ashish\'s personal assistant');
    expect(birth.soul).not.toContain('{{');
    expect(birth.seed).toEqual({
      blueprint: 'personal-assistant', layout: 'focus', agent: 'Jarvis',
      schedules: [
        { label: 'Daily brief', cron: '30 8 * * *', timeZone: 'Europe/Berlin', prompt: expect.stringContaining("Write Ashish's brief for today") },
        { label: 'GitHub check', cron: '*/15 * * * *', prompt: expect.stringContaining('GitHub tools') },
        { label: 'Gmail check', cron: '*/15 * * * *', prompt: expect.stringContaining("Ashish's Gmail") },
      ],
    });
    expect(await owner.home()).toBe(workspace);
    // Named Home before it was listed, so the roster's first frame of it already says Home.
    expect(birth.homeWhenListed).toBe(workspace);
    expect(owner.counted).toEqual(['personal-assistant']);
  });

  test('installing the assistant again opens the one the owner has; once it is removed, Home has none and a new one is made', async () => {
    const owner = account();
    const first = v.parse(InstalledSchema, (await owner.install('personal-assistant', { timeZone: 'UTC' })).body).workspace;

    expect(v.parse(InstalledSchema, (await owner.install('personal-assistant', { timeZone: 'UTC' })).body).workspace).toBe(first);
    expect(owner.births).toHaveLength(1);

    await present(owner.removal, 'removal')(first);
    expect(await owner.home()).toBeNull();
    expect(v.parse(InstalledSchema, (await owner.install('personal-assistant', { timeZone: 'UTC' })).body).workspace).not.toBe(first);
    expect(owner.births).toHaveLength(2);
  });

  // The rc27 review: each install read "no assistant yet" and made its own, so two tabs, or a retried request, made two.
  test('installs at once make one assistant and both answer it', async () => {
    const owner = account();
    const answers = await Promise.all([1, 2].map(async () => owner.install('personal-assistant', { timeZone: 'UTC' })));
    const named = answers.map((answer) => v.parse(InstalledSchema, answer.body).workspace);

    expect(named[0]).toBe(named[1]);
    expect(owner.births).toHaveLength(1);
    expect(owner.active).toEqual([named[0]]);
    expect(await owner.home()).toBe(named[0]);
  });

  test('a make that failed leaves no assistant behind, and the next install makes the one', async () => {
    const owner = account();

    owner.failing.seed = true;
    expect((await owner.install('personal-assistant', { timeZone: 'UTC' })).status).toBe(500);
    expect(owner.active).toEqual([]);
    expect(owner.config.get('assistant')).toBeUndefined();

    const made = v.parse(InstalledSchema, (await owner.install('personal-assistant', { timeZone: 'UTC' })).body).workspace;

    expect(owner.active).toEqual([made]);
    expect(await owner.home()).toBe(made);
  });

  test("another blueprint keeps its own layout and the owner's title, Home stays as it was, and a count Explore missed undoes nothing", async () => {
    const owner = account();
    const answer = await owner.install('release-manager', { displayName: 'API Worker v2 release', timeZone: 'America/Los_Angeles' });
    const birth = present(owner.births[0], 'the release workspace');

    expect(answer.status).toBe(201);
    expect(birth.steps).toContain('title:API Worker v2 release');
    expect(birth.seed).toEqual({ blueprint: 'release-manager', layout: 'workbench', agent: 'Release', schedules: [] });
    expect(await owner.home()).toBeNull();
    expect(birth.homeWhenListed).toBeNull();
    expect(owner.counted).toEqual([]);
  });

  test('a blueprint Kinu does not keep is refused as missing, and a body without a time zone the runtime knows is refused', async () => {
    const owner = account();

    expect((await owner.install('pricing-watch', { timeZone: 'UTC' })).status).toBe(404);
    expect((await owner.install('personal-assistant', { brief: '08:00' })).status).toBe(400);
    expect((await owner.install('personal-assistant', { brief: '08:00', timeZone: 'Mars/Olympus_Mons' })).status).toBe(400);
    expect(owner.births).toHaveLength(0);
  });
});
