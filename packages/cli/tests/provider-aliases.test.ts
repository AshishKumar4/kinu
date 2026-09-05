// One alias map for `kinu setup --provider` and `kinu provider connect`.
// Both surfaces resolve through `canonicalProviderName`, so an alias learned
// on one works on the other: `cf` on setup, `workersai` on provider connect.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { canonicalProviderName } from '../src/commands/setup';

const repoRoot = resolve(__dirname, '../../..');
const cliBin = join(repoRoot, 'packages/cli/bin/cli.ts');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'kinu-alias-home-'));
  tempDirs.push(home);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ agents: {}, aliases: {} }));
  return home;
}

async function runCli(home: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, cliBin, ...args], {
    cwd: repoRoot,
    env: { ...process.env, KINU_HOME: home, NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
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
      ['codex', 'codex'],
      ['chatgpt', 'codex'],
      ['chatgpt-codex', 'codex'],
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
    const r = await runCli(scratchHome(), ['setup', '--provider', 'cf', '--skip-cloud']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Workers AI needs a signed-in Kinu account');
  });

  test('provider disconnect workersai resolves like cloudflare', async () => {
    const r = await runCli(scratchHome(), ['provider', 'disconnect', 'workersai']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('connect through your Kinu account');
  });
});
