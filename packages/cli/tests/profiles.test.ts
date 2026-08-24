// The profile authority and cache: signed-out local authority inside
// config.json, per-account read-only cache outside it, resolution by
// authenticated identity, CAS updates against the cloud route.
//
// Disk-bound scenarios run in a subprocess (config.ts binds KINU_HOME at
// import); the cloud-api methods run in-process against a local Bun server.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  JsonValueSchema, profileCatalogDigest, validateProfileCatalog,
  type JsonObject, type JsonValue, type ProfileCatalog, type ProfileCatalogEnvelope,
} from "@kinu.run/core";
import * as v from 'valibot';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function catalogA(): ProfileCatalog {
  return {
    roles: {
      general: { description: 'everyday work', instructions: 'Do the task directly.', tier: 'default', preset: 'ideate' },
      researcher: { description: 'finds things out', instructions: 'Research before answering.', tier: 'fast', preset: 'research' },
    },
    tiers: {
      default: { model: 'deepseek' },
      fast: { model: 'fast-model', reasoningEffort: 'low' },
    },
  };
}

/** Disjoint content from catalogA — replace must leave zero traces of A. */
function catalogB(): ProfileCatalog {
  return {
    roles: {
      auditor: { description: 'checks work', instructions: 'Audit the result.', tier: 'slow', preset: 'audit' },
    },
    tiers: { default: { model: 'other-model' } },
  };
}

/** A server-shaped account envelope, the way a GET response arrives. */
function accountEnvelope(accountId: string, catalog: ProfileCatalog, version = 1): ProfileCatalogEnvelope {
  return {
    authority: { kind: 'account', accountId },
    version,
    digest: profileCatalogDigest(catalog),
    catalog,
  };
}

interface StepOutcome { ok: boolean; value?: JsonValue; error?: string }

const StepOutcomeSchema: v.GenericSchema<StepOutcome> = v.object({
  ok: v.boolean(),
  value: v.optional(JsonValueSchema),
  error: v.optional(v.string()),
});

/** The envelope as the assertions read it: authority kind, version, and the
 *  role/tier keys, parsed rather than asserted out of untyped JSON. */
const ParsedEnvelope = v.object({
  authority: v.looseObject({ kind: v.string(), accountId: v.optional(v.string()) }),
  version: v.number(),
  digest: v.string(),
  catalog: v.object({
    roles: v.record(v.string(), v.looseObject({})),
    tiers: v.record(v.string(), v.looseObject({})),
  }),
});

const ParsedAuthoritySource = v.looseObject({
  kind: v.string(),
  accountId: v.optional(v.string()),
});

const ParsedCacheModes = v.object({ cache: v.number(), dir: v.number() });
/**
 * Runs one disk-bound scenario in a clean subprocess with its own KINU_HOME,
 * optionally seeded before the script starts. The `body` script executes via
 * `bun -e`, so every module reference inside it stays a runtime import: a
 * static top-level import would bind THIS process's KINU_HOME before the
 * scenario home exists.
 */
function runScenario(body: string, opts: {
  setup?: (home: string) => void;
  env?: Record<string, string>;
} = {}): Record<string, StepOutcome> {
  const kinuHome = mkdtempSync(join(tmpdir(), 'kinu-cli-profiles-'));
  tempDirs.push(kinuHome);
  opts.setup?.(kinuHome);
  const script = `
    const steps = {};
    async function step(name, fn) {
      try { steps[name] = { ok: true, value: await fn() }; }
      catch (err) { steps[name] = { ok: false, error: err instanceof Error ? err.message : String(err) }; }
    }
    ${body}
    console.log(JSON.stringify(steps));
  `;
  const env: NodeJS.ProcessEnv = { ...process.env, KINU_HOME: kinuHome, ...opts.env };
  for (const name of ['KINU_TOKEN', 'KINU_ORIGIN']) {
    if (!(name in (opts.env ?? {}))) delete env[name];
  }
  const proc = Bun.spawnSync({
    cmd: [process.execPath, '-e', script],
    cwd: resolve(__dirname, '../../..'),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    throw new Error(`scenario subprocess failed (${proc.exitCode}): ${proc.stderr.toString()}`);
  }
  return v.parse(v.record(v.string(), StepOutcomeSchema), JSON.parse(proc.stdout.toString()));
}

function expectOk(step: StepOutcome | undefined): JsonValue {
  expect(step?.ok).toBe(true);
  return step?.value ?? null;
}

function expectError(step: StepOutcome | undefined, fragment: string): void {
  expect(step?.ok).toBe(false);
  expect(step?.error ?? '').toContain(fragment);
}

describe('local profile authority', () => {
  test('import seeds version 1 under local authority and persists into config.json', () => {
    const steps = runScenario(`
      await step('import', async () => {
        const { importLocalProfile } = await import('./packages/cli/src/profiles.ts');
        return importLocalProfile(${JSON.stringify(catalogA())});
      });
      await step('reload', async () => {
        const { loadLocalProfileAuthority } = await import('./packages/cli/src/profiles.ts');
        return loadLocalProfileAuthority();
      });
      await step('configOnDisk', async () => {
        const { readFileSync } = await import('node:fs');
        return readFileSync(process.env.KINU_HOME + '/config.json', 'utf-8');
      });
    `);
    const imported = v.parse(ParsedEnvelope, expectOk(steps.import));
    expect(imported.authority).toEqual({ kind: 'local' });
    expect(imported.version).toBe(1);
    expect(imported.digest).toBe(profileCatalogDigest(validateProfileCatalog(catalogA())));
    expect(v.parse(ParsedEnvelope, expectOk(steps.reload))).toEqual(imported);
    // The envelope lives in config.json under the local slot, and nowhere
    // does the file claim account authority.
    const onDisk = String(expectOk(steps.configOnDisk));
    expect(onDisk).toContain('"localProfile"');
    expect(onDisk).not.toContain('"account"');
  });

  test('fresh authority uses the same environment model that workspace creation accepts', () => {
    const steps = runScenario(`
      await step('load', async () => {
        const { loadActiveProfile } = await import('./packages/cli/src/profiles.ts');
        return loadActiveProfile();
      });
    `, {
      env: {
        KINU_MODEL: 'test/model',
        KINU_BASE_URL: 'http://127.0.0.1:65534/v1',
        KINU_AUTH: 'Bearer profile-test',
      },
    });
    const loaded = v.parse(ParsedEnvelope, expectOk(steps.load));
    expect(loaded.catalog.tiers.default.model).toBe('test/model');
  });

  test('a second import refuses and names the explicit replacement path', () => {
    const steps = runScenario(`
      await step('first', async () => {
        const { importLocalProfile } = await import('./packages/cli/src/profiles.ts');
        return importLocalProfile(${JSON.stringify(catalogA())});
      });
      await step('second', async () => {
        const { importLocalProfile } = await import('./packages/cli/src/profiles.ts');
        return importLocalProfile(${JSON.stringify(catalogB())});
      });
      await step('stillA', async () => {
        const { loadLocalProfileAuthority } = await import('./packages/cli/src/profiles.ts');
        return loadLocalProfileAuthority();
      });
    `);
    expectOk(steps.first);
    expectError(steps.second, 'replace');
    // Refused means refused: the first import still stands untouched.
    expect(v.parse(ParsedEnvelope, expectOk(steps.stillA)).catalog.roles).toHaveProperty('general');
  });

  test('replace overwrites wholesale and bumps the version — nothing merges', () => {
    const steps = runScenario(`
      await step('import', async () => {
        const { importLocalProfile } = await import('./packages/cli/src/profiles.ts');
        return importLocalProfile(${JSON.stringify(catalogA())});
      });
      await step('replace', async () => {
        const { replaceLocalProfile } = await import('./packages/cli/src/profiles.ts');
        return replaceLocalProfile(${JSON.stringify(catalogB())});
      });
      await step('reloaded', async () => {
        const { loadLocalProfileAuthority } = await import('./packages/cli/src/profiles.ts');
        return loadLocalProfileAuthority();
      });
    `);
    expect(v.parse(ParsedEnvelope, expectOk(steps.import)).version).toBe(1);
    expect(v.parse(ParsedEnvelope, expectOk(steps.replace)).version).toBe(2);
    const reloaded = v.parse(ParsedEnvelope, expectOk(steps.reloaded));
    expect(Object.keys(reloaded.catalog.roles)).toEqual(['auditor']);
    expect(reloaded.catalog.tiers.default.model).toBe('other-model');
    expect(reloaded.digest).toBe(profileCatalogDigest(validateProfileCatalog(catalogB())));
  });

  test('an invalid catalog fails validation instead of landing on disk', () => {
    const steps = runScenario(`
      await step('badRole', async () => {
        const { importLocalProfile } = await import('./packages/cli/src/profiles.ts');
        return importLocalProfile({ roles: { 'Bad_Id': { description: 'x', instructions: 'y', tier: 'default', preset: 'ideate' } }, tiers: { default: { model: 'm' } } });
      });
      await step('absent', async () => {
        const { loadLocalProfileAuthority } = await import('./packages/cli/src/profiles.ts');
        return loadLocalProfileAuthority();
      });
    `);
    expectError(steps.badRole, 'invalid profile catalog');
    expect(expectOk(steps.absent)).toBeNull();
  });
});

describe('account cache isolation', () => {
  /** Caches two disjoint account entries through the real write path. */
  const SEED_ACCOUNTS = `
    const A = ${JSON.stringify(catalogA())};
    const B = ${JSON.stringify(catalogB())};
    const { cacheAccountProfile } = await import('./packages/cli/src/profiles.ts');
    const { profileCatalogDigest } = await import('@kinu.run/core');
    for (const [id, catalog] of [['acc-a', A], ['acc-b', B]]) {
      cacheAccountProfile(id, { authority: { kind: 'account', accountId: id }, version: 3, digest: profileCatalogDigest(catalog), catalog });
    }
  `;

  test('entries are keyed by account, live outside KinuConfig, and never bleed across', () => {
    const steps = runScenario(`
      ${SEED_ACCOUNTS}
      await step('readA', async () => {
        const { loadCachedAccountProfile } = await import('./packages/cli/src/profiles.ts');
        return loadCachedAccountProfile('acc-a');
      });
      await step('readB', async () => {
        const { loadCachedAccountProfile } = await import('./packages/cli/src/profiles.ts');
        return loadCachedAccountProfile('acc-b');
      });
      await step('readUnknown', async () => {
        const { loadCachedAccountProfile } = await import('./packages/cli/src/profiles.ts');
        return loadCachedAccountProfile('acc-other');
      });
      await step('configText', async () => {
        const { existsSync, readFileSync } = await import('node:fs');
        if (!existsSync(process.env.KINU_HOME + '/config.json')) return '(no config.json)';
        return readFileSync(process.env.KINU_HOME + '/config.json', 'utf-8');
      });
      await step('cacheText', async () => {
        const { readFileSync } = await import('node:fs');
        return readFileSync(process.env.KINU_HOME + '/profile-cache.json', 'utf-8');
      });
    `);
    const a = v.parse(ParsedEnvelope, expectOk(steps.readA));
    expect(a.authority).toEqual({ kind: 'account', accountId: 'acc-a' });
    expect(a.version).toBe(3);
    expect(Object.keys(a.catalog.roles)).toContain('general');
    const b = v.parse(ParsedEnvelope, expectOk(steps.readB));
    expect(b.authority).toEqual({ kind: 'account', accountId: 'acc-b' });
    expect(Object.keys(b.catalog.roles)).toEqual(['auditor']);
    expect(expectOk(steps.readUnknown)).toBeNull();
    // KinuConfig holds neither account's data — the cache file does.
    expect(String(expectOk(steps.configText))).not.toContain('acc-a');
    const cacheText = String(expectOk(steps.cacheText));
    expect(cacheText).toContain('acc-a');
    expect(cacheText).toContain('acc-b');
  });

  test('the cache file and its directory stay owner-only', () => {
    const steps = runScenario(`
      ${SEED_ACCOUNTS}
      await step('modes', async () => {
        const { statSync } = await import('node:fs');
        return {
          cache: statSync(process.env.KINU_HOME + '/profile-cache.json').mode & 0o777,
          dir: statSync(process.env.KINU_HOME).mode & 0o777,
        };
      });
    `);
    const modes = v.parse(ParsedCacheModes, expectOk(steps.modes));
    expect(modes.cache).toBe(0o600);
    expect(modes.dir).toBe(0o700);
  });

  function sessionPatch(patch: JsonObject): string {
    return `
      const { writeFileSync } = await import('node:fs');
      const { loadConfigFile } = await import('./packages/cli/src/config.ts');
      writeFileSync(process.env.KINU_HOME + '/config.json',
        JSON.stringify({ ...loadConfigFile(), ${JSON.stringify(patch).slice(1, -1)} }), { mode: 0o600 });
    `;
  }

  /** Mirrors logoutCommand: undefined values drop the keys entirely, which
   *  is also what the config schema requires (null is not a string). */
  function clearSessionPatch(): string {
    return `
      const { writeFileSync } = await import('node:fs');
      const { loadConfigFile } = await import('./packages/cli/src/config.ts');
      const next = { ...loadConfigFile() };
      delete next.accessToken;
      delete next.tokenExpiresAt;
      delete next.user;
      writeFileSync(process.env.KINU_HOME + '/config.json', JSON.stringify(next), { mode: 0o600 });
    `;
  }

  test('logout and account switching flip resolution without promoting or merging anything', () => {
    const steps = runScenario(`
      ${SEED_ACCOUNTS}
      await step('signedOutSource', async () => {
        const { resolveProfileAuthority } = await import('./packages/cli/src/profiles.ts');
        return resolveProfileAuthority();
      });
      await step('signInA', async () => {
        ${sessionPatch({
          accessToken: 'ptc_session_a',
          tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
          user: { id: 'acc-a', email: 'a@example.com' },
        })}
        const { resolveProfileAuthority, loadLocalProfileAuthority } = await import('./packages/cli/src/profiles.ts');
        return { source: resolveProfileAuthority(), localStillNull: loadLocalProfileAuthority() };
      });
      await step('switchToB', async () => {
        ${sessionPatch({ accessToken: 'ptc_session_b', user: { id: 'acc-b', email: 'b@example.com' } })}
        const { resolveProfileAuthority, loadCachedAccountProfile, loadLocalProfileAuthority } = await import('./packages/cli/src/profiles.ts');
        const source = resolveProfileAuthority();
        const cachedForB = loadCachedAccountProfile(source.kind === 'account' ? source.accountId : '');
        return { source, cachedRoles: Object.keys(cachedForB?.catalog.roles ?? {}), local: loadLocalProfileAuthority() };
      });
      await step('logout', async () => {
        ${clearSessionPatch()}
        const { resolveProfileAuthority, loadLocalProfileAuthority, loadCachedAccountProfile } = await import('./packages/cli/src/profiles.ts');
        return {
          source: resolveProfileAuthority(),
          local: loadLocalProfileAuthority(),
          cacheStillHoldsA: loadCachedAccountProfile('acc-a') !== null,
          cacheStillHoldsB: loadCachedAccountProfile('acc-b') !== null,
        };
      });
    `);
    expect(expectOk(steps.signedOutSource)).toEqual({ kind: 'local' });
    const signedIn = v.parse(v.object({
      source: ParsedAuthoritySource,
      localStillNull: v.null(),
    }), expectOk(steps.signInA));
    expect(signedIn.source).toEqual({ kind: 'account', accountId: 'acc-a' });
    // Signing in promotes nothing into the local slot.
    expect(signedIn.localStillNull).toBeNull();
    const switched = v.parse(v.object({
      source: ParsedAuthoritySource,
      cachedRoles: v.array(v.string()),
      local: v.null(),
    }), expectOk(steps.switchToB));
    expect(switched.source).toEqual({ kind: 'account', accountId: 'acc-b' });
    // Resolution under B reads only B's entry — A's cache never leaks in.
    expect(switched.cachedRoles).toEqual(['auditor']);
    expect(switched.local).toBeNull();
    const loggedOut = v.parse(v.object({
      source: ParsedAuthoritySource,
      local: v.null(),
      cacheStillHoldsA: v.boolean(),
      cacheStillHoldsB: v.boolean(),
    }), expectOk(steps.logout));
    expect(loggedOut.source).toEqual({ kind: 'local' });
    // Logout promotes nothing: local authority stays absent while both
    // cached entries survive on disk, keyed to their accounts.
    expect(loggedOut.local).toBeNull();
    expect(loggedOut.cacheStillHoldsA).toBe(true);
    expect(loggedOut.cacheStillHoldsB).toBe(true);
  });

  test('an expired session resolves local even with a bare KINU_TOKEN present', () => {
    const steps = runScenario(
      `
      await step('expiredSession', async () => {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(process.env.KINU_HOME, { recursive: true });
        writeFileSync(process.env.KINU_HOME + '/config.json', JSON.stringify({
          accessToken: 'ptc_old',
          tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
          user: { id: 'acc-a', email: 'a@example.com' },
        }), { mode: 0o600 });
        const { resolveProfileAuthority } = await import('./packages/cli/src/profiles.ts');
        return resolveProfileAuthority();
      });
      `,
      { env: { KINU_TOKEN: 'ptc_env_only' } },
    );
    expect(expectOk(steps.expiredSession)).toEqual({ kind: 'local' });
  });
});

/** The only key these scenarios ever seed into a fresh config.json. */
interface SeededConfig {
  localProfile: unknown;
}
function seedConfig(home: string, config: SeededConfig): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify(config), { mode: 0o600 });
}

describe('malformed profile data fails loudly', () => {
  function seedCacheFile(content: string): (home: string) => void {
    return (home) => {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, 'profile-cache.json'), content, { mode: 0o600 });
    };
  }

  const LOAD_CACHE = `
    await step('load', async () => {
      const { loadCachedAccountProfile } = await import('./packages/cli/src/profiles.ts');
      return loadCachedAccountProfile('acc-a');
    });
  `;

  test('a corrupt or wrong-shaped cache file throws instead of reading as empty', () => {
    const notJson = runScenario(LOAD_CACHE, { setup: seedCacheFile('{not json') });
    expectError(notJson.load, 'not valid JSON');

    const schemaInvalidCache = runScenario(LOAD_CACHE, {
      setup: seedCacheFile(JSON.stringify({ accounts: { 'acc-a': { version: 'one' } } })),
    });
    expectError(schemaInvalidCache.load, 'not a valid Kinu profile cache');
  });

  test('a tampered catalog fails its digest check on read', () => {
    const envelope = accountEnvelope('acc-a', catalogA());
    const tampered = {
      ...envelope,
      catalog: { ...envelope.catalog, tiers: { ...envelope.catalog.tiers, default: { model: 'swapped-model' } } },
    };
    const steps = runScenario(LOAD_CACHE, {
      setup: seedCacheFile(JSON.stringify({ accounts: { 'acc-a': tampered } })),
    });
    expectError(steps.load, 'digest mismatch');
  });

  test('cache writes refuse an envelope whose authority does not match the key', () => {
    const envelope = JSON.stringify(accountEnvelope('acc-a', catalogA()));
    const steps = runScenario(`
      const ENVELOPE = ${envelope};
      await step('misKeyed', async () => {
        const { cacheAccountProfile } = await import('./packages/cli/src/profiles.ts');
        cacheAccountProfile('acc-b', ENVELOPE);
        return 'written';
      });
    `);
    expectError(steps.misKeyed, 'mismatching authority');
  });

  test('authority kinds cannot cross slots in either store', () => {

    const localKindInCache = runScenario(LOAD_CACHE, {
      setup: seedCacheFile(
        JSON.stringify({
          accounts: {
            'acc-a': { authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalogA()), catalog: catalogA() },
          },
        }),
      ),
    });
    expectError(localKindInCache.load, 'mismatching authority');

    const accountKindInConfig = runScenario(`
      await step('load', async () => {
        const { loadLocalProfileAuthority } = await import('./packages/cli/src/profiles.ts');
        return loadLocalProfileAuthority();
      });
    `, {
      setup: (home) => seedConfig(home, {
        localProfile: {
          authority: { kind: 'account', accountId: 'acc-a' },
          version: 1,
          digest: profileCatalogDigest(catalogA()),
          catalog: catalogA(),
        },
      }),
    });
    expectError(accountKindInConfig.load, 'kind "account"');

    const schemaInvalidInConfig = runScenario(`
      await step('loadConfig', async () => {
        const { loadConfigFile } = await import('./packages/cli/src/config.ts');
        return loadConfigFile();
      });
    `, {
      setup: (home) => seedConfig(home, {
        localProfile: {
          authority: { kind: 'local' },
          version: -4,
          digest: profileCatalogDigest(catalogA()),
          catalog: catalogA(),
        },
      }),
    });
    expectError(schemaInvalidInConfig.loadConfig, 'not a valid Kinu config');
  });
});

// ── cloud-api profile methods ────────────────────────────────────────────────

const SERVED_ENVELOPE = accountEnvelope('srv-account', catalogA(), 7);

/** What a canned profile server hands back to the calling test. */
interface ProfileServerStub {
  origin: string;
  seenRequests: () => SeenRequest[];
  stop: () => void;
}

interface SeenRequest {
  path: string;
  method: string;
  auth: string | null;
  body: JsonValue | null;
}

/** Serves canned /api/cli/profile responses while recording each request. */
function serveProfile(handler: (body: JsonValue | null) => Response | Promise<Response>): ProfileServerStub {
  const seen: SeenRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const raw = req.method === 'PUT' ? await req.json() : null;
      seen.push({
        path: url.pathname,
        method: req.method,
        auth: req.headers.get('authorization'),
        body: raw === null ? null : v.parse(JsonValueSchema, raw),
      });
      return handler(raw);
    },
  });
  return {
    origin: `http://localhost:${server.port}`,
    seenRequests: () => [...seen],
    stop: () => server.stop(true),
  };
}

describe('cloud-api profile methods', () => {
  test('getCloudProfile fetches and parses the account envelope', async () => {
    const { getCloudProfile } = await import('../src/cloud-api');
    const fake = serveProfile(() => Response.json(SERVED_ENVELOPE));
    try {
      const envelope = await getCloudProfile(fake.origin, 'ptc_tok');
      expect(envelope).toEqual(SERVED_ENVELOPE);
      const seen = fake.seenRequests()[0];
      expect(seen).toMatchObject({ path: '/api/cli/profile', method: 'GET', auth: 'Bearer ptc_tok' });
    } finally {
      fake.stop();
    }
  });

  test('updateCloudProfile PUTs the whole catalog with expectedVersion and returns the fresh envelope', async () => {
    const { updateCloudProfile } = await import('../src/cloud-api');
    const next = accountEnvelope('srv-account', catalogB(), 8);
    const fake = serveProfile((body) => {
      const parsed = v.parse(v.object({ expectedVersion: v.number() }), body);
      if (parsed.expectedVersion !== 7) {
        return Response.json(
          { error: 'profile catalog changed underneath you', currentVersion: 7, currentDigest: SERVED_ENVELOPE.digest },
          { status: 409 },
        );
      }
      return Response.json(next);
    });
    try {
      const input = { catalog: catalogB(), expectedVersion: 7 };
      const result = await updateCloudProfile(fake.origin, 'ptc_tok', input);
      expect(result).toEqual({ ok: true, envelope: next });
      const seen = fake.seenRequests()[0];
      expect(seen).toMatchObject({ path: '/api/cli/profile', method: 'PUT', auth: 'Bearer ptc_tok' });
      expect(seen.body).toEqual(JSON.parse(JSON.stringify(input)));
    } finally {
      fake.stop();
    }
  });

  test('a stale expectedVersion surfaces as a structured conflict carrying current version and digest', async () => {
    const { updateCloudProfile } = await import('../src/cloud-api');
    const fake = serveProfile(() =>
      Response.json(
        { error: 'conflict', currentVersion: 9, currentDigest: SERVED_ENVELOPE.digest },
        { status: 409 },
      ));
    try {
      const result = await updateCloudProfile(fake.origin, 'ptc_tok', { catalog: catalogB(), expectedVersion: 4 });
      expect(result).toEqual({ conflict: true, currentVersion: 9, currentDigest: SERVED_ENVELOPE.digest });
    } finally {
      fake.stop();
    }
  });

  test('server rejections keep their message; non-JSON bodies surface the body text', async () => {
    const { getCloudProfile, updateCloudProfile } = await import('../src/cloud-api');
    const invalidCatalog = serveProfile(() => Response.json({ error: 'invalid profile catalog: roles.Bad_Id' }, { status: 400 }));
    try {
      await expect(getCloudProfile(invalidCatalog.origin, 't'))
        .rejects.toThrow('invalid profile catalog');
    } finally {
      invalidCatalog.stop();
    }
    const htmlError = serveProfile(() => new Response('<html>bad gateway</html>', { status: 502 }));
    try {
      // A non-JSON body becomes the message itself: the server's own words
      // outrank the status line whenever they are readable.
      await expect(updateCloudProfile(htmlError.origin, 't', { catalog: catalogA(), expectedVersion: 1 }))
        .rejects.toThrow('bad gateway');
    } finally {
      htmlError.stop();
    }
  });
});
