// Where a provider secret is written when `proteus provider connect` captures
// one. The default is the owner's Kinu account — sealed at rest there and
// reachable from every machine through the provider proxy — so that this disk
// does not end up holding a second copy of the same key.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { parseJsonObject, type JsonObject } from '@kinu/core';

const homes: string[] = [];
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function proteusHome(config: JsonObject): string {
  const home = mkdtempSync(join(tmpdir(), 'proteus-secret-home-'));
  homes.push(home);
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  return home;
}

function storedConfig(home: string): JsonObject {
  return parseJsonObject(readFileSync(join(home, 'config.json'), 'utf8'));
}

/** The real command module, run in a child process so PROTEUS_HOME is read
 *  fresh and nothing touches the developer's own ~/.proteus. */
async function runStore(home: string, opts: { local: boolean; origin?: string }) {
  const runner = `
    const { storeProviderSecret } = await import('./packages/cli/src/commands/setup.ts');
    const { loadConfigFile, saveConfigFile, updateConfigFile } = await import('./packages/cli/src/config.ts');
    try {
      const where = await storeProviderSecret({
        local: ${opts.local},
        credKey: 'openrouter.bearer',
        credential: { kind: 'bearer', token: 'sk-or-secret' },
        storeLocally: () => {
          const config = loadConfigFile();
          saveConfigFile({ ...config, providers: { ...(config.providers ?? {}), openrouter: { apiKey: 'sk-or-secret' } } });
        },
        clearLocally: () => updateConfigFile((config) => { delete config.providers?.openrouter; }),
        model: 'openrouter/anthropic/claude-x',
      });
      console.log('WHERE:' + where);
    } catch (e) {
      console.log('THREW:' + e.message);
    }
  `;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PROTEUS_HOME: home, NO_COLOR: '1',
    OPENROUTER_API_KEY: '', PROTEUS_TOKEN: '',
  };
  if (opts.origin) env.PROTEUS_ORIGIN = opts.origin;
  else delete env.PROTEUS_ORIGIN;
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
    const home = proteusHome({ origin, accessToken: 'ptc_test_token' });

    try {
      const res = await runStore(home, { local: false });
      expect(res.stdout).toContain('WHERE:account');
      expect(received).toHaveLength(1);
      expect(received[0]?.path).toBe('/api/cli/credentials/openrouter.bearer');
      expect(received[0]?.auth).toBe('Bearer ptc_test_token');
      expect(received[0]?.body).toContain('sk-or-secret');

      const config = storedConfig(home);
      expect(JSON.stringify(config)).not.toContain('sk-or-secret');
      // The model pointer still lands locally — it names a model, not a secret.
      expect(config.model).toBe('openrouter/anthropic/claude-x');
    } finally {
      server.stop(true);
    }
  });

  test('--local keeps it on this machine, for offline use', async () => {
    const home = proteusHome({ origin: 'http://127.0.0.1:1', accessToken: 'ptc_test_token' });
    const res = await runStore(home, { local: true });

    expect(res.stdout).toContain('WHERE:local');
    expect(JSON.stringify(storedConfig(home))).toContain('sk-or-secret');
  });

  test('signed out, there is nowhere else to put it — the machine keeps working', async () => {
    const home = proteusHome({});
    const res = await runStore(home, { local: false });

    expect(res.stdout).toContain('WHERE:local');
    expect(JSON.stringify(storedConfig(home))).toContain('sk-or-secret');
  });
});

describe('when the account will not take it', () => {
  test('nothing is written anywhere, and the message says what to do', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('{"error":"credential rejected"}', { status: 400 }),
    });
    const home = proteusHome({ origin: `http://127.0.0.1:${server.port}`, accessToken: 'ptc_test_token' });

    try {
      const res = await runStore(home, { local: false });
      expect(res.stdout).toContain('THREW:');
      expect(res.stdout).toContain('Nothing was saved');
      expect(res.stdout).toContain('--local');
      expect(JSON.stringify(storedConfig(home))).not.toContain('sk-or-secret');
    } finally {
      server.stop(true);
    }
  });

  test('a key already on this disk is removed once the account has it', async () => {
    const server = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      fetch: () => Response.json({ ok: true }, { status: 201 }),
    });
    const home = proteusHome({
      origin: `http://127.0.0.1:${server.port}`,
      accessToken: 'ptc_test_token',
      providers: { openrouter: { apiKey: 'sk-stale-local' } },
    });

    try {
      expect((await runStore(home, { local: false })).stdout).toContain('WHERE:account');
      // A local key wins at resolution time, so leaving the old one behind
      // would mean the stale key is the one actually spent.
      expect(JSON.stringify(storedConfig(home))).not.toContain('sk-stale-local');
    } finally {
      server.stop(true);
    }
  });
});
