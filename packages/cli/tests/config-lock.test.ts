import { runToExit } from '@kinu.run/test-utils';
import { scratchDir } from '../../test-utils/src/scratch';
import { describe, expect, test } from 'bun:test';

import { join } from 'node:path';

/**
 * `withConfigLock` across separate processes: the lost write it prevents cannot happen in one.
 * Scenario bodies run via `bun -e` so each child binds KINU_HOME at its own module load.
 */
describe('cross-process config read-modify-write', () => {
  const repoRoot = join(import.meta.dir, '../../..');
  // `bun -e` resolves relative specifiers from the invoking file's directory, which differs under `bun test`.
  const CONFIG_TS = JSON.stringify(join(repoRoot, 'packages/cli/src/config.ts'));

  interface ProcessOutcome {
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }

  async function runIn(home: string, body: string): Promise<ProcessOutcome> {
    const run = await runToExit([process.execPath, '-e', body], { cwd: repoRoot, env: { ...process.env, KINU_HOME: home } });

    return { code: run.exitCode, stdout: run.stdout, stderr: run.stderr };
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
    const home = scratchDir('config-lock-race');

    // Unlocked load-modify-write drops increments; the locked path makes the total exact.
    const worker = `
      const { updateConfigFile } = await import(${CONFIG_TS});
      for (let i = 0; i < 25; i++) {
        await updateConfigFile((config) => {
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

    const final = await runIn(home, `
      const { loadConfigFile } = await import(${CONFIG_TS});
      console.log(JSON.stringify(loadConfigFile().aliases));
    `);

    expect(final.code).toBe(0);
    expect(JSON.parse(final.stdout)).toEqual({ count: '50' });
  });

  test('a throwing mutator changes nothing and releases the lock', async () => {
    const home = scratchDir('config-lock-crash');

    const result = await runIn(home, `
      const { lstatSync } = await import('node:fs');
      const { updateConfigFile, loadConfigFile, CONFIG_PATH } = await import(${CONFIG_TS});
      await updateConfigFile(() => ({ origin: 'https://before.test' }));
      try {
        await updateConfigFile(() => { throw new Error('mutator blew up'); });
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

    const again = await runIn(home, `
      const { updateConfigFile } = await import(${CONFIG_TS});
      await updateConfigFile((config) => { config.updateCheck = false; });
      console.log('ok');
    `);

    expect(again.code).toBe(0);
    expect(again.stdout.trim()).toBe('ok');
  });

  test('a lock left behind by a killed process is taken over', async () => {
    const home = scratchDir('config-lock-abandoned');

    const result = await runIn(home, `
      const { lstatSync, symlinkSync } = await import('node:fs');
      const { CONFIG_PATH, loadConfigFile, updateConfigFile } = await import(${CONFIG_TS});
      const lock = CONFIG_PATH + '.lock';
      // A holder killed mid-write leaves its lock behind. The owner record is
      // the symlink's target: one hold's token, then the pid and process start
      // time that identify the holder. Breakability is that identity and
      // nothing else — no clock is touched here, and no duration would change
      // either answer. This pid has exited and been reaped, so Linux says
      // plainly that there is no such process.
      const exited = Bun.spawn({ cmd: ['/bin/true'] });
      await exited.exited;
      const dead = exited.pid;
      symlinkSync('v1 linux 00000000-0000-4000-8000-000000000004 ' + dead + ' 12345', lock);
      await updateConfigFile((config) => { config.origin = 'https://after.test'; });
      console.log(JSON.stringify({
        origin: loadConfigFile().origin,
        lockGone: !lstatSync(lock, { throwIfNoEntry: false }),
      }));
    `);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ origin: 'https://after.test', lockGone: true });
  });
});
