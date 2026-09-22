// Workers AI is option 1 and the `--yes` answer: the account already serves it, and a BYO default would
// override what the platform resolves to. Subprocess: config.ts binds KINU_HOME at import.
import { scratchDir } from '../../test-utils/src/scratch';
import { readFileSync, writeFileSync } from 'node:fs';

import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { DEFAULT_WORKERS_AI_MODEL_ID, DEFAULT_WORKERS_AI_MODEL_SPEC, parseJsonObject, type JsonObject } from '@kinu.run/core';

const repoRoot = resolve(__dirname, '../../..');

const CLOUD_ORIGIN = 'https://kinu.example.com';

const CLOUD_TOKEN = ['ptc_', '0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz'].join('');

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
  const dir = scratchDir('setup-home');
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config), { mode: 0o600 });

  return dir;
}

/** `skipCloud` keeps every branch off the network; each case needs its own process. */
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
    // An unset model reads the platform default at resolve time instead of pinning a copy that would go stale.
    expect(out.config.model).toBeUndefined();
    expect(out.stdout).toContain(DEFAULT_WORKERS_AI_MODEL_SPEC);
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
    expect(skipped.stdout).toContain('Skipped choosing a model provider');
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
