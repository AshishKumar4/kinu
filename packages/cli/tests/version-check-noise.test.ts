// Startup-update-check noise: the once-a-day probe is opportunistic, and an
// aborted or timed-out probe is an expected condition of a background check,
// not a failure a user mid-command should read. These tests pin the split:
// an AbortError from the fetch stays silent; a config that can never be
// written still says so, every run, because that check can never succeed.
//
// Env-dependent paths (KINU_HOME) run in subprocesses like config.test.ts.
import { chmodSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { scratchDir } from '@kinu.run/test-utils';

const repoRoot = resolve(__dirname, '../../..');

const configHome = () => {
  const home = scratchDir('version-noise');
  writeFileSync(join(home, 'config.json'), `${JSON.stringify({
    origin: 'https://example.test',
    accessToken: 'ptc_test',
    updateCheckedAt: 0,
  }, null, 2)}\n`, { mode: 0o600 });
  return home;
};

async function runCheck(home: string, fetchExpr: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: [process.execPath, '-e', `
      import { runStartupUpdateCheck } from './packages/cli/src/version-check.ts';
      const lines = [];
      const outcome = await runStartupUpdateCheck({
        log: (line) => lines.push(line),
        isTTY: true,
        now: ${Date.now() + 10_000_000},
        fetchImpl: ${fetchExpr},
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
  return stdout.trim();
}

/** The subprocess's own JSON report, parsed once at this boundary. */
function parseRun(out: string): { lines: string[]; outcome: string | null } {
  return v.parse(v.object({
    lines: v.array(v.string()),
    outcome: v.nullable(v.string()),
  }), JSON.parse(out));
}

describe('startup update check noise', () => {
  test('an aborted probe prints nothing', async () => {
    const home = configHome();
    // The Mac's exact path: headers arrive, then the body stream aborts when
    // the probe's own timeout fires — the AbortError escapes through
    // res.json() inside fetchServedVersion and reaches the catch.
    const out = await runCheck(home, `
      async () => new Response(new ReadableStream({
        start(controller) {
          setTimeout(() => {
            const error = new Error('The operation was aborted.');
            error.name = 'AbortError';
            controller.error(error);
          }, 10);
        },
      }), { headers: { 'content-type': 'application/json' } })
    `);
    const { lines, outcome } = parseRun(out);
    expect(lines).toEqual([]);
    expect(outcome).toBeNull();
  });

  test('an unwritable config still prints its failure', async () => {
    const home = configHome();
    // The config DIRECTORY becomes unwritable after the CLI has loaded it:
    // writeSecretFile writes its temporary file beside the config, so a
    // read-only directory is the exact write that cannot succeed. That
    // failure is the one the catch must still report.
    chmodSync(home, 0o500);
    try {
      const out = await runCheck(home, `
        async () => new Response(JSON.stringify({ version: '9.9.9+x' }), {
          headers: { 'content-type': 'application/json' },
        })
      `);
      const { lines } = parseRun(out);
      expect(lines.join('\n')).toContain('Update check failed');
    } finally {
      chmodSync(home, 0o700);
    }
  });
});
