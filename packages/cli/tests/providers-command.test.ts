import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { parseJsonObject, type JsonObject } from '@proteus/core';

const repoRoot = resolve(__dirname, '../../..');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Behaviour test through the real `providersCommand`: a fake `claude` on PATH
 *  exercises the actual spawn + `claude auth status` probe (no stubbing of the
 *  child-process seam). `mode` shapes how the fake binary answers. */
function runProviders(
  args: string[],
  opts: { claude?: 'ready' | 'logged-out'; home: string; env?: Record<string, string> },
) {
  const binDir = mkdtempSync(join(tmpdir(), 'proteus-claude-bin-'));
  tempDirs.push(binDir);
  // Controlled PATH excludes the user's real `claude` so "absent" is honest;
  // /usr/bin + /bin keep `bash`/`env` available for the fake binary's shebang.
  let path = ['/usr/bin', '/bin'].join(delimiter);
  if (opts.claude) {
    const loggedIn = opts.claude === 'ready';
    // The probe runs `claude --version` then `claude auth status` (JSON stdout).
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
    await providersCommand(${argv}[0], ${argv}[1], {});
  `;
  const proc = Bun.spawnSync({
    cmd: [process.execPath, '-e', runner],
    cwd: repoRoot,
    // Ambient provider env vars would change what "connected" means here.
    env: {
      ...process.env,
      OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: '', CODEX_ACCESS_TOKEN: '',
      PROTEUS_BASE_URL: '', PROTEUS_AUTH: '', PROTEUS_MODEL: '',
      PATH: path, PROTEUS_HOME: opts.home, NO_COLOR: '1',
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
  const home = mkdtempSync(join(tmpdir(), 'proteus-providers-home-'));
  tempDirs.push(home);
  return home;
}

describe('providers command — Claude subscription', () => {
  test('connect claude reports ready and the create command when installed + logged in', () => {
    const res = runProviders(['connect', 'claude'], { claude: 'ready', home: freshHome() });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Claude subscription ready');
    expect(res.stdout).toContain('claude/claude-opus-4-x');
    // Compliance note: cloud agents need an Anthropic API key, not the sub.
    expect(res.stdout).toContain('Anthropic API key');
  });

  test('connect claude tells an installed-but-logged-out user to sign in', () => {
    const res = runProviders(['connect', 'claude'], { claude: 'logged-out', home: freshHome() });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Run `claude` once to sign in');
    expect(res.stdout).not.toContain('Claude subscription ready');
  });

  test('connect claude prints install guidance when the binary is absent', () => {
    // No fake binary on PATH → the probe sees ENOENT → binary:false.
    const res = runProviders(['connect', 'claude'], { home: freshHome() });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Install Claude Code');
    expect(res.stdout).not.toContain('Claude subscription ready');
  });

  test('list shows the Claude subscription status inline', () => {
    const ready = runProviders(['list'], { claude: 'ready', home: freshHome() });
    expect(ready.exitCode).toBe(0);
    expect(ready.stdout).toContain('Claude subscription');
    expect(ready.stdout).toContain('claude/claude-opus-4-x');

    const absent = runProviders(['list'], { home: freshHome() });
    expect(absent.stdout).toContain('Claude subscription');
    expect(absent.stdout).toContain('proteus provider connect claude');
  });
});

/** `provider disconnect` is the inverse of `provider connect`: it must remove
 *  the credential from disk, not merely stop showing it. */
describe('providers command — disconnect', () => {
  function homeWith(config: JsonObject): string {
    const home = freshHome();
    writeFileSync(join(home, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return home;
  }

  function readConfig(home: string): JsonObject {
    return parseJsonObject(readFileSync(join(home, 'config.json'), 'utf8'));
  }

  test('removes the stored credential from disk and clears the default model', () => {
    const home = homeWith({
      model: 'codex/gpt-5.5',
      providers: {
        codex: { accessToken: 'at-secret', refreshToken: 'rt-secret' },
        openai: { apiKey: 'sk-keep-me' },
      },
    });

    const res = runProviders(['disconnect', 'codex'], { home });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Removed the codex credential from this machine');

    const config = readConfig(home);
    expect(config.providers).toEqual({ openai: { apiKey: 'sk-keep-me' } });
    expect(config.model).toBeUndefined();
    // The whole point: no trace of the secret survives in the file.
    expect(readFileSync(join(home, 'config.json'), 'utf8')).not.toContain('secret');
  });

  test('leaves another provider\'s default model alone', () => {
    const home = homeWith({
      model: 'openai/gpt-5.5',
      providers: { codex: { accessToken: 'at' }, openai: { apiKey: 'sk' } },
    });
    runProviders(['disconnect', 'codex'], { home });
    expect(readConfig(home).model).toBe('openai/gpt-5.5');
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
    expect(runProviders(['disconnect', 'cloudflare'], { home }).stdout).toContain('proteus logout');
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
    // Signed out there is no account to hold a models.dev provider under that
    // name either, so the rejection names both halves of the answer.
    const res = runProviders(['disconnect', 'not-a-provider'], { home: freshHome() });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('Unknown provider "not-a-provider"');
  });
});
