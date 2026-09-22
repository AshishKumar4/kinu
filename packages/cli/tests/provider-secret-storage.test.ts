// `kinu provider connect` writes secrets to the owner's Kinu account by default, not this disk.
import { scratchDir } from '../../test-utils/src/scratch';
import { readFileSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { parseJsonObject, type JsonObject } from '@kinu.run/core';

function kinuHome(config: JsonObject): string {
  const home = scratchDir('secret-home');
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));

  return home;
}

function storedConfig(home: string): JsonObject {
  return parseJsonObject(readFileSync(join(home, 'config.json'), 'utf8'));
}

/** Child process, so KINU_HOME is read fresh and the developer's ~/.kinu is untouched. */
async function runStore(home: string, opts: { local: boolean; origin?: string; endpoint?: string }) {
  const provider = opts.endpoint === undefined ? 'openrouter' : 'openai-compatible';

  const answers = opts.endpoint === undefined
    ? ['sk-or-secret', 'anthropic/claude-x']
    : [opts.endpoint, 'sk-or-secret', 'gpt-oss:20b'];

  const runner = `
    const { connectProvider } = await import('./packages/cli/src/commands/provider-connect.ts');
    const answers = ${JSON.stringify(answers)};
    const port = { report: () => {}, ask: async () => answers.shift() ?? '' };
    try {
      const outcome = await connectProvider(${JSON.stringify(provider)}, port, { local: ${opts.local} });
      console.log('WHERE:' + (outcome.summary.includes('your Kinu account') ? 'account' : 'local'));
    } catch (e) {
      console.log('THREW:' + e.message);
    }
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

describe('where a provider secret is written', () => {
  test('signed in, it goes to the account and never lands on this disk', async () => {
    const received: Array<{ path: string; auth: string | null; body: string }> = [];

    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const url = new URL(request.url);
        received.push({ path: url.pathname, auth: request.headers.get('authorization'), body: await request.text() });

        return Response.json({ ok: true }, { status: 201 });
      },
    });

    const origin = `http://127.0.0.1:${server.port}`;
    const home = kinuHome({ origin, accessToken: 'ptc_test_token' });

    try {
      const res = await runStore(home, { local: false });
      expect(res.stdout).toContain('WHERE:account');
      expect(received).toHaveLength(1);
      expect(received[0]?.path).toBe('/api/cli/credentials/openrouter.bearer');
      expect(received[0]?.auth).toBe('Bearer ptc_test_token');
      expect(received[0]?.body).toContain('sk-or-secret');

      const config = storedConfig(home);
      expect(JSON.stringify(config)).not.toContain('sk-or-secret');
      expect(config.model).toBe('openrouter/anthropic/claude-x');
    } finally {
      await server.stop(true);
    }
  });

  test('--local keeps it on this machine, for offline use', async () => {
    const home = kinuHome({ origin: 'http://127.0.0.1:1', accessToken: 'ptc_test_token' });
    const res = await runStore(home, { local: true });

    expect(res.stdout).toContain('WHERE:local');
    expect(JSON.stringify(storedConfig(home))).toContain('sk-or-secret');
  });

  test('signed out, there is nowhere else to put it — the machine keeps working', async () => {
    const home = kinuHome({});
    const res = await runStore(home, { local: false });

    expect(res.stdout).toContain('WHERE:local');
    expect(JSON.stringify(storedConfig(home))).toContain('sk-or-secret');
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

    expect(res.stdout).toContain('WHERE:local');
    expect(JSON.stringify(storedConfig(home))).toContain('sk-or-secret');
  });

  test('a public https endpoint lets the account hold the key', async () => {
    const server = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      fetch: () => Response.json({ ok: true }, { status: 201 }),
    });

    const home = kinuHome({ origin: `http://127.0.0.1:${server.port}`, accessToken: 'ptc_test_token' });

    try {
      const res = await runStore(home, { local: false, endpoint: 'https://[2606:4700:4700::1111]/v1' });
      expect(res.stdout).toContain('WHERE:account');
    } finally {
      await server.stop(true);
    }
  });
});

describe('when the account will not take it', () => {
  test('nothing is written anywhere, and the message says what to do', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('{"error":"credential rejected"}', { status: 400 }),
    });

    const home = kinuHome({ origin: `http://127.0.0.1:${server.port}`, accessToken: 'ptc_test_token' });

    try {
      const res = await runStore(home, { local: false });
      expect(res.stdout).toContain('THREW:');
      expect(res.stdout).toContain('Nothing was saved');
      expect(res.stdout).toContain('--local');
      expect(JSON.stringify(storedConfig(home))).not.toContain('sk-or-secret');
    } finally {
      await server.stop(true);
    }
  });

  test('a key already on this disk is removed once the account has it', async () => {
    const server = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      fetch: () => Response.json({ ok: true }, { status: 201 }),
    });

    const home = kinuHome({
      origin: `http://127.0.0.1:${server.port}`,
      accessToken: 'ptc_test_token',
      providers: { openrouter: { apiKey: 'sk-stale-local' } },
    });

    try {
      expect((await runStore(home, { local: false })).stdout).toContain('WHERE:account');
      // A local key wins at resolution time, so a stale one left behind would be the one spent.
      expect(JSON.stringify(storedConfig(home))).not.toContain('sk-stale-local');
    } finally {
      await server.stop(true);
    }
  });
});
