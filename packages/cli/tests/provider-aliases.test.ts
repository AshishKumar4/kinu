import { scratchDir } from '../../test-utils/src/scratch';
import { writeFileSync } from 'node:fs';

import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { canonicalProviderName } from '../src/commands/setup';
import { runCli } from './helpers/run-cli';

const repoRoot = resolve(__dirname, '../../..');

function scratchHome(): string {
  const home = scratchDir('alias-home');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ agents: {} }));

  return home;
}

describe('canonicalProviderName', () => {
  test('both surfaces fold the same aliases onto the same canonical names', () => {
    const cases: Array<[string, string]> = [
      ['cf', 'cloudflare'],
      ['workers-ai', 'cloudflare'],
      ['workersai', 'cloudflare'],
      ['account', 'cloudflare'],
      ['cloudflare', 'cloudflare'],
      ['claude', 'claude'],
      ['claude-code', 'claude'],
      ['subscription', 'claude'],
      ['claude-subscription', 'claude'],

      ['chatgpt', 'chatgpt'],
      ['chatgpt-codex', 'chatgpt'],
      ['openai', 'openai'],
      ['openrouter', 'openrouter'],
      ['anthropic', 'anthropic'],
      ['openai-compatible', 'openai-compatible'],
      ['compat', 'openai-compatible'],
      ['ollama', 'openai-compatible'],
      ['opencode', 'opencode'],
      ['  CF  ', 'cloudflare'],
    ];

    for (const [alias, canonical] of cases) expect(canonicalProviderName(alias)).toBe(canonical);
  });

  test('setup --provider cf reaches the Workers AI branch', async () => {
    const r = await runCli(['setup', '--provider', 'cf', '--skip-cloud'], { home: scratchHome(), cwd: repoRoot });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Workers AI needs a signed-in Kinu account');
  });

  test('provider disconnect workersai resolves like cloudflare', async () => {
    const r = await runCli(['provider', 'disconnect', 'workersai'], { home: scratchHome(), cwd: repoRoot });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('connect through your Kinu account');
  });
});
