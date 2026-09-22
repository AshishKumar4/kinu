// Disk-bound scenarios run in a subprocess (config.ts binds KINU_HOME at import);
// the cloud-api methods run in-process against a local Bun server.
import { scratchDir } from '../../test-utils/src/scratch';
import { mkdirSync, writeFileSync } from "node:fs";

import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  BUILTIN_PROFILE_CATALOG, JsonValueSchema, profileCatalogDigest, validateProfileCatalog,
  type JsonObject, type JsonValue, type ProfileCatalog, type ProfileCatalogEnvelope,
} from "@kinu.run/core";
import * as v from 'valibot';

function catalogA(): ProfileCatalog {
  return {
    roles: {
      task: { description: 'everyday work', instructions: 'Do the task directly.', tier: 'default', preset: 'ideate' },
      researcher: { description: 'finds things out', instructions: 'Research before answering.', tier: 'fast', preset: 'research' },
    },
    tiers: {
      default: { model: 'deepseek' },
      fast: { model: 'fast-model', reasoningEffort: 'low' },
    },
  };
}

function catalogB(): ProfileCatalog {
  return {
    roles: {
      auditor: { description: 'checks work', instructions: 'Audit the result.', tier: 'deep', preset: 'audit' },
    },
    tiers: { default: { model: 'other-model' } },
  };
}

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
 * Runs one disk-bound scenario in a subprocess with its own KINU_HOME. `body` runs via `bun -e`, so module
 * references in it must stay runtime imports: a static import would bind this process's KINU_HOME.
 */
function runScenario(body: string, opts: {
  setup?: (home: string) => void;
  env?: Record<string, string>;
} = {}): Record<string, StepOutcome> {
  const kinuHome = scratchDir('cli-profiles');
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

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: kinuHome, KINU_HOME: kinuHome, ...opts.env };

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

function expectText(step: StepOutcome | undefined): string {
  return v.parse(v.string(), expectOk(step));
}

function expectOk(step: StepOutcome | undefined): JsonValue {
  expect(step?.ok, step?.error ?? 'scenario returned no step result').toBe(true);

  return step?.value ?? null;
}

function expectError(step: StepOutcome | undefined, fragment: string): void {
  expect(step?.ok).toBe(false);
  expect(step?.error ?? '').toContain(fragment);
}

function signedIn(accountId: string, origin: string): string {
  return `
    {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(process.env.KINU_HOME, { recursive: true });
      writeFileSync(process.env.KINU_HOME + '/config.json', JSON.stringify({
        origin: ${JSON.stringify(origin)},
        accessToken: 'ptc_session',
        tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        user: { id: ${JSON.stringify(accountId)}, email: 'a@example.com' },
      }), { mode: 0o600 });
    }
  `;
}

/** Session keys are dropped entirely, as `kinu logout` does: the config schema rejects null. */
const SIGNED_OUT = `
  {
    const { writeFileSync } = await import('node:fs');
    const { loadConfigFile } = await import('./packages/cli/src/config.ts');
    const next = { ...loadConfigFile() };
    delete next.accessToken;
    delete next.tokenExpiresAt;
    delete next.user;
    writeFileSync(process.env.KINU_HOME + '/config.json', JSON.stringify(next), { mode: 0o600 });
  }
`;

/**
 * Fills the cache the only way production does: a signed-in resolution the server answered.
 * Leaves the scenario signed in as `accountId`.
 */
function cached(accountId: string, catalog: ProfileCatalog, version: number): string {
  return `
    {
      ${signedIn(accountId, 'https://kinu.test')}
      const served = ${JSON.stringify(accountEnvelope(accountId, catalog, version))};
      const network = globalThis.fetch;
      globalThis.fetch = async (input, init) => String(input).endsWith('/api/cli/profile')
        ? Response.json(served)
        : network(input, init);
      try {
        const { loadActiveProfile } = await import('./packages/cli/src/profiles.ts');
        await loadActiveProfile();
      } finally {
        globalThis.fetch = network;
      }
    }
  `;
}

describe('local profile authority', () => {
  function seededCatalog(model: string): ProfileCatalog {
    return { roles: BUILTIN_PROFILE_CATALOG.roles, tiers: { default: { model } } };
  }

  test('the first tier edit seeds version 1 under local authority and persists into config.json', () => {
    const steps = runScenario(`
      await step('seeded', async () => {
        const { updateDefaultTier } = await import('./packages/cli/src/profiles.ts');
        return updateDefaultTier({ model: 'deepseek' });
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

    const seeded = v.parse(ParsedEnvelope, expectOk(steps.seeded));
    expect(seeded.authority).toEqual({ kind: 'local' });
    expect(seeded.version).toBe(1);
    expect(seeded.digest).toBe(profileCatalogDigest(validateProfileCatalog({ value: seededCatalog('deepseek') })));
    expect(v.parse(ParsedEnvelope, expectOk(steps.reload))).toEqual(seeded);
    const onDisk = expectText(steps.configOnDisk);
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

  test('a later edit supersedes the envelope wholesale and bumps its version', () => {
    const steps = runScenario(`
      const { loadLocalProfileAuthority, updateDefaultTier } =
        await import('./packages/cli/src/profiles.ts');
      await step('first', async () => updateDefaultTier({ model: 'deepseek' }));
      await step('second', async () => updateDefaultTier({ model: 'other-model' }));
      await step('reloaded', async () => loadLocalProfileAuthority());
      await step('configOnDisk', async () => {
        const { readFileSync } = await import('node:fs');
        return readFileSync(process.env.KINU_HOME + '/config.json', 'utf-8');
      });
    `);

    expect(v.parse(ParsedEnvelope, expectOk(steps.first)).version).toBe(1);
    expect(v.parse(ParsedEnvelope, expectOk(steps.second)).version).toBe(2);
    const reloaded = v.parse(ParsedEnvelope, expectOk(steps.reloaded));
    expect(reloaded.catalog.tiers.default.model).toBe('other-model');
    expect(reloaded.digest)
      .toBe(profileCatalogDigest(validateProfileCatalog({ value: seededCatalog('other-model') })));
    expect(expectText(steps.configOnDisk)).not.toContain('deepseek');
  });
});

describe('account cache isolation', () => {
  /** The session is cleared afterwards so neither id can reach config.json and pass for cache data. */
  const SEED_ACCOUNTS = `
    ${cached('acc-a', catalogA(), 3)}
    ${cached('acc-b', catalogB(), 3)}
    ${SIGNED_OUT}
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
    expect(Object.keys(a.catalog.roles)).toContain('task');
    const b = v.parse(ParsedEnvelope, expectOk(steps.readB));
    expect(b.authority).toEqual({ kind: 'account', accountId: 'acc-b' });
    expect(Object.keys(b.catalog.roles)).toEqual(['auditor']);
    expect(expectOk(steps.readUnknown)).toBeNull();
    expect(expectText(steps.configText)).not.toContain('acc-a');
    const cacheText = expectText(steps.cacheText);
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
        ${SIGNED_OUT}
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

    const afterSignIn = v.parse(v.object({
      source: ParsedAuthoritySource,
      localStillNull: v.null(),
    }), expectOk(steps.signInA));

    expect(afterSignIn.source).toEqual({ kind: 'account', accountId: 'acc-a' });
    expect(afterSignIn.localStillNull).toBeNull();

    const switched = v.parse(v.object({
      source: ParsedAuthoritySource,
      cachedRoles: v.array(v.string()),
      local: v.null(),
    }), expectOk(steps.switchToB));

    expect(switched.source).toEqual({ kind: 'account', accountId: 'acc-b' });
    expect(switched.cachedRoles).toEqual(['auditor']);
    expect(switched.local).toBeNull();

    const loggedOut = v.parse(v.object({
      source: ParsedAuthoritySource,
      local: v.null(),
      cacheStillHoldsA: v.boolean(),
      cacheStillHoldsB: v.boolean(),
    }), expectOk(steps.logout));

    expect(loggedOut.source).toEqual({ kind: 'local' });
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

// The one reader a turn resolves through, interactive and daemon: a signed-in turn survives an unreachable
// origin from cache, and a signed-out turn sees catalog edits made after the session started.
describe('the turn profile authority reader', () => {

  const RECORD_DIAGNOSTICS = `
    const { createRecordingLogger, setDiagnosticsSink } = await import('@kinu.run/core/obs');
    const recorder = createRecordingLogger();
    setDiagnosticsSink(recorder);
  `;

  /** An unreachable port, not a stubbed fetch, reproduces a real offline machine's failure shape. */
  const DEAD_ORIGIN = 'http://127.0.0.1:1';

  const ParsedFallback = v.object({
    envelope: ParsedEnvelope,
    diagnostics: v.array(v.object({
      event: v.string(),
      code: v.nullable(v.string()),
      fields: v.record(v.string(), v.union([v.string(), v.number(), v.boolean()])),
    })),
  });

  test('a warm cache answers when the origin is unreachable, and says which version it served', () => {
    const steps = runScenario(`
      ${cached('acc-a', catalogA(), 9)}
      ${signedIn('acc-a', DEAD_ORIGIN)}
      ${RECORD_DIAGNOSTICS}
      await step('resolved', async () => {
        const { createProfileAuthorityReader } = await import('./packages/cli/src/profiles.ts');
        const envelope = await createProfileAuthorityReader()();
        return { envelope, diagnostics: recorder.emitted };
      });
    `);

    const served = v.parse(ParsedFallback, expectOk(steps.resolved));
    expect(served.envelope.authority).toEqual({ kind: 'account', accountId: 'acc-a' });
    expect(served.envelope.version).toBe(9);
    expect(Object.keys(served.envelope.catalog.roles).sort()).toEqual(['researcher', 'task']);
    const [fallback, resolved] = served.diagnostics;
    expect(served.diagnostics.map((line) => line.event))
      .toEqual(['profile.account_cache_served', 'profile.authority_read']);
    expect(fallback?.code).toBe('unavailable');
    expect(fallback?.fields).toMatchObject({ account: 'acc-a', cachedVersion: 9 });
    expect(fallback?.fields.cachedDigest).toBe(served.envelope.digest);
    expect(resolved?.fields).toMatchObject({ source: 'cache' });
    expect(resolved?.fields.durationMs).toBeTypeOf('number');
  });

  test('revalidates the account authority on every turn setup and refreshes its cache', () => {
    const steps = runScenario(`
      ${signedIn('acc-a', 'https://kinu.test')}
      ${RECORD_DIAGNOSTICS}
      let served = ${JSON.stringify(accountEnvelope('acc-a', catalogA(), 4))};
      let fetches = 0;
      globalThis.fetch = async (input) => {
        if (!String(input).endsWith('/api/cli/profile')) throw new Error(String(input));
        fetches += 1;
        return Response.json(served);
      };
      const { createProfileAuthorityReader, loadActiveProfile } =
        await import('./packages/cli/src/profiles.ts');
      // ONE reader, the way a live session builds it once at construction.
      const read = createProfileAuthorityReader();
      await step('firstThenRepeat', async () => {
        const first = await read();
        const second = await read();
        const third = await read();
        return { fetches, versions: [first?.version, second?.version, third?.version] };
      });
      await step('afterCacheWrite', async () => {
        // A newer entry lands in the cache FILE from outside this reader —
        // what a CAS through updateDefaultTier, or another process, leaves
        // behind. loadActiveProfile is that write path.
        served = ${JSON.stringify(accountEnvelope('acc-a', catalogB(), 5))};
        await loadActiveProfile();
        const asked = fetches;
        const next = await read();
        return {
          readFetches: fetches - asked,
          version: next?.version,
          roles: Object.keys(next?.catalog.roles ?? {}),
        };
      });
      await step('sources', async () => recorder.emitted
        .filter((line) => line.event === 'profile.authority_read')
        .map((line) => line.fields.source));
    `);

    expect(v.parse(
      v.object({ fetches: v.number(), versions: v.array(v.number()) }),
      expectOk(steps.firstThenRepeat),
    )).toEqual({ fetches: 3, versions: [4, 4, 4] });
    expect(v.parse(
      v.object({ readFetches: v.number(), version: v.number(), roles: v.array(v.string()) }),
      expectOk(steps.afterCacheWrite),
    )).toEqual({ readFetches: 1, version: 5, roles: ['auditor'] });
    expect(expectOk(steps.sources)).toEqual(['server', 'server', 'server', 'server']);
  });

  test('another account\u2019s cache never answers for this one', () => {
    const steps = runScenario(`
      ${cached('acc-a', catalogA(), 9)}
      ${signedIn('acc-b', DEAD_ORIGIN)}
      ${RECORD_DIAGNOSTICS}
      await step('resolved', async () => {
        const { createProfileAuthorityReader } = await import('./packages/cli/src/profiles.ts');
        return await createProfileAuthorityReader()();
      });
      await step('leaked', async () => {
        const { loadCachedAccountProfile } = await import('./packages/cli/src/profiles.ts');
        return {
          holdsA: loadCachedAccountProfile('acc-a') !== null,
          holdsB: loadCachedAccountProfile('acc-b') !== null,
          reported: recorder.emitted.length,
        };
      });
    `);

    // A cache is keyed to its account: an unrelated entry is a miss, not a fallback.
    expectError(steps.resolved, 'Unable to connect');
    expect(v.parse(
      v.object({ holdsA: v.boolean(), holdsB: v.boolean(), reported: v.number() }),
      expectOk(steps.leaked),
    )).toEqual({ holdsA: true, holdsB: false, reported: 0 });
  });

  test('no cache for this account rethrows rather than inventing a catalog', () => {
    const steps = runScenario(`
      ${signedIn('acc-a', DEAD_ORIGIN)}
      ${RECORD_DIAGNOSTICS}
      await step('resolved', async () => {
        const { createProfileAuthorityReader } = await import('./packages/cli/src/profiles.ts');
        return await createProfileAuthorityReader()();
      });
      await step('reported', async () => recorder.emitted.length);
    `);

    expectError(steps.resolved, 'Unable to connect');
    expect(expectOk(steps.reported)).toBe(0);
  });

  const ParsedDefaultTier = v.object({
    version: v.number(),
    catalog: v.object({
      tiers: v.object({
        default: v.looseObject({ model: v.string(), reasoningEffort: v.optional(v.string()) }),
      }),
    }),
  });

  // A reader built before the edit must still see it.
  test('signed out, a reader built over an existing authority still sees a later /model and /effort', () => {
    const steps = runScenario(`
      const { createProfileAuthorityReader, updateDefaultTier } =
        await import('./packages/cli/src/profiles.ts');
      await updateDefaultTier({ model: 'model-at-startup' });
      // Built ONCE, AFTER an authority exists — the way a live session builds
      // it at construction.
      const read = createProfileAuthorityReader();
      await step('atStartup', async () => await read());
      await step('afterModel', async () => {
        await updateDefaultTier({ model: 'model-chosen-later' });
        return await read();
      });
      await step('afterEffort', async () => {
        await updateDefaultTier({ reasoningEffort: 'high' });
        return await read();
      });
    `);

    const startup = v.parse(ParsedDefaultTier, expectOk(steps.atStartup));
    expect(startup.catalog.tiers.default.model).toBe('model-at-startup');
    const afterModel = v.parse(ParsedDefaultTier, expectOk(steps.afterModel));
    expect(afterModel.catalog.tiers.default.model).toBe('model-chosen-later');
    expect(afterModel.version).toBeGreaterThan(startup.version);
    const afterEffort = v.parse(ParsedDefaultTier, expectOk(steps.afterEffort));
    expect(afterEffort.catalog.tiers.default.reasoningEffort).toBe('high');
    expect(afterEffort.catalog.tiers.default.model).toBe('model-chosen-later');
  });

  test('signed out with no authority yet, the first /model becomes the next turn\u2019s tier', () => {
    const steps = runScenario(`
      const { createProfileAuthorityReader, updateDefaultTier } =
        await import('./packages/cli/src/profiles.ts');
      const read = createProfileAuthorityReader();
      await step('beforeAnyAuthority', async () => await read());
      await step('afterModel', async () => {
        await updateDefaultTier({ model: 'first-model' });
        return await read();
      });
    `);

    expect(expectOk(steps.beforeAnyAuthority)).toBeNull();
    expect(v.parse(ParsedDefaultTier, expectOk(steps.afterModel)).catalog.tiers.default.model)
      .toBe('first-model');
  });
});

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

  test('a server answer keyed to another account is refused, never cached', () => {
    const steps = runScenario(`
      ${signedIn('acc-b', 'https://kinu.test')}
      const served = ${JSON.stringify(accountEnvelope('acc-a', catalogA()))};
      globalThis.fetch = async (input) => {
        if (!String(input).endsWith('/api/cli/profile')) throw new Error(String(input));
        return Response.json(served);
      };
      await step('misKeyed', async () => {
        const { loadActiveProfile } = await import('./packages/cli/src/profiles.ts');
        await loadActiveProfile();
        return 'written';
      });
      await step('cacheFile', async () => {
        const { existsSync } = await import('node:fs');
        return existsSync(process.env.KINU_HOME + '/profile-cache.json');
      });
    `);

    expectError(steps.misKeyed, 'mismatching authority');
    expect(expectOk(steps.cacheFile)).toBe(false);
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

const SERVED_ENVELOPE = accountEnvelope('srv-account', catalogA(), 7);

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
      // A non-JSON body becomes the message: the server's words outrank the status line.
      await expect(updateCloudProfile(htmlError.origin, 't', { catalog: catalogA(), expectedVersion: 1 }))
        .rejects.toThrow('bad gateway');
    } finally {
      htmlError.stop();
    }
  });
});

/** Whichever store is canonical for the session receives the `kinu model` / `kinu effort` write. */
describe('control commands route model/effort by session state', () => {
  /** An existing database and no configured ref: enough for `resolveAgentTarget` to answer local. */
  const SEED_LOCAL_AGENT = `
    {
      process.env.OPENAI_API_KEY = 'profile-scenario-credential';
      const realFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.href === 'https://models.dev/api.json') {
          return Promise.resolve(Response.json({
            openai: { models: { 'gpt-4o-mini': { id: 'gpt-4o-mini', tool_call: true } } },
            'account-gateway': {
              npm: '@ai-sdk/openai-compatible', api: 'https://account-gateway.test/v1',
              models: { 'custom-model': { id: 'custom-model', tool_call: true } },
            },
          }));
        }
        return realFetch(input, init);
      };
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(process.env.KINU_HOME + '/probe-agent', { recursive: true });
      writeFileSync(process.env.KINU_HOME + '/probe-agent/agent.db', '');
    }
  `;

  /** Command output is muted so a scenario's stdout is one JSON document. */
  const QUIET = `
    async function quiet(fn) {
      const log = console.log;
      console.log = () => {};
      try { return await fn(); } finally { console.log = log; }
    }
  `;

  const ParsedControlTier = v.object({
    version: v.number(),
    catalog: v.object({
      tiers: v.object({
        default: v.looseObject({ model: v.string(), reasoningEffort: v.optional(v.string()) }),
      }),
    }),
  });

  test('signed out, kinu model and kinu effort land in the local authority and the next turn reads them', async () => {
    const steps = runScenario(`
      ${SEED_LOCAL_AGENT}
      ${QUIET}
      await step('model', async () => {
        const { modelCommand } = await import('./packages/cli/src/commands/control.ts');
        await quiet(() => modelCommand('probe-agent', 'openai/gpt-4o-mini', {}));
        return 'set';
      });
      await step('effort', async () => {
        const { effortCommand } = await import('./packages/cli/src/commands/control.ts');
        await quiet(() => effortCommand('probe-agent', 'high'));
        return 'set';
      });
      await step('nextTurn', async () => {
        const { createProfileAuthorityReader } = await import('./packages/cli/src/profiles.ts');
        return await createProfileAuthorityReader()();
      });
      await step('localSlot', async () => {
        const { loadConfigFile } = await import('./packages/cli/src/config.ts');
        return loadConfigFile().localProfile?.catalog.tiers.default ?? null;
      });
    `);

    expect(expectOk(steps.model)).toBe('set');
    expect(expectOk(steps.effort)).toBe('set');
    const tier = v.parse(ParsedControlTier, expectOk(steps.nextTurn)).catalog.tiers.default;
    expect(tier.model).toBe('openai/gpt-4o-mini');
    expect(tier.reasoningEffort).toBe('high');
    expect(expectOk(steps.localSlot)).toEqual({ model: 'openai/gpt-4o-mini', reasoningEffort: 'high' });
  });

  test('signed in, kinu model goes to the account store, never into config.json; the next turn revalidates it', async () => {
    const steps = runScenario(`
      ${SEED_LOCAL_AGENT}
      ${QUIET}
      let accountServer = null;
      {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        const { profileCatalogDigest, BUILTIN_PROFILE_CATALOG } = await import('@kinu.run/core');
        let version = 3;
        let current = {
          roles: BUILTIN_PROFILE_CATALOG.roles,
          tiers: { default: { model: 'server-model-v3' } },
        };
        const envelope = (catalog) => ({
          authority: { kind: 'account', accountId: 'acc-a' },
          version, digest: profileCatalogDigest(catalog), catalog,
        });
        // A stand-in account server: GET answers the current catalog, PUT
        // applies the whole-catalog edit and bumps the version.
        accountServer = Bun.serve({ port: 0, fetch: async (req) => {
          if (new URL(req.url).pathname === '/api/user/ai/proxy/credentials') {
            return Response.json({ credentials: [{ key: 'account-gateway.bearer' }] });
          }
          if (new URL(req.url).pathname === '/api/cli/models') {
            return Response.json({
              models: [{ provider: 'account-gateway', spec: 'account-gateway/custom-model', label: 'Account model' }],
              failures: [],
            });
          }
          if (req.method === 'PUT') {
            const body = await req.json();
            if (body.expectedVersion !== version) {
              return Response.json({ error: 'profile catalog changed underneath you', currentVersion: version, currentDigest: profileCatalogDigest(current) }, { status: 409 });
            }
            current = body.catalog;
            version += 1;
            return Response.json(envelope(current));
          }
          return Response.json(envelope(current));
        }});
        mkdirSync(process.env.KINU_HOME, { recursive: true });
        writeFileSync(process.env.KINU_HOME + '/config.json', JSON.stringify({
          origin: 'http://127.0.0.1:' + accountServer.port,
          accessToken: 'ptc_session',
          tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
          user: { id: 'acc-a', email: 'a@example.com' },
        }), { mode: 0o600 });
      }
      await step('model', async () => {
        // The CAS write itself proves the account round trip: it only lands
        // when the server answered a GET first (expectedVersion) and accepted
        // the PUT after.
        const { modelCommand } = await import('./packages/cli/src/commands/control.ts');
        await quiet(() => modelCommand('probe-agent', 'account-gateway/custom-model', {}));
        return 'set';
      });
      await step('nextTurn', async () => {
        const { createProfileAuthorityReader } = await import('./packages/cli/src/profiles.ts');
        return await createProfileAuthorityReader()();
      });
      await step('localSlot', async () => {
        const { loadConfigFile } = await import('./packages/cli/src/config.ts');
        return loadConfigFile().localProfile ?? null;
      });
      await step('cacheSlot', async () => {
        const { loadCachedAccountProfile } = await import('./packages/cli/src/profiles.ts');
        return loadCachedAccountProfile('acc-a')?.catalog.tiers.default ?? null;
      });
      await step('done', async () => {
        accountServer.stop(true);
        return 'stopped';
      });
    `);

    expect(expectOk(steps.model)).toBe('set');
    const tier = v.parse(ParsedControlTier, expectOk(steps.nextTurn)).catalog.tiers.default;
    expect(tier.model).toBe('account-gateway/custom-model');
    expect(expectOk(steps.localSlot)).toBeNull();
    expect(expectOk(steps.cacheSlot)).toMatchObject({ model: 'account-gateway/custom-model' });
  });
});

