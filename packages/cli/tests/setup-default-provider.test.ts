// Workers AI is option 1 and the `--yes` answer: the account already serves it, and a BYO default would
// override what the platform resolves to. Subprocess: config.ts binds KINU_HOME at import.
import { runToExit } from '@kinu.run/test-utils';
import { scratchDir } from '../../test-utils/src/scratch';
import { readFileSync, writeFileSync } from 'node:fs';

import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { DEFAULT_WORKERS_AI_MODEL_ID, DEFAULT_WORKERS_AI_MODEL_SPEC, parseJsonObject, type JsonObject } from '@kinu.run/core';
import * as v from 'valibot';

const repoRoot = resolve(__dirname, '../../..');

const CLOUD_ORIGIN = 'https://kinu.example.com';

const CLOUD_TOKEN = ['ptc_', '0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz'].join('');

function signedInHome(extra: JsonObject = {}): string {
  return home({
    origin: CLOUD_ORIGIN,
    accessToken: CLOUD_TOKEN,
    providers: { codex: { accessToken: 'codex-token', refreshToken: 'codex-refresh' } },
    ...extra,
  });
}

function home(config: JsonObject): string {
  const dir = scratchDir('setup-home');
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config), { mode: 0o600 });

  return dir;
}

/** The default model, set the way the home screen's Defaults set it. */
async function withDefaultModel(kinuHome: string, model: string): Promise<string> {
  const proc = await runToExit([process.execPath, '-e', `
      const { updateDefaultTier } = await import('./packages/cli/src/default-model.ts');
      await updateDefaultTier({ model: ${JSON.stringify(model)} });
    `], {
    cwd: repoRoot,
    env: { ...process.env, KINU_HOME: kinuHome },
  });

  expect(proc.exitCode, proc.stderr).toBe(0);

  return kinuHome;
}

const DefaultTierSchema = v.object({
  localProfile: v.optional(v.object({ catalog: v.object({ tiers: v.object({ default: v.object({ model: v.string() }) }) }) })),
});

function defaultModelOf(config: JsonObject): string | undefined {
  return v.parse(DefaultTierSchema, config).localProfile?.catalog.tiers.default.model;
}

/** `skipCloud` keeps every branch off the network; each case needs its own process. */
async function runSetup(opts: JsonObject, kinuHome: string) {
  const runner = `
    const { setupCommand } = await import('./packages/cli/src/commands/setup.ts');
    await setupCommand({ ...${JSON.stringify(opts)}, skipCloud: true });
  `;

  const proc = await runToExit([process.execPath, '-e', runner], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: '', CODEX_ACCESS_TOKEN: '',
      KINU_BASE_URL: '', KINU_AUTH: '', KINU_MODEL: '', KINU_TOKEN: '', KINU_ORIGIN: '',
      KINU_HOME: kinuHome, NO_COLOR: '1',
    },
  });

  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    exitCode: proc.exitCode,
    config: parseJsonObject(readFileSync(join(kinuHome, 'config.json'), 'utf8')),
  };
}

describe('kinu setup recommends the native Workers AI model', () => {
  test('--yes takes the native path, which becomes the default where there is none', async () => {
    const out = await runSetup({ yes: true }, signedInHome());
    expect(out.exitCode).toBe(0);
    expect(defaultModelOf(out.config)).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
    expect(out.stdout).toContain(DEFAULT_WORKERS_AI_MODEL_SPEC);
    expect(out.config.providers).toMatchObject({ codex: { accessToken: 'codex-token' } });
  });

  test('menu option 1 is the native path', async () => {
    const out = await runSetup({ provider: '1' }, signedInHome());
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain(DEFAULT_WORKERS_AI_MODEL_SPEC);
  });

  test('the other providers are still offered, one position further down', async () => {
    const skipped = await runSetup({ provider: '8' }, await withDefaultModel(signedInHome(), 'codex/gpt-5.5'));
    expect(skipped.exitCode).toBe(0);
    expect(skipped.stdout).toContain('Skipped choosing a model provider');
    expect(defaultModelOf(skipped.config)).toBe('codex/gpt-5.5');

    const unknown = await runSetup({ provider: 'nope' }, signedInHome());
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr)
      .toContain('Provider must be workers-ai, codex, openai, openrouter, anthropic, openai-compatible, opencode, or skip.');
  });

  test('an explicit Workers AI model becomes the default where there is none, and leaves a chosen one', async () => {
    const fresh = await runSetup({ provider: 'workers-ai', model: '@cf/meta/llama-4' }, signedInHome());
    expect(fresh.exitCode).toBe(0);
    expect(defaultModelOf(fresh.config)).toBe('workers-ai/@cf/meta/llama-4');

    const chosen = await runSetup({ provider: 'workers-ai', model: '@cf/meta/llama-4' }, await withDefaultModel(signedInHome(), 'codex/gpt-5.5'));
    expect(chosen.exitCode).toBe(0);
    expect(defaultModelOf(chosen.config)).toBe('codex/gpt-5.5');
    expect(chosen.stdout).toContain('pick it under Defaults');
  });

  test('signed out, the native path asks for sign-in instead of writing a model it cannot serve', async () => {
    const out = await runSetup({ yes: true }, home({}));
    expect(out.exitCode).toBe(0);
    expect(defaultModelOf(out.config)).toBeUndefined();
    expect(out.stdout).toContain('kinu auth');
    expect(out.stdout).not.toContain(DEFAULT_WORKERS_AI_MODEL_ID);
  });
});
