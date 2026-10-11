// `kinu provider connect` writes secrets to the owner's Kinu account by default, not this disk.
import { scratchDir } from '../../test-utils/src/scratch';
import { readFileSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { parseJsonObject, type JsonObject } from '@kinu.run/core';
import * as v from 'valibot';

function kinuHome(config: JsonObject): string {
  const home = scratchDir('secret-home');
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));

  return home;
}

const DefaultTierSchema = v.object({
  localProfile: v.object({ catalog: v.object({ tiers: v.object({ default: v.object({ model: v.string() }) }) }) }),
});

function storedConfig(home: string): JsonObject {
  return parseJsonObject(readFileSync(join(home, 'config.json'), 'utf8'));
}

/** Child process, so KINU_HOME is read fresh and the developer's ~/.kinu is untouched. */
async function runStore(home: string, opts: { local: boolean; origin?: string; endpoint?: string; contextWindow?: string }) {
  const provider = opts.endpoint === undefined ? 'openrouter' : 'openai-compatible';

  // An endpoint's model is named up front: these endpoints are unreachable on purpose, so nothing may probe them.
  const answers = opts.endpoint === undefined
    ? ['sk-or-secret', 'anthropic/claude-x']
    : [opts.endpoint, 'sk-or-secret', opts.contextWindow ?? ''];

  const model = opts.endpoint === undefined ? {} : { model: 'gpt-oss:20b' };

  const runner = `
    const { connectProvider } = await import('./packages/cli/src/commands/provider-connect.ts');
    const answers = ${JSON.stringify(answers)};
    const port = { report: () => {}, ask: async () => answers.shift() ?? '' };
    await connectProvider(${JSON.stringify(provider)}, port, { ...${JSON.stringify(model)}, local: ${opts.local} });
  `;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KINU_HOME: home, NO_COLOR: '1',
    OPENROUTER_API_KEY: '', KINU_TOKEN: '',
  };

  if (opts.origin) env.KINU_ORIGIN = opts.origin;
  else delete env.KINU_ORIGIN;

  const proc = Bun.spawn({
    cmd: [process.execPath, '-e', runner],
    cwd: join(import.meta.dir, '../../..'),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout: stdout + stderr, exitCode };
}

function accountStore(status = 201) {
  const received: Array<{ path: string; method: string; auth: string | null; body: JsonObject }> = [];

  const server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(request) {
      received.push({ path: new URL(request.url).pathname, method: request.method, auth: request.headers.get('authorization'), body: parseJsonObject(await request.text()) });

      return Response.json(status === 201 ? { ok: true } : { error: 'credential rejected' }, { status });
    },
  });

  return { received, server, origin: `http://127.0.0.1:${server.port}` };
}

describe('where a provider secret is written', () => {
  test('signed in, it goes to the account and never lands on this disk', async () => {
    const { received, server, origin } = accountStore();
    const home = kinuHome({ origin, accessToken: 'ptc_test_token' });

    try {
      const res = await runStore(home, { local: false });
      expect(res.exitCode, res.stdout).toBe(0);
      expect(received).toEqual([{ path: '/api/cli/credentials/openrouter.bearer', method: 'POST', auth: 'Bearer ptc_test_token', body: { kind: 'bearer', token: 'sk-or-secret' } }]);

      const config = storedConfig(home);
      expect(JSON.stringify(config)).not.toContain('sk-or-secret');
      // The first connect on a machine names its default.
      expect(v.parse(DefaultTierSchema, config).localProfile.catalog.tiers.default.model).toBe('openrouter/anthropic/claude-x');
    } finally {
      await server.stop(true);
    }
  });

  test('--local keeps it on this machine, for offline use', async () => {
    const home = kinuHome({ origin: 'http://127.0.0.1:1', accessToken: 'ptc_test_token' });
    const res = await runStore(home, { local: true });
    expect(res.exitCode, res.stdout).toBe(0);
    expect(storedConfig(home).providers).toMatchObject({ openrouter: { apiKey: 'sk-or-secret' } });
  });

  test('signed out, there is nowhere else to put it — the machine keeps working', async () => {
    const home = kinuHome({});
    const res = await runStore(home, { local: false });
    expect(res.exitCode, res.stdout).toBe(0);
    expect(storedConfig(home).providers).toMatchObject({ openrouter: { apiKey: 'sk-or-secret' } });
  });

  // An endpoint the Worker cannot reach (including fc00::/7 and 100.64.0.0/10) keeps its key local.
  test.each([
    'https://[fd00::1]:11434/v1',
    'https://100.64.3.4/v1',
    'http://localhost:11434/v1',
    'https://10.0.0.8/v1',
  ])('an endpoint the proxy cannot reach keeps the key on this machine: %s', async (endpoint) => {
    const home = kinuHome({ origin: 'http://127.0.0.1:1', accessToken: 'ptc_test_token' });
    const res = await runStore(home, { local: false, endpoint });
    expect(res.exitCode, res.stdout).toBe(0);
    expect(storedConfig(home).providers).toMatchObject({ openaiCompat: { default: { baseURL: endpoint, apiKey: 'sk-or-secret' } } });
  });

  // The window the owner declares travels with the endpoint, to the account or this disk alike.
  test('a declared context window is stored with the endpoint, on the account and on this disk', async () => {
    const { received, server, origin } = accountStore();
    const account = kinuHome({ origin, accessToken: 'ptc_test_token' });
    const local = kinuHome({});

    try {
      expect((await runStore(account, { local: false, endpoint: 'https://llm.example.com/v1', contextWindow: '131,072' })).exitCode).toBe(0);
      expect((await runStore(local, { local: true, endpoint: 'http://localhost:11434/v1', contextWindow: '131072' })).exitCode).toBe(0);
      expect(received).toEqual([{ path: '/api/cli/credentials/openai-compat.default', method: 'POST', auth: 'Bearer ptc_test_token',
        body: { baseURL: 'https://llm.example.com/v1', apiKey: 'sk-or-secret', contextWindow: 131_072 } }]);
      expect(JSON.stringify(storedConfig(account))).not.toContain('sk-or-secret');
      expect(storedConfig(local).providers).toMatchObject({ openaiCompat: { default: { baseURL: 'http://localhost:11434/v1', apiKey: 'sk-or-secret', contextWindow: 131_072 } } });
    } finally {
      await server.stop(true);
    }
  });

  test('a public https endpoint lets the account hold the key', async () => {
    const { received, server, origin } = accountStore();
    const home = kinuHome({ origin, accessToken: 'ptc_test_token' });

    try {
      const res = await runStore(home, { local: false, endpoint: 'https://[2606:4700:4700::1111]/v1' });
      expect(res.exitCode, res.stdout).toBe(0);
      expect(received).toEqual([{ path: '/api/cli/credentials/openai-compat.default', method: 'POST', auth: 'Bearer ptc_test_token',
        body: { baseURL: 'https://[2606:4700:4700::1111]/v1', apiKey: 'sk-or-secret' } }]);
      expect(JSON.stringify(storedConfig(home))).not.toContain('sk-or-secret');
    } finally {
      await server.stop(true);
    }
  });
});

describe('when the account will not take it', () => {
  test('an account refusal does not save the key or adopt a default on disk', async () => {
    const { received, server, origin } = accountStore(400);
    const home = kinuHome({ origin, accessToken: 'ptc_test_token' });
    const before = storedConfig(home);

    try {
      const res = await runStore(home, { local: false });
      expect(res.exitCode).not.toBe(0);
      expect(received).toHaveLength(1);
      expect(storedConfig(home)).toEqual(before);
    } finally {
      await server.stop(true);
    }
  });

  test('a key already on this disk is removed once the account has it', async () => {
    const { received, server, origin } = accountStore();

    const home = kinuHome({
      origin,
      accessToken: 'ptc_test_token',
      providers: { openrouter: { apiKey: 'sk-stale-local' } },
    });

    try {
      expect((await runStore(home, { local: false })).exitCode).toBe(0);
      expect(received).toEqual([{ path: '/api/cli/credentials/openrouter.bearer', method: 'POST', auth: 'Bearer ptc_test_token', body: { kind: 'bearer', token: 'sk-or-secret' } }]);
      // A local key wins at resolution time, so a stale one left behind would be the one spent.
      expect(JSON.stringify(storedConfig(home))).not.toContain('sk-stale-local');
    } finally {
      await server.stop(true);
    }
  });
});
