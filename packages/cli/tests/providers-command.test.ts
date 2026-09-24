import { scratchDir } from '../../test-utils/src/scratch';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';

import { delimiter, join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { parseJsonObject, type JsonObject } from '@kinu.run/core';
import * as v from 'valibot';

const repoRoot = resolve(__dirname, '../../..');

/** A fake `claude` on PATH exercises the real spawn + `claude auth status` probe. */
function runProviders(
  args: string[],
  opts: { claude?: 'ready' | 'logged-out'; home: string; env?: Record<string, string> },
) {
  const binDir = scratchDir('claude-bin');
  // Controlled PATH excludes the real `claude`; /usr/bin + /bin keep `bash`/`env` for the fake's shebang.
  let path = ['/usr/bin', '/bin'].join(delimiter);

  if (opts.claude) {
    const loggedIn = opts.claude === 'ready';

    const script = [
      '#!/usr/bin/env bash',
      'if [ "$1" = "--version" ]; then echo "claude 1.0.0"; exit 0; fi',
      `if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo '{"loggedIn": ${loggedIn}}'; exit 0; fi`,
      'exit 0',
    ].join('\n');

    const claudePath = join(binDir, 'claude');
    writeFileSync(claudePath, script);
    chmodSync(claudePath, 0o755);
    path = `${binDir}${delimiter}${path}`;
  }

  const argv = JSON.stringify(args);

  const runner = `
    const { providersCommand } = await import('./packages/cli/src/commands/providers.ts');
    await providersCommand(${argv}[0], ${argv}[1], ${argv}[2], {});
  `;

  const proc = Bun.spawnSync({
    cmd: [process.execPath, '-e', runner],
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: '', CODEX_ACCESS_TOKEN: '',
      KINU_BASE_URL: '', KINU_AUTH: '', KINU_MODEL: '',
      PATH: path, KINU_HOME: opts.home, NO_COLOR: '1',
      ...opts.env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode,
  };
}

function freshHome(): string {
  const home = scratchDir('providers-home');

  return home;
}

describe('providers command — Claude subscription', () => {
  test('connect claude reports ready and the create command when installed + logged in', () => {
    const res = runProviders(['connect', 'claude'], { claude: 'ready', home: freshHome() });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Your Claude subscription is ready');
    expect(res.stdout).toContain('claude/claude-opus-4-x');
    expect(res.stdout).toContain('Anthropic API key');
  });

  test('connect claude tells an installed-but-logged-out user to sign in', () => {
    const res = runProviders(['connect', 'claude'], { claude: 'logged-out', home: freshHome() });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Run `claude` once to sign in');
    expect(res.stdout).not.toContain('Your Claude subscription is ready');
  });

  test('connect claude prints install guidance when the binary is absent', () => {
    const res = runProviders(['connect', 'claude'], { home: freshHome() });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Install Claude Code');
    expect(res.stdout).not.toContain('Your Claude subscription is ready');
  });

  test('list shows the Claude subscription status inline', () => {
    const ready = runProviders(['list'], { claude: 'ready', home: freshHome() });
    expect(ready.exitCode).toBe(0);
    expect(ready.stdout).toContain('Claude subscription');
    expect(ready.stdout).toContain('claude/claude-opus-4-x');

    const absent = runProviders(['list'], { home: freshHome() });
    expect(absent.stdout).toContain('Claude subscription');
    expect(absent.stdout).toContain('kinu provider connect claude');
  });
});

/**
 * Resident sessions invalidate provider listings by signal, and each `kinu provider` runs in another
 * process, so the revision in config.json is the only carrier.
 */
describe('providers command — the provider revision', () => {
  function revisionOf(home: string): number {
    const parsed = v.safeParse(v.number(), parseJsonObject(
      readFileSync(join(home, 'config.json'), 'utf8'),
    ).providerRevision);

    return parsed.success ? parsed.output : 0;
  }

  test('a disconnect that removes a stored credential advances it', () => {
    const home = freshHome();
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      providers: { openai: { apiKey: 'sk' } },
    }));
    expect(revisionOf(home)).toBe(0);

    const res = runProviders(['disconnect', 'openai'], { home });

    expect(res.exitCode).toBe(0);
    expect(revisionOf(home)).toBe(1);
  });

  test('the subscription bridges advance it too, and each command advances it once', () => {
    const home = freshHome();
    // Kinu stores no credential for the claude bridge, but a listing sweep probes it, so availability
    // changes bump the revision.
    expect(runProviders(['connect', 'claude'], { claude: 'ready', home }).exitCode).toBe(0);
    expect(revisionOf(home)).toBe(1);

    expect(runProviders(['disconnect', 'claude'], { home }).exitCode).toBe(0);
    expect(revisionOf(home)).toBe(2);

    expect(runProviders(['list'], { home }).exitCode).toBe(0);
    expect(revisionOf(home)).toBe(2);
  });
});

describe('providers command — disconnect', () => {
  function homeWith(config: JsonObject): string {
    const home = freshHome();
    writeFileSync(join(home, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

    return home;
  }

  function readConfig(home: string): JsonObject {
    return parseJsonObject(readFileSync(join(home, 'config.json'), 'utf8'));
  }

  /** The default model, set the way the home screen's Defaults set it. */
  function withDefaultModel(home: string, model: string): void {
    const proc = Bun.spawnSync({
      cmd: [process.execPath, '-e', `
        const { updateDefaultTier } = await import('./packages/cli/src/default-model.ts');
        await updateDefaultTier({ model: ${JSON.stringify(model)} });
      `],
      cwd: repoRoot,
      env: { ...process.env, KINU_HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
  }

  const DefaultModelSchema = v.object({
    localProfile: v.object({ catalog: v.object({ tiers: v.object({ default: v.object({ model: v.string() }) }) }) }),
  });

  test('removes the stored credential from disk and says the default model ran on it, leaving the default', () => {
    const home = homeWith({
      providers: {
        codex: { accessToken: 'at-secret', refreshToken: 'rt-secret' },
        openai: { apiKey: 'sk-keep-me' },
      },
    });

    withDefaultModel(home, 'codex/gpt-5.5');
    const res = runProviders(['disconnect', 'codex'], { home });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Removed the codex credential from this machine');
    expect(res.stdout).toContain('codex/gpt-5.5 runs on it');

    const config = readConfig(home);
    expect(config.providers).toEqual({ openai: { apiKey: 'sk-keep-me' } });
    expect(v.parse(DefaultModelSchema, config).localProfile.catalog.tiers.default.model).toBe('codex/gpt-5.5');
    expect(readFileSync(join(home, 'config.json'), 'utf8')).not.toContain('secret');
  });

  test('an account is picked as the default, listed as it, and taken out of the default when removed', () => {
    const home = homeWith({ providers: { anthropic: { apiKey: 'sk-main', accounts: { work: { apiKey: 'sk-work' } } } } });
    withDefaultModel(home, 'anthropic/claude-x');
    const accountsLine = (out: string): string => out.split('\n').find((line) => line.includes('accounts:'))?.trim() ?? '';

    expect(runProviders(['default', 'anthropic', 'work'], { home }).exitCode).toBe(0);
    expect(accountsLine(runProviders(['list'], { home }).stdout)).toBe('accounts: main, work (default)');

    const removed = runProviders(['disconnect', 'anthropic', 'work'], { home });
    expect(removed.exitCode).toBe(0);
    expect(removed.stdout).toContain('was the default anthropic account');

    const config = readConfig(home);
    expect(config.providers).toEqual({ anthropic: { apiKey: 'sk-main', accounts: {} } });
    expect(v.parse(v.object({ localProfile: v.object({ catalog: v.object({ accounts: v.record(v.string(), v.string()) }) }) }), config)
      .localProfile.catalog.accounts).toEqual({});
  });

  test('disconnecting a provider takes its main account and keeps the others', () => {
    const home = homeWith({ providers: { openai: { apiKey: 'sk-main', accounts: { work: { apiKey: 'sk-work' } } } } });
    expect(runProviders(['disconnect', 'openai'], { home }).exitCode).toBe(0);
    expect(readConfig(home).providers).toEqual({ openai: { accounts: { work: { apiKey: 'sk-work' } } } });
  });

  test('says nothing about a default model that runs on another provider', () => {
    const home = homeWith({ providers: { codex: { accessToken: 'at' }, openai: { apiKey: 'sk' } } });
    withDefaultModel(home, 'openai/gpt-5.5');

    const res = runProviders(['disconnect', 'codex'], { home });
    expect(res.stdout).not.toContain('runs on it');
    expect(v.parse(DefaultModelSchema, readConfig(home)).localProfile.catalog.tiers.default.model).toBe('openai/gpt-5.5');
  });

  test('says so when the provider was not connected, and changes nothing', () => {
    const home = homeWith({ providers: { openai: { apiKey: 'sk' } } });
    const res = runProviders(['disconnect', 'anthropic'], { home });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('was not connected');
    expect(readConfig(home).providers).toEqual({ openai: { apiKey: 'sk' } });
  });

  test('warns that an env credential still overrides the removed file entry', () => {
    const home = homeWith({ providers: { openai: { apiKey: 'sk' } } });
    const res = runProviders(['disconnect', 'openai'], { home, env: { OPENAI_API_KEY: 'sk-env' } });
    expect(res.stdout).toContain('OPENAI_API_KEY is still set');
  });

  test('points the account and subscription bridges at the login that owns them', () => {
    const home = homeWith({});
    expect(runProviders(['disconnect', 'cloudflare'], { home }).stdout).toContain('kinu logout');
    expect(runProviders(['disconnect', 'claude'], { home }).stdout).toContain('claude logout');
    expect(runProviders(['disconnect', 'opencode'], { home }).stdout).toContain('opencode auth logout');
  });

  test('remove and rm are accepted spellings', () => {
    for (const verb of ['remove', 'rm']) {
      const home = homeWith({ providers: { openrouter: { apiKey: 'sk' } } });
      expect(runProviders([verb, 'openrouter'], { home }).stdout).toContain('Removed the openrouter credential from this machine');
      expect(readConfig(home).providers).toEqual({});
    }
  });

  test('rejects an unknown provider instead of silently doing nothing', () => {
    const res = runProviders(['disconnect', 'not-a-provider'], { home: freshHome() });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('Unknown provider "not-a-provider"');
  });
});
