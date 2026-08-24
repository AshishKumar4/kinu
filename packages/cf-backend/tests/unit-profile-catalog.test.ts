// The profile catalog — the account's authority over roles and tiers.
//
// Stored as one JSON row of user_config under a compare-and-swap integer
// version, so two writers cannot silently overwrite each other and every
// accepted write moves the version by exactly one. Owner-session only: the
// catalog IS authority, so even a full-tier workspace is refused until the
// runtime integration adds its narrow read surface.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  BUILTIN_PROFILE_CATALOG,
  ProfileCatalogEnvelopeSchema,
  decodeJsonValue,
  profileCatalogDigest,
  type ProfileCatalog,
  type JsonValue,
  type RoleDefinition,
} from '@kinu.run/core';
import { CapabilityDeniedError } from '../src/user/workspace-capability';
import { createTestUserDO, provisionTestWorkspace, testOwner, type TestUserDO } from './helpers/user-do';

const MODEL = 'workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813';


function role(overrides: Partial<RoleDefinition> = {}): RoleDefinition {
  return {
    description: overrides.description ?? 'Everyday work.',
    instructions: overrides.instructions ?? 'Do the task directly.',
    tier: overrides.tier ?? 'default',
    preset: overrides.preset ?? 'ideate',
  };
}

function catalog(): ProfileCatalog {
  return {
    roles: {
      general: role(),
      researcher: role({ instructions: 'Go deep on sources.', tier: 'fast', preset: 'research' }),
    },
    tiers: {
      default: { model: MODEL },
      fast: { model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e', reasoningEffort: 'low' },
    },
  };
}
async function write(
  harness: TestUserDO,
  expectedVersion: number,
  input: ProfileCatalog | JsonValue,
) {
  return harness.userDO.putProfileCatalog(
    await testOwner(),
    decodeJsonValue({ value: input }),
    expectedVersion,
  );
}

describe('profile catalog reads', () => {
  test('an account that never wrote one reads as the built-ins at version 0', async () => {
    const harness = createTestUserDO();

    const envelope = await harness.userDO.getProfileCatalog(await testOwner());

    expect(envelope.version).toBe(0);
    expect(envelope.authority).toEqual({ kind: 'account', accountId: expect.any(String) });
    expect(envelope.catalog).toEqual(BUILTIN_PROFILE_CATALOG);
    expect(envelope.digest).toBe(profileCatalogDigest(BUILTIN_PROFILE_CATALOG));
    // The envelope is wire truth, not just an internal shape.
    expect(v.safeParse(ProfileCatalogEnvelopeSchema, envelope).success).toBe(true);
    harness.close();
  });

  test('a stored catalog round-trips with its digest and version', async () => {
    const harness = createTestUserDO();
    const written = await write(harness, 0, catalog());
    expect(written.ok).toBe(true);

    if (!written.ok) throw new Error('write refused');
    const read = await harness.userDO.getProfileCatalog(await testOwner());
    expect(read).toEqual(written.envelope);
    expect(read.digest).toBe(profileCatalogDigest(catalog()));
    harness.close();
  });
});

describe('profile catalog compare-and-swap writes', () => {
  test('every accepted write increments the version by exactly one', async () => {
    const harness = createTestUserDO();

    const first = await write(harness, 0, catalog());
    if (!first.ok) throw new Error('first write refused');
    expect(first.envelope.version).toBe(1);

    const second = await write(harness, 1, catalog());
    if (!second.ok) throw new Error('second write refused');
    expect(second.envelope.version).toBe(2);

    const read = await harness.userDO.getProfileCatalog(await testOwner());
    expect(read.version).toBe(2);
    harness.close();
  });

  test('two simultaneous writers produce one winner and one conflict', async () => {
    const harness = createTestUserDO();
    const left = catalog();
    const right: ProfileCatalog = {
      ...catalog(),
      roles: {
        ...catalog().roles,
        planner: role({ instructions: 'Plan before changing files.', preset: 'optimise' }),
      },
    };

    const results = await Promise.all([
      write(harness, 0, left),
      write(harness, 0, right),
    ]);

    const success = results.find((result) => result.ok);
    const conflict = results.find((result) => !result.ok && result.kind === 'conflict');
    if (!success?.ok) throw new Error('CAS produced no winner');
    if (!conflict || conflict.ok || conflict.kind !== 'conflict') throw new Error('CAS produced no conflict');
    expect(success.envelope.version).toBe(1);
    expect(conflict.currentVersion).toBe(1);
    expect(conflict.currentDigest).toBe(success.envelope.digest);
    expect(await harness.userDO.getProfileCatalog(await testOwner())).toEqual(success.envelope);
    harness.close();
  });

  test('a stale expectedVersion refuses and leaves the winner standing', async () => {
    const harness = createTestUserDO();
    await write(harness, 0, catalog());
    const winner: ProfileCatalog = {
      ...catalog(),
      roles: {
        ...catalog().roles,
        planner: role({ instructions: 'Plan first.', preset: 'optimise' }),
      },
    };
    const accepted = await write(harness, 1, winner);
    if (!accepted.ok) throw new Error('winner write refused');

    const loser = await write(harness, 1, catalog());

    expect(loser).toMatchObject({ ok: false, kind: 'conflict', currentVersion: 2 });
    if (!loser.ok && loser.kind === 'conflict') {
      expect(loser.currentDigest).toBe(profileCatalogDigest(winner));
    }
    const read = await harness.userDO.getProfileCatalog(await testOwner());
    expect(read.version).toBe(2);
    expect(Object.keys(read.catalog.roles)).toContain('planner');
    harness.close();
  });

  test('the pristine store conflicts for any expectedVersion but zero', async () => {
    const harness = createTestUserDO();

    const stale = await write(harness, 3, catalog());
    expect(stale).toMatchObject({ ok: false, kind: 'conflict', currentVersion: 0 });

    const seeded = await write(harness, 0, catalog());
    expect(seeded.ok).toBe(true);
    harness.close();
  });

  test('a malformed catalog is rejected before any write, naming the field at fault', async () => {
    const harness = createTestUserDO();
    await write(harness, 0, catalog());

    // The third member is the path the refusal MUST name. This reason is the
    // whole of what an owner is shown about a catalog the account would not
    // take, so a refusal that says only "invalid" leaves them guessing which of
    // two dozen fields to look at. It is rendered from the whole cause chain for
    // the same reason: the frame that names the path can sit one `cause` below a
    // wrapper, and the outermost message is the least informative one.
    const cases: Array<[string, JsonValue, string]> = [
      ['role missing its description', {
        roles: { general: { instructions: 'Do the task directly.', tier: 'default', preset: 'ideate' } },
        tiers: { default: { model: MODEL } },
      }, 'roles.general.description'],
      [
        'unknown tier id',
        { roles: {}, tiers: { default: { model: MODEL }, giant: { model: MODEL } } },
        'tiers.giant',
      ],
      ['definition repeating its record key', {
        roles: {
          general: {
            description: 'Everyday work.',
            instructions: 'Do the task directly.',
            tier: 'default',
            preset: 'ideate',
            id: 'general',
          },
        },
        tiers: { default: { model: MODEL } },
      }, 'roles.general.id'],
      ['tier without a model', { roles: {}, tiers: { default: {} } }, 'tiers.default.model'],
    ];
    for (const [name, bad, path] of cases) {
      const result = await write(harness, 1, bad);
      expect(result.ok, name).toBe(false);
      if (!result.ok && result.kind === 'malformed') expect(result.reason, name).toContain(path);
    }

    const read = await harness.userDO.getProfileCatalog(await testOwner());
    expect(read.version).toBe(1);
    expect(read.catalog).toEqual(catalog());
    harness.close();
  });

  test('a malformed stored value fails loudly and preserves its CAS version', async () => {
    const harness = createTestUserDO();
    const first = await write(harness, 0, catalog());
    if (!first.ok) throw new Error('first write refused');
    harness.db.query(`UPDATE user_config SET value = ? WHERE key = 'profile_catalog'`)
      .run('{not-json');

    await expect(harness.userDO.getProfileCatalog(await testOwner()))
      .rejects.toThrow('stored account profile catalog cannot be decoded as JSON');
    await expect(write(harness, 1, catalog()))
      .rejects.toThrow('stored account profile catalog cannot be decoded as JSON');

    const persisted = harness.db.query<{ value: string; version: number }, []>(
      `SELECT value, version FROM user_config WHERE key = 'profile_catalog'`,
    ).all();
    expect(persisted).toEqual([{ value: '{not-json', version: 1 }]);
    harness.close();
  });

  test('a negative or fractional expectedVersion never reaches the store', async () => {
    const harness = createTestUserDO();

    for (const expectedVersion of [-1, 1.5, Number.NaN]) {
      const result = await write(harness, expectedVersion, catalog());
      expect(result).toMatchObject({ ok: false, kind: 'malformed' });
    }
    const read = await harness.userDO.getProfileCatalog(await testOwner());
    expect(read.version).toBe(0);
    harness.close();
  });
});

describe('profile catalog authority', () => {
  test('a workspace can resolve the catalog but cannot use owner read/write routes', async () => {
    const harness = createTestUserDO();
    const token = await provisionTestWorkspace(harness, 'trusted-ws');
    const workspaceCaller = { workspaceToken: token };

    await expect(harness.userDO.getProfileCatalog(workspaceCaller)).rejects.toBeInstanceOf(CapabilityDeniedError);
    const resolved = await harness.userDO.getWorkspaceProfileCatalog(workspaceCaller);
    expect(resolved.catalog).toEqual(BUILTIN_PROFILE_CATALOG);
    await expect(harness.userDO.putProfileCatalog(
      workspaceCaller,
      decodeJsonValue({ value: catalog() }),
      0,
    )).rejects.toBeInstanceOf(CapabilityDeniedError);
    const read = await harness.userDO.getProfileCatalog(await testOwner());
    expect(read.version).toBe(0);
    harness.close();
  });

  test('a caller with an empty workspace capability is refused', async () => {
    const harness = createTestUserDO();

    await expect(harness.userDO.getProfileCatalog({ workspaceToken: '' })).rejects.toBeInstanceOf(CapabilityDeniedError);
    harness.close();
  });
});

describe('profile catalog storage hygiene', () => {
  test('the response carries only the envelope, and the store only the catalog', async () => {
    const harness = createTestUserDO();
    const secret = 'supersecret-token-value-9f2b7c';
    await harness.userDO.setCredential(await testOwner(), 'ci-key', { kind: 'bearer', token: secret });
    await write(harness, 0, catalog());

    const envelope = await harness.userDO.getProfileCatalog(await testOwner());

    expect(Object.keys(envelope).sort()).toEqual(['authority', 'catalog', 'digest', 'version']);
    expect(JSON.stringify(envelope)).not.toContain(secret);
    // The canonical row holds exactly one key whose value is the catalog JSON.
    const rows = harness.db.query<{ key: string; value: string }, []>(
      `SELECT key, value FROM user_config`,
    ).all();
    const catalogRow = rows.find((r) => r.key === 'profile_catalog');
    if (!catalogRow) throw new Error('profile catalog row missing');
    expect(Object.keys(JSON.parse(catalogRow.value)).sort()).toEqual(['roles', 'tiers']);
    expect(JSON.stringify(rows.map((r) => r.value))).not.toContain(secret);
    const owner = await testOwner();
    await expect(harness.userDO.getConfig(owner, 'profile_catalog'))
      .rejects.toThrow('dedicated typed CAS route');
    await expect(harness.userDO.setConfig(owner, 'profile_catalog', '{}'))
      .rejects.toThrow('dedicated typed CAS route');
    expect(await harness.userDO.listConfig(owner)).not.toHaveProperty('profile_catalog');
    harness.close();
  });
});
