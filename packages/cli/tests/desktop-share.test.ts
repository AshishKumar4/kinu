/**
 * `kinu desktop share` and `kinu desktop unshare` (1014-t): the command writes its request beside device.json, signals
 * the daemon the pidfile names, and waits for the daemon's answer from the desktop portal's prompt. The daemon here is a
 * stand-in of the installed daemon's own file that answers the signal as the real one does (linux-screen.js), so what
 * is proved is the command's half: the request, the signal, and the answer read back in words.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import { scratchDir } from '@kinu.run/test-utils';

const CLI = resolve(import.meta.dir, '../bin/cli.ts');

const daemons: Subprocess[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    daemon.kill();
    await daemon.exited;
  }
});

/** The installed daemon's file, answering SIGUSR1 as `answer` (JavaScript over `request`, the file's contents) says. */
function standIn(home: string, answer: string): void {
  writeFileSync(join(home, 'pc-agent.js'), `
    const fs = require('node:fs');
    const file = ${JSON.stringify(join(home, 'desktop.json'))};
    process.on('SIGUSR1', () => {
      const request = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
      fs.appendFileSync(${JSON.stringify(join(home, 'signals'))}, JSON.stringify(request) + '\\n');
      ${answer}
    });
    process.stdin.resume();
  `, { mode: 0o700 });
  const daemon = Bun.spawn({ cmd: [process.execPath, join(home, 'pc-agent.js')], stdin: 'pipe', env: { ...process.env, KINU_HOME: home } });

  daemons.push(daemon);
  writeFileSync(join(home, 'pc-agent.pid'), `${String(daemon.pid)}\n`, { mode: 0o600 });
}

async function kinu(home: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const run = Bun.spawn({ cmd: [process.execPath, CLI, 'desktop', ...args], stdout: 'pipe', stderr: 'pipe', env: { ...process.env, KINU_HOME: home } });
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);

  return { code, out: Bun.stripANSI(out), err: Bun.stripANSI(err) };
}

describe('kinu desktop share', () => {
  test("asks the daemon, and says the screen is shared once the portal's prompt was allowed", async () => {
    const home = scratchDir('desktop-share');

    standIn(home, `if (request?.request === 'share') fs.writeFileSync(file, JSON.stringify({ token: 'tok-1', width: 1280, height: 800, sharedAt: Date.now() }));`);
    const shared = await kinu(home, 'share');
    const asked = JSON.parse(readFileSync(join(home, 'signals'), 'utf8').trim());

    expect({ code: shared.code, said: shared.out.includes("This PC's screen is shared (1280×800)"), asked: asked.request }).toEqual({ code: 0, said: true, asked: 'share' });
  });

  test('says why when the person at the PC refused, and exits non-zero', async () => {
    const home = scratchDir('desktop-share-refused');

    standIn(home, `fs.writeFileSync(file, JSON.stringify({ failed: 'sharing was not allowed on this PC', at: Date.now() }));`);
    const refused = await kinu(home, 'share');

    expect({ code: refused.code, said: refused.err.includes('sharing was not allowed on this PC') }).toEqual({ code: 1, said: true });
  });

  test('unshare removes what the daemon kept, and says so', async () => {
    const home = scratchDir('desktop-unshare');

    writeFileSync(join(home, 'desktop.json'), JSON.stringify({ token: 'tok-1', width: 1280, height: 800 }));
    standIn(home, '');
    const stopped = await kinu(home, 'unshare');

    expect({ code: stopped.code, file: existsSync(join(home, 'desktop.json')), said: stopped.out.includes("This PC's screen is no longer shared") })
      .toEqual({ code: 0, file: false, said: true });
  });

  test('with no daemon running, says to connect the PC first', async () => {
    const lonely = await kinu(scratchDir('desktop-share-lonely'), 'share');

    expect({ code: lonely.code, said: lonely.err.includes('No Kinu daemon runs on this PC') }).toEqual({ code: 1, said: true });
  });
});
