// What `kinu setup` recommends.
//
// The default used to be the ChatGPT Codex subscription: menu option 1, and
// what `--yes` picked. That overrode the native Cloudflare Workers AI model the
// platform otherwise resolves to, which is the one the account already serves.
// Native is now option 1 and the `--yes` answer; the other providers are all
// still reachable, just not preferred.
//
// Driven through the real `setupCommand` in a subprocess, because config.ts
// binds KINU_HOME at import.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { DEFAULT_WORKERS_AI_MODEL_ID, DEFAULT_WORKERS_AI_MODEL_SPEC, parseJsonObject, type JsonObject } from '@kinu.run/core';

const repoRoot = resolve(__dirname, '../../..');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CLOUD_ORIGIN = 'https://kinu.example.com';
const CLOUD_TOKEN = ['ptc_', '0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz'].join('');

/** A signed-in machine that had been pinned to a paid BYO provider. */
function signedInHome(extra: JsonObject = {}): string {
  return home({
    origin: CLOUD_ORIGIN,
    accessToken: CLOUD_TOKEN,
    model: 'codex/gpt-5.5',
    providers: { codex: { accessToken: 'codex-token', refreshToken: 'codex-refresh' } },
    ...extra,
  });
}

function home(config: JsonObject): string {
  const dir = mkdtempSync(join(tmpdir(), 'kinu-setup-home-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  return dir;
}

/** Runs setupCommand with `skipCloud`, so no branch can reach the network:
 *  every assertion here is about which provider the flow chooses. The import
 *  is dynamic because it runs inside a `bun -e` child — config.ts binds
 *  KINU_HOME at import, so each case needs its own process. */
function runSetup(opts: JsonObject, kinuHome: string) {
  const runner = `
    const { setupCommand } = await import('./packages/cli/src/commands/setup.ts');
    await setupCommand({ ...${JSON.stringify(opts)}, skipCloud: true });
  `;
  const proc = Bun.spawnSync({
    cmd: [process.execPath, '-e', runner],
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: '', CODEX_ACCESS_TOKEN: '',
      KINU_BASE_URL: '', KINU_AUTH: '', KINU_MODEL: '', KINU_TOKEN: '', KINU_ORIGIN: '',
      KINU_HOME: kinuHome, NO_COLOR: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode,
    config: parseJsonObject(readFileSync(join(kinuHome, 'config.json'), 'utf8')),
  };
}

describe('kinu setup recommends the native Workers AI model', () => {
  test('--yes takes the native path and stops pinning a BYO model', () => {
    const out = runSetup({ yes: true }, signedInHome());
    expect(out.exitCode).toBe(0);
    // Nothing stored: the platform default is one constant, and an unset model
    // reads it at resolve time instead of pinning a copy that would go stale.
    expect(out.config.model).toBeUndefined();
    expect(out.stdout).toContain(DEFAULT_WORKERS_AI_MODEL_SPEC);
    // The Codex credential is left alone — the provider stays available.
    expect(out.config.providers).toMatchObject({ codex: { accessToken: 'codex-token' } });
  });

  test('menu option 1 is the native path', () => {
    const out = runSetup({ provider: '1' }, signedInHome());
    expect(out.exitCode).toBe(0);
    expect(out.config.model).toBeUndefined();
    expect(out.stdout).toContain(DEFAULT_WORKERS_AI_MODEL_SPEC);
  });

  test('the other providers are still offered, one position further down', () => {
    const skipped = runSetup({ provider: '8' }, signedInHome());
    expect(skipped.exitCode).toBe(0);
    expect(skipped.stdout).toContain('Skipped local model setup');
    expect(skipped.config.model).toBe('codex/gpt-5.5');

    const unknown = runSetup({ provider: 'nope' }, signedInHome());
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr)
      .toContain('Provider must be workers-ai, codex, openai, openrouter, anthropic, openai-compatible, opencode, or skip.');
  });

  test('an explicit Workers AI model is pinned as chosen', () => {
    const out = runSetup({ provider: 'workers-ai', model: '@cf/meta/llama-4' }, signedInHome());
    expect(out.exitCode).toBe(0);
    expect(out.config.model).toBe('workers-ai/@cf/meta/llama-4');
  });

  test('signed out, the native path asks for sign-in instead of writing a model it cannot serve', () => {
    const out = runSetup({ yes: true }, home({}));
    expect(out.exitCode).toBe(0);
    expect(out.config.model).toBeUndefined();
    expect(out.stdout).toContain('kinu auth');
    expect(out.stdout).not.toContain(DEFAULT_WORKERS_AI_MODEL_ID);
  });
});
