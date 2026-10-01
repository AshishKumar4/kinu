import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv, scratchDir } from '@kinu.run/test-utils';
import { provisionEvalProviderKeys } from './eval-provider-keys';

const KEY = 'sk-eval-provider-key-never-printed';

const IDENTITY = 'the-deployment-dev-identity-secret';

const MODEL = 'opencode-go/an-eval-model';

/** A deployment's two routes as eval-service meets them: a stored bearer makes its provider's model listed. */
const stored: { credential: string; identity: string | null; body: unknown }[] = [];

let refuseStores = false;

const deployment = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  routes: {
    '/api/user/credentials/:credential': {
      POST: async (request) => {
        if (refuseStores) return Response.json({ error: 'refused' }, { status: 500 });
        stored.push({ credential: request.params.credential, identity: request.headers.get('x-kinu-dev-identity-secret'), body: await request.json() });

        return Response.json({ ok: true });
      },
    },
    '/api/user/models': () => Response.json({
      models: stored.some(({ credential }) => credential === 'opencode-go') ? [{ spec: MODEL, label: 'eval' }] : [],
    }),
  },
});

afterAll(() => deployment.stop(true));

const origin = `http://127.0.0.1:${String(deployment.port)}`;

/** A home holding the operator's key file, as ~/.config/kinu/eval-provider-keys.json. */
function homeWithKeys(keys: Record<string, string> | undefined): string {
  const home = scratchDir('eval-provider-keys');

  mkdirSync(join(home, '.config', 'kinu'), { recursive: true });

  if (keys !== undefined) writeFileSync(join(home, '.config', 'kinu', 'eval-provider-keys.json'), JSON.stringify(keys), { mode: 0o600 });

  return home;
}

describe('eval-service provider keys after a reset', () => {
  test('each key is stored as eval-service through the product route, and the eval models must then be listed', async () => {
    stored.length = 0;
    refuseStores = false;
    const home = homeWithKeys({ 'opencode-go.bearer': KEY });
    const input = { origin, keysPath: join(home, '.config', 'kinu', 'eval-provider-keys.json'), identity: IDENTITY, identityEnv: 'KINU_EVAL_WEB_IDENTITY' };

    expect(await provisionEvalProviderKeys({ ...input, models: [MODEL] })).toEqual([]);
    expect(stored).toEqual([{ credential: 'opencode-go', identity: IDENTITY, body: { kind: 'bearer', token: KEY } }]);
    expect(await provisionEvalProviderKeys({ ...input, models: [MODEL, 'openrouter/another'] })).toEqual([
      `eval-service at ${origin} lists no openrouter/another, so the eval pass cannot run it`,
    ]);
  });

  test('a missing key file or identity is a finding, not a crash', async () => {
    stored.length = 0;
    const keysPath = join(homeWithKeys(undefined), '.config', 'kinu', 'eval-provider-keys.json');

    expect(await provisionEvalProviderKeys({ origin, keysPath, identity: IDENTITY, identityEnv: 'KINU_EVAL_WEB_IDENTITY', models: [MODEL] })).toEqual([
      `${keysPath} does not exist, so eval-service holds no provider key at ${origin}`,
      `eval-service at ${origin} lists no ${MODEL}, so the eval pass cannot run it`,
    ]);
    expect(await provisionEvalProviderKeys({ origin, keysPath, identity: undefined, identityEnv: 'KINU_EVAL_WEB_IDENTITY', models: [MODEL] })).toEqual([
      `KINU_EVAL_WEB_IDENTITY is not set, so nothing can act as eval-service at ${origin}`,
    ]);
  });

  // The deploy prints this step's output into its log and its report: a key there is a key leaked.
  test('the command prints no key, whether its stores succeed or are refused', async () => {
    for (const refused of [false, true]) {
      stored.length = 0;
      refuseStores = refused;

      const run = Bun.spawn([process.execPath, join(import.meta.dir, 'eval-provider-keys.ts'), origin], {
        env: childEnv({ HOME: homeWithKeys({ 'opencode-go.bearer': KEY }), KINU_EVAL_WEB_IDENTITY: IDENTITY, KINU_EVAL_MODELS: MODEL }),
        stdout: 'pipe', stderr: 'pipe',
      });

      const [status, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);

      expect(status).toBe(refused ? 1 : 0);
      expect(`${stdout}${stderr}`).toContain(refused ? 'storing opencode-go for eval-service answered 500' : `lists every eval model: ${MODEL}`);
      expect(`${stdout}${stderr}`).not.toContain(KEY);
    }
  });
});
