/**
 * A Mac's screen source (1014-t), without a Mac: what a HELLO reports on a Mac too old for ScreenCaptureKit, one with
 * no compiler, and one ready to share; the share building the helper once and again only when its source changed; a
 * build's failure in the compiler's words; and the viewer's keys as macOS's key codes. The compiler is a stand-in
 * here, and the helper is the fake Linux tests use (fixtures/fake-screen-helper.js): their protocol is one. The
 * Swift helper itself is built and run by the Mac proof on the owner's machine.
 */
'use strict';

const fs = require('node:fs');

const path = require('node:path');

const { describe, expect, test } = require('bun:test');

const { scratchDir } = require('@kinu.run/test-utils');

const { createMacSource, macKeyCode } = require('../src/daemon/mac-screen.js');

const FAKE = path.join(__dirname, 'fixtures', 'fake-screen-helper.js');

/** A process that exited `code`, having said `said` on stderr. */
function exitedWith(code, said = '') {
  return { exited: Promise.resolve(code), stderr: new Response(said).body };
}

/**
 * A Mac's source on Darwin `release`, whose compiler answers as `compiler(argv)` says (null: it builds, writing the
 * binary) and whose helper is the fake, told `told`. Every compiler run is recorded.
 */
function mac({ release = '23.1.0', compiler = () => null, told = {} } = {}) {
  const home = scratchDir('mac-screen');
  const compiled = [];
  // Each helper started, so a test waits on its exit, never on a file's changes (linux-screen.test.js says why).
  const helpers = [];

  const spawn = (argv, options) => {
    if (argv[0] !== 'xcrun') {
      const helper = Bun.spawn(argv, { ...options, env: { ...process.env } });

      helpers.push(helper);

      return helper;
    }

    compiled.push(argv.slice(1, 3).join(' '));
    const answer = compiler(argv);

    if (answer !== null) return answer;

    if (argv[1] === 'swiftc') fs.writeFileSync(argv[argv.indexOf('-o') + 1], 'built', { mode: 0o700 });

    return exitedWith(0);
  };

  const made = createMacSource({
    home, log: () => {}, release, spawn, proven: true,
    command: (mode) => [process.execPath, FAKE, mode, JSON.stringify(told)],
  });

  return { made, home, compiled, helpers, file: path.join(home, 'desktop.json') };
}

describe("a Mac's screen source", () => {
  test('until the Mac proof has passed, a Mac shares nothing, whatever it has, and a share neither builds nor asks', async () => {
    const compiled = [];

    const spawn = (argv) => {
      compiled.push(argv.join(' '));

      return exitedWith(0);
    };

    const made = createMacSource({ home: scratchDir('mac-screen-unproven'), log: () => {}, release: '23.1.0', spawn });

    await made.probe();

    expect({ shared: await made.share(), desktop: made.desktop(), compiled }).toEqual({
      shared: { ok: false, why: 'the Mac screen helper has not passed the Mac proof yet' }, desktop: { state: 'none' }, compiled: [],
    });
  });

  test('a compiler installed after the daemon started is found by the next share', async () => {
    let installed = false;
    const { made } = mac({ compiler: () => (installed ? null : exitedWith(1, 'xcrun: error: unable to find utility "swiftc"')), told: { share: 'allow', token: 'permission', width: 3024, height: 1964 } });

    await made.probe();
    const before = made.desktop().detail;

    installed = true;

    expect({ before, shared: await made.share(), after: made.desktop() }).toEqual({
      before: 'Install the Command Line Tools (xcode-select --install), then run kinu desktop share on this Mac.',
      shared: { ok: true, why: '' }, after: { state: 'ready', width: 3024, height: 1964 },
    });
  });

  test('unsharing while the helper builds ends the share before it asks, and keeps nothing', async () => {
    const building = Promise.withResolvers();

    const { made, file, compiled } = mac({
      compiler: (argv) => (argv[1] === 'swiftc' ? { exited: building.promise, stderr: new Response('').body } : null),
      told: { share: 'allow', token: 'permission', width: 3024, height: 1964 },
    });

    await made.probe();
    const sharing = made.share();

    while (!compiled.includes('swiftc -O')) await new Promise((resolve) => { setImmediate(resolve); });

    fs.rmSync(file, { force: true });
    await made.reread();
    building.resolve(0);

    expect({ shared: await sharing, file: fs.existsSync(file) }).toEqual({ shared: { ok: false, why: 'sharing was turned off while the share was asked for' }, file: false });
  });

  test('a Mac older than ScreenCaptureKit shares nothing; one with no compiler names the step; one with it can share', async () => {
    const old = mac({ release: '20.6.0' });
    const bare = mac({ compiler: () => exitedWith(1, "xcrun: error: unable to find utility \"swiftc\", not a developer tool or in PATH") });
    const ready = mac();

    await Promise.all([old.made.probe(), bare.made.probe(), ready.made.probe()]);

    expect({ old: old.made.desktop(), bare: bare.made.desktop(), ready: ready.made.desktop() }).toEqual({
      old: { state: 'none' },
      bare: { state: 'setup', detail: 'Install the Command Line Tools (xcode-select --install), then run kinu desktop share on this Mac.' },
      ready: { state: 'setup', detail: expect.stringContaining('run `kinu desktop share` on it') },
    });
  });

  test("the share builds the helper once, asks macOS's prompts, and builds again only when nothing current is there", async () => {
    const { made, compiled, home } = mac({ told: { share: 'allow', token: 'permission', width: 3024, height: 1964 } });

    await made.probe();
    const first = await made.share();
    const again = await made.share();

    fs.writeFileSync(path.join(home, 'desktop', 'kinu-screen.sha256'), 'a source of another release\n');
    await made.share();

    expect({ first, again, desktop: made.desktop(), compiled }).toEqual({
      first: { ok: true, why: '' }, again: { ok: true, why: '' }, desktop: { state: 'ready', width: 3024, height: 1964 },
      compiled: ['--find swiftc', '--find swiftc', 'swiftc -O', '--find swiftc', '--find swiftc', 'swiftc -O'],
    });
  });

  test("a build that fails says so in the compiler's words, and the Mac stays unshared", async () => {
    const { made } = mac({ compiler: (argv) => (argv[1] === 'swiftc' ? exitedWith(1, "kinu-screen.swift:7:8: error: no such module 'ScreenCaptureKit'") : null) });

    await made.probe();

    expect({ shared: await made.share(), desktop: made.desktop().state }).toEqual({
      shared: { ok: false, why: "the screen helper did not build: kinu-screen.swift:7:8: error: no such module 'ScreenCaptureKit'" }, desktop: 'setup',
    });
  });

  test("a served Mac's screen takes the viewer's keys as macOS key codes, and drops a key it has no code for", async () => {
    const home = scratchDir('mac-screen-serve');
    const log = path.join(home, 'helper.log');
    const { made, file, helpers } = mac({ told: { accepts: 'permission', next: 'permission', width: 4, height: 2, frames: [], log } });

    fs.writeFileSync(file, JSON.stringify({ token: 'permission', width: 4, height: 2 }));
    const screen = await made.open({ onFrame: () => {}, onEnd: () => {} });

    screen.key(true, 0xffeb);
    screen.key(true, 0x43);
    screen.key(true, 0x20ac);
    screen.key(false, 0xffeb);
    screen.close();
    // Its stdin closed, the helper writes `closed` and exits; every line it wrote is in the log once it has.
    await helpers.at(-1)?.exited;
    const told = fs.readFileSync(log, 'utf8').trim().split('\n');

    expect(told).toEqual(['permission', '{"type":"key","code":55,"down":true}', '{"type":"key","code":8,"down":true}', '{"type":"key","code":55,"down":false}', 'closed']);
  });

  test('keysyms map to the ANSI layout: letters either case, shifted symbols to their key, and the special keys', () => {
    expect(['a', 'A', 'z', '!', '?', '~'].map((key) => macKeyCode(key.codePointAt(0))).concat([0xff0d, 0xff08, 0xff51, 0xffe1, 0xffe9, 0xffbe, 0x20ac].map(macKeyCode)))
      .toEqual([0, 0, 6, 18, 44, 50, 36, 51, 123, 56, 58, 122, null]);
  });
});
