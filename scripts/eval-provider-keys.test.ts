import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { BUILTIN_PROFILE_CATALOG, DEFAULT_WORKERS_AI_MODEL_SPEC, JsonValueSchema, profileCatalogDigest, validateCredential, validateCredentialKey,
  validateProfileCatalog, type JsonValue, type ProfileCatalogEnvelope } from '@kinu.run/core';
import { childEnv, scratchDir } from '@kinu.run/test-utils';
import { catalogCredKey } from '../packages/core/src/providers/catalog';
import { provisionEvalProviderKeys } from './eval-provider-keys';

const KEY = 'sk-eval-provider-key-never-printed';

const IDENTITY = 'the-deployment-dev-identity-secret';

const MODEL = 'opencode-go/muse-spark-1.3-contributor';

/**
 * A deployment's two routes as eval-service meets them, held to the product's own contract rather than to this
 * script's: the credential route validates what it is given as the product's store does (`setCredential`:
 * `validateCredentialKey`, then `validateCredential`), and a provider's models are listed only once the key that
 * provider reads (`catalogCredKey`) is stored.
 */
const store = new Map<string, ReturnType<typeof validateCredential>>();

const posts: { key: string; identity: string | null }[] = [];

let refuseStores = false;

let catalogueDown = false;

const deployment = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  routes: {
    '/api/user/credentials/:key': {
      POST: async (request) => {
        const key = decodeURIComponent(request.params.key);

        posts.push({ key, identity: request.headers.get('x-kinu-dev-identity-secret') });

        if (refuseStores) return Response.json({ error: 'refused' }, { status: 500 });

        try {
          validateCredentialKey(key);
          store.set(key, validateCredential({ key, value: await request.json() }));
        } catch (cause) {
          return Response.json({ error: cause instanceof Error ? cause.message : String(cause) }, { status: 400 });
        }

        return Response.json({ ok: true });
      },
    },
    '/api/user/credentials': () => Response.json([...store.keys()].map((key) => ({ key, kind: 'bearer' }))),
    // A provider whose catalogue probe fails is absent with a failure beside it, its key still stored (registry.ts).
    '/api/user/models': () => Response.json({
      models: [{ spec: MODEL, provider: 'opencode-go' }]
        .filter((model) => !catalogueDown && store.has(catalogCredKey(model.provider))),
      failures: catalogueDown ? [{ provider: 'opencode-go', error: 'catalogue probe failed' }] : [],
    }),
  },
});

afterAll(() => deployment.stop(true));

beforeEach(() => {
  store.clear();
  posts.length = 0;
  refuseStores = false;
  catalogueDown = false;
});

const origin = `http://127.0.0.1:${String(deployment.port)}`;

/** A home holding the operator's key file, as ~/.config/kinu/eval-provider-keys.json. */
function homeWithKeys(keys: Record<string, string> | undefined): string {
  const home = scratchDir('eval-provider-keys');

  mkdirSync(join(home, '.config', 'kinu'), { recursive: true });

  if (keys !== undefined) writeFileSync(join(home, '.config', 'kinu', 'eval-provider-keys.json'), JSON.stringify(keys), { mode: 0o600 });

  return home;
}

const keysPathOf = (home: string): string => join(home, '.config', 'kinu', 'eval-provider-keys.json');

describe('eval-service provider keys on every deployment it drives', () => {
  // 2026-10-01: the key went to the route as `opencode-go`, which the route accepts and no provider reads, so a
  // fresh eval account listed no model.
  test('a key is stored under the name its provider reads, as eval-service, and its models are then listed', async () => {
    const input = { origin, keysPath: keysPathOf(homeWithKeys({ 'opencode-go.bearer': KEY })), identity: IDENTITY, identityEnv: 'KINU_EVAL_WEB_IDENTITY', models: [MODEL] };

    expect(await provisionEvalProviderKeys(input)).toEqual({ stored: ['opencode-go.bearer'], findings: [] });
    expect(posts).toEqual([{ key: 'opencode-go.bearer', identity: IDENTITY }]);
    expect(store.get('opencode-go.bearer')).toEqual({ kind: 'bearer', token: KEY });

    // Every deploy runs it: a key whose provider is already listed is not stored again.
    expect(await provisionEvalProviderKeys(input)).toEqual({ stored: [], findings: [] });
    expect(posts).toHaveLength(1);
  });

  // Review 2026-10-01: a stored key whose provider's catalogue probe failed was absent from the model list, and the
  // next deploy replaced it with whatever the operator's file held.
  test('a held key is never replaced, even while its provider lists no models', async () => {
    store.set('opencode-go.bearer', { kind: 'bearer', token: 'the-working-key' });
    catalogueDown = true;
    const input = { origin, keysPath: keysPathOf(homeWithKeys({ 'opencode-go.bearer': KEY })), identity: IDENTITY, identityEnv: 'KINU_EVAL_WEB_IDENTITY', models: [MODEL] };

    expect((await provisionEvalProviderKeys(input)).stored).toEqual([]);
    expect(posts).toEqual([]);
    expect(store.get('opencode-go.bearer')).toEqual({ kind: 'bearer', token: 'the-working-key' });
  });

  test('an eval model no stored key unlocks, a missing key file and a missing identity are findings, not crashes', async () => {
    const keysPath = keysPathOf(homeWithKeys(undefined));
    const input = { origin, keysPath, identity: IDENTITY, identityEnv: 'KINU_EVAL_WEB_IDENTITY', models: [MODEL] };

    expect(await provisionEvalProviderKeys(input)).toEqual({ stored: [], findings: [
      `${keysPath} does not exist`,
      `eval-service at ${origin} lists no ${MODEL}, so the eval pass cannot run it`,
    ] });
    expect((await provisionEvalProviderKeys({ ...input, identity: undefined })).findings).toEqual([
      `KINU_EVAL_WEB_IDENTITY is not set, so nothing can act as eval-service at ${origin}`,
    ]);
    expect(posts).toEqual([]);
  });

  // The deploy prints this step's output into its log and its report: a key there is a key leaked.
  test('the command prints no key, whether its stores succeed or are refused', async () => {
    for (const refused of [false, true]) {
      const { server, accounts, at } = accountsDeployment();

      const run = Bun.spawn([process.execPath, join(import.meta.dir, 'eval-provider-keys.ts'), refused ? origin : at, '--accounts=3-5'], {
        env: childEnv({ HOME: homeWithKeys({ 'opencode-go.bearer': KEY }), KINU_EVAL_WEB_IDENTITY: IDENTITY, KINU_EVAL_MODELS: MODEL, KINU_EVAL_TRIALS: '1' }),
        stdout: 'pipe', stderr: 'pipe',
      });

      refuseStores = refused;

      try {
        const [status, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
        expect(status).toBe(refused ? 1 : 0);
        expect(`${stdout}${stderr}`).not.toContain(KEY);

        if (!refused) {
          // Only the block the run leased, the one its trials act as.
          expect([...accounts.keys()].filter((name) => name !== 'eval-service').sort()).toEqual(['trial-3', 'trial-4', 'trial-5']);
          expect([...accounts.values()].every((account) => account.keys.has('opencode-go.bearer'))).toBe(true);
        }
      } finally {
        await server.stop(true);
      }
    }
  });
});

/**
 * A deployment that keeps each eval account apart, by the account header: its keys, its rows a trial could inherit,
 * its workspaces, and the account delete that empties it.
 */
function accountsDeployment() {
  type Account = {
    keys: Map<string, JsonValue>; inherited: Record<string, number>; workspaces: { name: string; lastVisited: number }[]; catalog: ProfileCatalogEnvelope;
    gateway: string | null;
  };

  const accounts = new Map<string, Account>();
  const resets: string[] = [];

  const of = (request: Request): Account => {
    const name = request.headers.get('x-kinu-dev-identity-account') ?? 'eval-service';
    const catalog = { ...BUILTIN_PROFILE_CATALOG, retries: 3 };

    const account = accounts.get(name) ?? { keys: new Map(), inherited: {}, workspaces: [], gateway: null, catalog: {
      authority: { kind: 'account', accountId: name }, version: 0, digest: profileCatalogDigest(catalog), catalog,
    } };

    accounts.set(name, account);

    return account;
  };

  const server = Bun.serve({ port: 0, hostname: '127.0.0.1',
    routes: {
      '/api/user/credentials/:key': { POST: async (request) => {
        of(request).keys.set(decodeURIComponent(request.params.key), v.parse(JsonValueSchema, await request.json()));

        return Response.json({ ok: true });
      } },
      '/api/user/credentials': (request) => Response.json([...of(request).keys.keys()].map((key) => ({ key, kind: 'bearer' }))),
      '/api/user/profile-catalog': {
        GET: (request) => Response.json(of(request).catalog),
        PUT: async (request) => {
          const body = v.parse(v.object({ expectedVersion: v.number(), catalog: JsonValueSchema }), await request.json());
          const account = of(request);

          if (body.expectedVersion !== account.catalog.version) return Response.json({ error: 'Version conflict' }, { status: 409 });
          const catalog = validateProfileCatalog({ value: body.catalog });
          account.catalog = { ...account.catalog, catalog, version: account.catalog.version + 1, digest: profileCatalogDigest(catalog) };

          return Response.json(account.catalog);
        },
      },
      '/api/user/models': (request) => Response.json({ models: of(request).keys.has('opencode-go.bearer') ? [{ spec: MODEL }] : [], failures: [] }),
      '/api/user/held-rows': (request) => {
        const account = of(request);

        return Response.json({ user_credentials: account.keys.size, ...account.inherited,
          user_config: (account.inherited.user_config ?? 0) + Number(account.catalog.version > 0) + Number(account.gateway !== null) });
      },
      // The selection is a user_config row, read before any Cloudflare call (CredentialsStore.listAIGateways).
      '/api/user/cloudflare/gateways': (request) => Response.json({ connected: of(request).keys.has('cloudflare.oauth'), selectedId: of(request).gateway, gateways: [], error: null }),
      '/api/user/cloudflare/gateway': { PUT: async (request) => {
        of(request).gateway = v.parse(v.object({ id: v.nullable(v.string()) }), await request.json()).id;

        return Response.json({ ok: true });
      } },
      '/api/user/workspaces': (request) => Response.json({ entries: of(request).workspaces, nextCursor: null }),
      '/api/user/profile': (request) => {
        const account = request.headers.get('x-kinu-dev-identity-account');

        return Response.json({ email: `eval-service${account === null ? '' : `+${account}`}@kinu.run` });
      },
      '/api/user/account': { DELETE: async (request) => {
        const account = request.headers.get('x-kinu-dev-identity-account') ?? 'eval-service';
        const { confirm } = v.parse(v.object({ confirm: v.string() }), await request.json());

        if (confirm !== `eval-service+${account}@kinu.run`) return Response.json({ error: 'Type the account email to confirm.' }, { status: 400 });
        resets.push(account);
        accounts.delete(account);

        return Response.json({ deleted: true });
      } },
    },
  });

  return { server, accounts, resets, at: `http://127.0.0.1:${String(server.port)}` };
}

describe('every trial account a run acts as', () => {
  test('each trial account is given the keys it does not hold, as itself, and the first one lists the eval models', async () => {
    const { server, accounts, at } = accountsDeployment();

    try {
      const input = {
        origin: at, keysPath: keysPathOf(homeWithKeys({ 'opencode-go.bearer': KEY })), identity: IDENTITY,
        identityEnv: 'KINU_EVAL_WEB_IDENTITY', models: [MODEL], trialAccounts: ['trial-1', 'trial-2', 'trial-3'] as const,
      };

      expect(await provisionEvalProviderKeys(input)).toEqual({ stored: ['opencode-go.bearer'], findings: [], trials: { given: 3, reset: [] }, notes: [] });
      expect([...accounts.keys()].sort()).toEqual(['eval-service', 'trial-1', 'trial-2', 'trial-3']);
      expect([...accounts.values()].every((account) => account.keys.has('opencode-go.bearer'))).toBe(true);

      for (const name of input.trialAccounts) {
        const configured = accounts.get(name)?.catalog;

        expect(configured?.catalog.tiers.deep?.model).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
        expect(configured?.catalog.modelFallbacks?.[DEFAULT_WORKERS_AI_MODEL_SPEC]).toEqual([MODEL]);
        expect(configured?.catalog.retries).toBe(3);
        expect(configured?.version).toBe(1);
      }

      expect(await provisionEvalProviderKeys(input)).toEqual({ stored: [], findings: [], trials: { given: 0, reset: [] }, notes: [] });
      expect(input.trialAccounts.map((name) => accounts.get(name)?.catalog.version)).toEqual([1, 1, 1]);

      const configured = accounts.get('trial-1');

      if (configured === undefined) throw new Error('the trial account was never reached');
      configured.inherited = { user_config: 1 };
      const cleaned = await provisionEvalProviderKeys(input);

      expect(cleaned.trials?.reset).toEqual(['trial-1']);
      expect(cleaned.findings).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });

  // Staging 2620e7c05, 2026-10-19: a gateway model (my-gateway/anthropic/claude-sonnet-5.5) is listed only for an account
  // holding a Cloudflare login and a selected AI Gateway, and the selection is a user_config row.
  test('a run on a gateway model gives each account the deployment\'s Cloudflare login and gateway, and keeps them', async () => {
    const { server, accounts, resets, at } = accountsDeployment();
    const gateway = { accountId: 'f44999d1ddda7012e9a87729eba250f1', id: 'kinu-ai-gateway-staging', token: 'cf-api-token-never-printed' };

    try {
      const input = {
        origin: at, keysPath: keysPathOf(homeWithKeys({ 'opencode-go.bearer': KEY })), identity: IDENTITY, identityEnv: 'KINU_EVAL_WEB_IDENTITY',
        models: [MODEL, 'my-gateway/anthropic/claude-sonnet-5.5'], trialAccounts: ['trial-1', 'trial-2'] as const, gateway,
      };

      await provisionEvalProviderKeys(input);
      const again = await provisionEvalProviderKeys(input);

      for (const name of ['eval-service', 'trial-1', 'trial-2']) {
        expect(accounts.get(name)?.keys.get('cloudflare.oauth')).toMatchObject({ kind: 'oauth', accessToken: gateway.token, metadata: { accountId: gateway.accountId } });
        expect(accounts.get(name)?.gateway).toBe(gateway.id);
      }

      expect([resets, again.trials?.reset]).toEqual([[], []]);
    } finally {
      await server.stop(true);
    }
  });

  test('a run on no gateway model gives no account a Cloudflare login or a gateway', async () => {
    const { server, accounts, at } = accountsDeployment();

    try {
      await provisionEvalProviderKeys({
        origin: at, keysPath: keysPathOf(homeWithKeys({ 'opencode-go.bearer': KEY })), identity: IDENTITY, identityEnv: 'KINU_EVAL_WEB_IDENTITY',
        models: [MODEL], trialAccounts: ['trial-1'] as const,
        gateway: { accountId: 'f44999d1ddda7012e9a87729eba250f1', id: 'kinu-ai-gateway-staging', token: 'cf-api-token-never-printed' },
      });
      expect([...accounts.values()].map((account) => [account.keys.has('cloudflare.oauth'), account.gateway])).toEqual([[false, null], [false, null]]);
    } finally {
      await server.stop(true);
    }
  });

  // 2026-10-19, the owner's call: Claude Haiku 5.5 and GPT-6 Luna measured on the owner's own plans, through a grant the
  // run alone signed in for. Each is owned by one account, whose renewals single-flight in its own object: the trial
  // account its model's sequence runs in (EvalMatrix.sequence), never eval-service, and given it once.
  test('a run on plan models gives its trial account the run\'s plan grants once; eval-service and a run on none get none', async () => {
    const { server, accounts, at } = accountsDeployment();
    const grant = { kind: 'oauth' as const, accessToken: 'plan-access-never-printed', refreshToken: 'plan-refresh-never-printed', expiresAt: 4102444800000, metadata: {} };
    const planGrants = { 'claude.oauth': grant, 'chatgpt.oauth@compare': grant };
    const base = { origin: at, keysPath: keysPathOf(homeWithKeys({ 'opencode-go.bearer': KEY })), identity: IDENTITY, identityEnv: 'KINU_EVAL_WEB_IDENTITY' };

    try {
      const input = { ...base, models: [MODEL, 'claude/claude-haiku-5-5', 'chatgpt@compare/gpt-6-luna'], trialAccounts: ['trial-1'] as const, planGrants };

      await provisionEvalProviderKeys(input);
      // The account renews its grant: a later provisioning leaves the renewed one, never the run's first.
      accounts.get('trial-1')?.keys.set('claude.oauth', { ...grant, accessToken: 'renewed' });
      await provisionEvalProviderKeys(input);

      expect([accounts.get('trial-1')?.keys.get('claude.oauth'), accounts.get('trial-1')?.keys.get('chatgpt.oauth@compare')])
        .toEqual([{ ...grant, accessToken: 'renewed' }, grant]);
      expect([...accounts.get('eval-service')?.keys.keys() ?? []]).toEqual(['opencode-go.bearer']);

      await provisionEvalProviderKeys({ ...base, models: [MODEL], trialAccounts: ['trial-3'] as const, planGrants });
      expect([...accounts.get('trial-3')?.keys.keys() ?? []]).toEqual(['opencode-go.bearer']);
    } finally {
      await server.stop(true);
    }
  });

  test('a trial account holding a row a trial would inherit is reset and given its keys again, unless a run is on it', async () => {
    const { server, accounts, resets, at } = accountsDeployment();

    try {
      const input = {
        origin: at, keysPath: keysPathOf(homeWithKeys({ 'opencode-go.bearer': KEY })), identity: IDENTITY,
        identityEnv: 'KINU_EVAL_WEB_IDENTITY', models: [MODEL], trialAccounts: ['trial-1', 'trial-2'] as const,
      };

      await provisionEvalProviderKeys(input);

      const [one, two] = [accounts.get('trial-1'), accounts.get('trial-2')];

      if (one === undefined || two === undefined) throw new Error('the trial accounts were never reached');
      one.inherited = { experience_library: 2 };
      two.inherited = { user_mcp_servers: 1 };
      two.workspaces = [{ name: 'eval-order-book-2-live22', lastVisited: Date.now() }];

      const provisioned = await provisionEvalProviderKeys(input);

      expect(resets).toEqual(['trial-1']);
      expect(provisioned.trials).toEqual({ given: 1, reset: ['trial-1'] });
      expect(provisioned.findings).toEqual([]);

      for (const value of [at, 'trial-2', 'user_mcp_servers 1', 'eval-order-book-2-live22']) {
        expect(provisioned.notes?.[0]).toContain(value);
      }

      expect(accounts.get('trial-1')?.keys.has('opencode-go.bearer')).toBe(true);
    } finally {
      await server.stop(true);
    }
  });
});
