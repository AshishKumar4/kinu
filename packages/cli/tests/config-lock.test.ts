import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The one config mutation path: every read-modify-write of ~/.kinu/config.json
 * runs inside `withConfigLock`. These proofs drive it from separate PROCESSES,
 * because the failure it exists for — a second process writing between one
 * process's read and its write — cannot happen inside a single one.
 *
 * Each scenario body is a string evaluated by a fresh `bun -e` so the child
 * binds KINU_HOME at ITS module load; static imports cannot cross that
 * process boundary.
 */
describe('cross-process config read-modify-write', () => {
  const repoRoot = join(import.meta.dir, '../../..');
  // `bun -e` resolves relative specifiers against the invoking file's
  // directory, which differs between a direct run and `bun test` — so the
  // scenario bodies import through this absolute specifier.
  const CONFIG_TS = JSON.stringify(join(repoRoot, 'packages/cli/src/config.ts'));

  interface ProcessOutcome {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
  }

  function runIn(home: string, body: string): ProcessOutcome {
    const proc = Bun.spawnSync({
      cmd: [process.execPath, '-e', body],
      cwd: repoRoot,
      env: { ...process.env, KINU_HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  }

  function spawnIn(home: string, body: string): Bun.Subprocess<'ignore', 'pipe', 'pipe'> {
    return Bun.spawn({
      cmd: [process.execPath, '-e', body],
      cwd: repoRoot,
      env: { ...process.env, KINU_HOME: home },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  }

  async function settle(proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>): Promise<{ code: number; stderr: string }> {
    const code = await proc.exited;
    const stderr = new TextDecoder().decode(await new Response(proc.stderr).arrayBuffer());
    return { code, stderr };
  }

  test('two processes contending on ONE counter lose no update', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kinu-config-lock-race-'));
    try {
      // Both workers bump the SAME alias 25 times. Under a load-modify-write
      // without a lock the interleavings silently drop increments; the locked
      // path serializes them, so the total is exact.
      const worker = `
        const { updateConfigFile } = await import(${CONFIG_TS});
        for (let i = 0; i < 25; i++) {
          updateConfigFile((config) => {
            const aliases = config.aliases ?? {};
            aliases.count = String(Number(aliases.count ?? '0') + 1);
            config.aliases = aliases;
          });
        }
      `;
      const [a, b] = await Promise.all([
        settle(spawnIn(home, worker)),
        settle(spawnIn(home, worker)),
      ]);
      expect(a).toEqual({ code: 0, stderr: '' });
      expect(b).toEqual({ code: 0, stderr: '' });

      const final = runIn(home, `
        const { loadConfigFile } = await import(${CONFIG_TS});
        console.log(JSON.stringify(loadConfigFile().aliases));
      `);
      expect(final.code).toBe(0);
      expect(JSON.parse(final.stdout)).toEqual({ count: '50' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a throwing mutator changes nothing and releases the lock', () => {
    const home = mkdtempSync(join(tmpdir(), 'kinu-config-lock-crash-'));
    try {
      const result = runIn(home, `
        const { lstatSync } = await import('node:fs');
        const { saveConfigFile, updateConfigFile, loadConfigFile, CONFIG_PATH } = await import(${CONFIG_TS});
        saveConfigFile({ origin: 'https://before.test' });
        try {
          updateConfigFile(() => { throw new Error('mutator blew up'); });
        } catch (error) {
          console.log(JSON.stringify({
            message: error.message,
            fileIntact: loadConfigFile().origin,
            // A held lock is a symlink to its owner record, so presence is an
            // lstat question: existsSync follows the link and answers false for
            // a lock that is there.
            lockReleased: !lstatSync(CONFIG_PATH + '.lock', { throwIfNoEntry: false }),
          }));
        }
      `);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        message: 'mutator blew up',
        fileIntact: 'https://before.test',
        lockReleased: true,
      });

      // And the next writer proceeds immediately — nothing to trip over.
      const again = runIn(home, `
        const { updateConfigFile } = await import(${CONFIG_TS});
        updateConfigFile((config) => { config.updateCheck = false; });
        console.log('ok');
      `);
      expect(again.code).toBe(0);
      expect(again.stdout.trim()).toBe('ok');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a lock left behind by a killed process is taken over', () => {
    const home = mkdtempSync(join(tmpdir(), 'kinu-config-lock-abandoned-'));
    try {
      const result = runIn(home, `
        const { lstatSync, symlinkSync } = await import('node:fs');
        const { CONFIG_PATH, loadConfigFile, updateConfigFile } = await import(${CONFIG_TS});
        const lock = CONFIG_PATH + '.lock';
        // A holder killed mid-write leaves its lock behind. The owner record is
        // the symlink's target: one hold's token, then the pid and process start
        // time that identify the holder. Breakability is that identity and
        // nothing else — no clock is touched here, and no duration would change
        // either answer. This pid has exited and been reaped, so Linux says
        // plainly that there is no such process.
        const dead = Bun.spawnSync({ cmd: ['/bin/true'] }).pid;
        symlinkSync('v1 linux 00000000-0000-4000-8000-000000000004 ' + dead + ' 12345', lock);
        updateConfigFile((config) => { config.origin = 'https://after.test'; });
        console.log(JSON.stringify({
          origin: loadConfigFile().origin,
          lockGone: !lstatSync(lock, { throwIfNoEntry: false }),
        }));
      `);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ origin: 'https://after.test', lockGone: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
