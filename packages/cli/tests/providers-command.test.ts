import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

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
  opts: { claude?: 'ready' | 'logged-out'; home: string },
): { stdout: string; stderr: string; exitCode: number | null } {
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
    env: { ...process.env, PATH: path, PROTEUS_HOME: opts.home, NO_COLOR: '1' },
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
