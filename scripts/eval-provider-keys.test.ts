import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateCredential, validateCredentialKey } from '@kinu.run/core';
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
const store = new Map<string, unknown>();

const posts: { key: string; identity: string | null }[] = [];

let refuseStores = false;

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
    '/api/user/models': () => Response.json({
      models: [{ spec: MODEL, provider: 'opencode-go' }].filter((model) => store.has(catalogCredKey(model.provider))),
      failures: [],
    }),
  },
});

afterAll(() => deployment.stop(true));

beforeEach(() => {
  store.clear();
  posts.length = 0;
  refuseStores = false;
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
      store.clear();
      refuseStores = refused;

      const run = Bun.spawn([process.execPath, join(import.meta.dir, 'eval-provider-keys.ts'), origin], {
        env: childEnv({ HOME: homeWithKeys({ 'opencode-go.bearer': KEY }), KINU_EVAL_WEB_IDENTITY: IDENTITY, KINU_EVAL_MODELS: MODEL }),
        stdout: 'pipe', stderr: 'pipe',
      });

      const [status, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);

      expect(status).toBe(refused ? 1 : 0);
      expect(`${stdout}${stderr}`).toContain(refused ? 'storing opencode-go.bearer for eval-service answered 500' : `lists every eval model: ${MODEL}`);
      expect(`${stdout}${stderr}`).not.toContain(KEY);
    }
  });
});
