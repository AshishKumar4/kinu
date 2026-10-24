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

  return await spawnRunner(home, runner, opts.origin);
}

/** `runner` in a child process, so KINU_HOME is read fresh and the developer's ~/.kinu is untouched. */
async function spawnRunner(home: string, runner: string, origin: string | undefined) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KINU_HOME: home, NO_COLOR: '1',
    OPENROUTER_API_KEY: '', KINU_TOKEN: '',
  };

  if (origin) env.KINU_ORIGIN = origin;
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

/**
 * `kinu provider connect <provider> <account> --cloud` in a child process. Claude's token endpoint answers a token
 * here, and the browser wait is skipped, so the code is the pasted one.
 */
async function runSubscription(home: string, opts: { provider: 'claude' | 'chatgpt'; account: string }) {
  const runner = `
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => String(input instanceof Request ? input.url : input) === 'https://api.anthropic.com/v1/oauth/token'
      ? Response.json({ access_token: 'claude-at', refresh_token: 'claude-rt', expires_in: 3600 })
      : realFetch(input, init);
    const { connectProvider } = await import('./packages/cli/src/commands/provider-connect.ts');
    const port = { report: () => {}, ask: async () => 'the-code', skippable: async () => null };
    const outcome = await connectProvider(${JSON.stringify(opts.provider)}, port, { cloud: true, account: ${JSON.stringify(opts.account)} });
    console.log(JSON.stringify(outcome));
  `;

  return await spawnRunner(home, runner, undefined);
}

describe('a subscription sign-in kept in the Kinu account (--cloud)', () => {
  test('Claude\'s goes to the account under its name, and never lands on this disk', async () => {
    const { received, server, origin } = accountStore();
    const home = kinuHome({ origin, accessToken: 'ptc_test_token' });

    try {
      const res = await runSubscription(home, { provider: 'claude', account: 'work' });

      expect(res.exitCode, res.stdout).toBe(0);
      expect(received).toMatchObject([{ path: '/api/cli/credentials/claude.oauth%40work', method: 'POST', body: { kind: 'oauth', accessToken: 'claude-at', refreshToken: 'claude-rt' } }]);
      expect(JSON.stringify(storedConfig(home))).not.toContain('claude-rt');
    } finally {
      await server.stop(true);
    }
  });

  test('signed out, Claude\'s has no account to go to and says how to get one', async () => {
    const res = await runSubscription(kinuHome({}), { provider: 'claude', account: 'work' });

    expect(res.exitCode, res.stdout).toBe(0);
    expect(res.stdout).toContain('"kind":"blocked"');
    expect(res.stdout).toContain('Run kinu auth');
  });

  test('disconnecting that Claude account removes it from the account, where it was kept', async () => {
    const seen: string[] = [];

    const server = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      fetch(request) {
        seen.push(`${request.method} ${new URL(request.url).pathname}`);

        return request.method === 'GET' ? Response.json([{ key: 'claude.oauth@work', kind: 'oauth' }]) : Response.json({ ok: true });
      },
    });

    const home = kinuHome({ origin: `http://127.0.0.1:${server.port}`, accessToken: 'ptc_test_token' });

    try {
      const res = await spawnRunner(home, `
        const { providersCommand } = await import('./packages/cli/src/commands/providers.ts');
        await providersCommand('disconnect', 'claude', 'work', {});
      `, undefined);

      expect(res.exitCode, res.stdout).toBe(0);
      expect(seen).toContain('DELETE /api/cli/credentials/claude.oauth%40work');
      expect(res.stdout).toContain('Removed the claude work account from your Kinu account');
    } finally {
      await server.stop(true);
    }
  });

  test('ChatGPT\'s belongs to this machine, so it is refused and the web sign-in named', async () => {
    const res = await runSubscription(kinuHome({ origin: 'http://127.0.0.1:1', accessToken: 'ptc_test_token' }), { provider: 'chatgpt', account: 'work' });

    expect(res.exitCode, res.stdout).toBe(0);
    expect(res.stdout).toContain('belongs to this machine');
    expect(res.stdout).toContain('Add another ChatGPT account');
  });
});

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

  // An endpoint the Worker cannot reach keeps its key local: what its egress refuses (core's `refusedHostname`), or plain http.
  test.each([
    'https://[fd00::1]:11434/v1',
    'https://100.64.3.4/v1',
    'http://localhost:11434/v1',
    'https://10.0.0.8/v1',
    'https://[::ffff:10.0.0.8]/v1',
    'https://models.internal/v1',
    'https://ollama.localhost/v1',
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
        body: { kind: 'openai-compat', baseURL: 'https://llm.example.com/v1', apiKey: 'sk-or-secret', contextWindow: 131_072 } }]);
      expect(JSON.stringify(storedConfig(account))).not.toContain('sk-or-secret');
      expect(storedConfig(local).providers).toMatchObject({ openaiCompat: { default: { baseURL: 'http://localhost:11434/v1', apiKey: 'sk-or-secret', contextWindow: 131_072 } } });
    } finally {
      await server.stop(true);
    }
  });

  test.each([
    'https://[2606:4700:4700::1111]/v1',
    'https://localhost-models.example.com/v1',
  ])('a public https endpoint lets the account hold the key: %s', async (endpoint) => {
    const { received, server, origin } = accountStore();
    const home = kinuHome({ origin, accessToken: 'ptc_test_token' });

    try {
      const res = await runStore(home, { local: false, endpoint });
      expect(res.exitCode, res.stdout).toBe(0);
      expect(received).toEqual([{ path: '/api/cli/credentials/openai-compat.default', method: 'POST', auth: 'Bearer ptc_test_token',
        body: { kind: 'openai-compat', baseURL: endpoint, apiKey: 'sk-or-secret' } }]);
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
