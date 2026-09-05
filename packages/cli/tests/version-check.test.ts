import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { scratchDir } from '@kinu.run/test-utils';
import {
  fetchServedVersion,
  isSameBuild,
} from '../src/version-check';
import type { JsonObject, JsonValue } from '@kinu.run/core';

const repoRoot = resolve(__dirname, '../../..');
// Fixed clock: a due config carries updateCheckedAt 0, a throttled one
// carries NOW, so the 24h window is decided without reading a clock.
const NOW = 2_000_000_000_000;
const signedIn = { origin: 'https://example.test', accessToken: 'ptc_test', updateCheckedAt: 0 };

function configHome(config: JsonObject): string {
  const home = scratchDir('version-check');
  writeFileSync(join(home, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return home;
}

// Drive runStartupUpdateCheck in a child owning its home. The child reports
// what the check returned and printed; the parent reads the throttle state
// the check left behind.
async function runStartup(home: string, opts: { isTTY: boolean; fetchExpr: string }): Promise<{
  lines: string[]; outcome: string | null;
}> {
  const proc = Bun.spawn({
    cmd: [process.execPath, '-e', `
      import { runStartupUpdateCheck } from './packages/cli/src/version-check.ts';
      import { VERSION } from './packages/cli/src/display.ts';
      const lines = [];
      const outcome = await runStartupUpdateCheck({
        log: (line) => lines.push(line),
        isTTY: ${opts.isTTY},
        now: ${NOW},
        fetchImpl: ${opts.fetchExpr},
      });
      console.log(JSON.stringify({ lines, outcome }));
    `],
    cwd: repoRoot,
    env: { ...process.env, KINU_HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`script failed (${exitCode}): ${stderr}`);
  return v.parse(v.object({
    lines: v.array(v.string()),
    outcome: v.nullable(v.string()),
  }), JSON.parse(stdout.trim()));
}

function homeConfig(home: string): { updateCheckedAt?: unknown; updateLatestSeen?: unknown } {
  return v.parse(v.object({
    updateCheckedAt: v.optional(v.unknown()),
    updateLatestSeen: v.optional(v.unknown()),
  }), JSON.parse(readFileSync(join(home, 'config.json'), 'utf-8')));
}

const serveVersion = (versionExpr: string) => `async () => new Response(JSON.stringify({ version: ${versionExpr} }), {
  headers: { 'content-type': 'application/json' },
})`;
const mustNotFetch = `async () => { throw new Error('the check must not spend a round-trip'); }`;

describe('build comparison', () => {
  test('semver build metadata is significant — same version, different build', () => {
    expect(isSameBuild('0.1.0+abc1234', '0.1.0+abc1234')).toBe(true);
    expect(isSameBuild('0.1.0+abc1234', '0.1.0+def5678')).toBe(false);
    // An unstamped local build vs a stamped served one is NOT the same build.
    expect(isSameBuild('0.1.0', '0.1.0+abc1234')).toBe(false);
    expect(isSameBuild('0.1.0', '0.1.0')).toBe(true);
  });
});

describe('startup notice through runStartupUpdateCheck', () => {
  test('a newer build returns the exact notice line and logs it once', async () => {
    const home = configHome(signedIn);
    const { lines, outcome } = await runStartup(home, { isTTY: true, fetchExpr: serveVersion(`'9.9.9+check'`) });
    expect(outcome).toBe('A newer Kinu is available (9.9.9+check). Run: kinu update');
    expect(lines).toEqual(['A newer Kinu is available (9.9.9+check). Run: kinu update']);
    expect(homeConfig(home)).toMatchObject({ updateCheckedAt: NOW, updateLatestSeen: '9.9.9+check' });
  });

  test('the installed build stays silent after a spent round-trip', async () => {
    const home = configHome(signedIn);
    const { lines, outcome } = await runStartup(home, { isTTY: true, fetchExpr: serveVersion(`VERSION`) });
    expect(outcome).toBeNull();
    expect(lines).toEqual([]);
    // The attempt is still recorded, so an up-to-date origin is not re-asked
    // on every invocation.
    expect(homeConfig(home)).toMatchObject({ updateCheckedAt: NOW });
  });

  test('an unreachable origin stays silent but still throttles the next run', async () => {
    const home = configHome(signedIn);
    const { lines, outcome } = await runStartup(home, {
      isTTY: true,
      fetchExpr: `async () => { throw new Error('offline'); }`,
    });
    expect(outcome).toBeNull();
    expect(lines).toEqual([]);
    expect(homeConfig(home)).toMatchObject({ updateCheckedAt: NOW });
  });
});

describe('startup-check suppression', () => {
  test('suppressed in non-TTY runs (CI, pipes, --json)', async () => {
    const home = configHome(signedIn);
    const { lines, outcome } = await runStartup(home, { isTTY: false, fetchExpr: mustNotFetch });
    expect(outcome).toBeNull();
    expect(lines).toEqual([]);
    expect(homeConfig(home)).toMatchObject({ updateCheckedAt: 0 });
  });

  test('suppressed by the opt-out flag', async () => {
    const home = configHome({ ...signedIn, updateCheck: false });
    const { lines, outcome } = await runStartup(home, { isTTY: true, fetchExpr: mustNotFetch });
    expect(outcome).toBeNull();
    expect(lines).toEqual([]);
    expect(homeConfig(home)).toMatchObject({ updateCheckedAt: 0 });
  });

  test('suppressed with no configured origin', async () => {
    const home = configHome({ updateCheckedAt: 0 });
    const { lines, outcome } = await runStartup(home, { isTTY: true, fetchExpr: mustNotFetch });
    expect(outcome).toBeNull();
    expect(lines).toEqual([]);
    expect(homeConfig(home)).toMatchObject({ updateCheckedAt: 0 });
  });

  test('throttled inside the 24h window', async () => {
    const home = configHome({ ...signedIn, updateCheckedAt: NOW });
    const { lines, outcome } = await runStartup(home, { isTTY: true, fetchExpr: mustNotFetch });
    expect(outcome).toBeNull();
    expect(lines).toEqual([]);
    const config = homeConfig(home);
    expect(config).toMatchObject({ updateCheckedAt: NOW });
    expect(config.updateLatestSeen).toBeUndefined();
  });
});

describe('fetchServedVersion is fail-soft', () => {
  const ok = (body: JsonValue) => async () => new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });

  test('parses a well-formed payload', async () => {
    const v = await fetchServedVersion('https://x.test', ok({ version: '0.1.0+abc', sha: 'abc' }));
    expect(v).toEqual({ version: '0.1.0+abc', sha: 'abc' });
  });

  test('returns null on 404 (server without the endpoint)', async () => {
    const f = async () => new Response('nope', { status: 404 });
    expect(await fetchServedVersion('https://x.test', f)).toBeNull();
  });

  test('returns null on malformed payloads and network errors', async () => {
    expect(await fetchServedVersion('https://x.test', ok({ nope: true }))).toBeNull();
    expect(await fetchServedVersion('https://x.test', ok({ version: '  ' }))).toBeNull();
    const boom = async () => { throw new Error('offline'); };
    expect(await fetchServedVersion('https://x.test', boom)).toBeNull();
  });

  test('returns null rather than hanging when the origin stalls', async () => {
    const stall = (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
    });
    expect(await fetchServedVersion('https://x.test', stall, 10)).toBeNull();
  });
});
