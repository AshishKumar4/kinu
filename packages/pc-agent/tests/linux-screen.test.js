/**
 * A Linux PC's screen source (1014-t), against a helper that plays the desktop portal's protocol without a desktop
 * (fixtures/fake-screen-helper.js): what a HELLO reports before and after sharing, the share itself in the portal's
 * prompt, the token kept at 0600 and renewed on each start, frames to the viewer, and the viewer's keys, buttons and
 * wheel in the portal's terms. The real helper runs in a desktop session in scripts/linux-screen-proof.sh; here it
 * runs once, on a machine with no desktop, which it must say in words.
 */
'use strict';

const fs = require('node:fs');

const path = require('node:path');

const { describe, expect, test } = require('bun:test');

const { scratchDir } = require('@kinu.run/test-utils');

const { createLinuxSource } = require('../src/daemon/linux-screen.js');

const FAKE = path.join(__dirname, 'fixtures', 'fake-screen-helper.js');

/**
 * A source whose helper is the fake, told `told`; what it logs and each change it reports are recorded. Each helper
 * it starts is kept (`helpers`), and `reports(state)` resolves when the source reports that state. A test waits on
 * those, never on a file's changes: Bun's fs.watch dropped the fake's last write once in 40 runs under load (measured
 * 2026-10-20), and the wait on it hung the daemon suite's row for 480 s (tier of 0684889f9).
 */
function source(told, home = scratchDir('linux-screen')) {
  const logged = [];
  const changes = [];
  const helpers = [];
  const waiting = [];

  const made = createLinuxSource({
    home,
    log: (...words) => { logged.push(words.join(' ')); },
    onChange: () => {
      changes.push(made.desktop().state);

      for (const waiter of waiting.filter((each) => each.state === changes.at(-1))) waiter.resolve();
    },
    command: (mode) => [process.execPath, FAKE, mode, JSON.stringify(told)],
    spawn: (argv, options) => {
      const helper = Bun.spawn(argv, { ...options, env: { ...process.env } });

      helpers.push(helper);

      return helper;
    },
  });

  const reports = (state) => {
    const waiter = { state, ...Promise.withResolvers() };

    waiting.push(waiter);

    return waiter.promise;
  };

  return { made, home, logged, changes, helpers, reports, file: path.join(home, 'desktop.json') };
}

/** The lines the fake wrote to `log`, read once its helper has exited: every line it will write is there. */
async function linesOnceExited(helper, log) {
  await helper.exited;

  return fs.readFileSync(log, 'utf8').trim().split('\n');
}

describe("a Linux PC's screen source", () => {
  test('a PC that cannot share reports none and says why; one never shared names the step; a shared one is ready', async () => {
    const unable = source({ probe: { ok: false, why: 'the desktop portal shares no screen here (no graphical session)' } });

    await unable.made.probe();
    expect({ desktop: unable.made.desktop(), logged: unable.logged })
      .toEqual({ desktop: { state: 'none' }, logged: ['device.screen_unavailable the desktop portal shares no screen here (no graphical session)'] });

    const able = source({ probe: { ok: true } });

    await able.made.probe();
    expect(able.made.desktop()).toEqual({ state: 'setup', detail: expect.stringContaining('run `kinu desktop share` on it') });

    fs.writeFileSync(able.file, JSON.stringify({ token: 'tok-1', width: 1512, height: 982 }));
    expect(able.made.desktop()).toEqual({ state: 'ready', width: 1512, height: 982 });
  });

  test("sharing reports permission while the portal's prompt waits, then keeps the token it hands back at 0600", async () => {
    const { made, file, changes } = source({ probe: { ok: true }, share: 'allow', token: 'tok-1', width: 1280, height: 800 });

    await made.probe();
    fs.writeFileSync(file, JSON.stringify({ request: 'share', at: Date.now() }));
    const shared = await made.reread();
    const kept = JSON.parse(fs.readFileSync(file, 'utf8'));

    expect({ shared, changes, kept: { token: kept.token, width: kept.width, height: kept.height }, mode: (fs.statSync(file).mode & 0o777).toString(8) }).toEqual({
      shared: { ok: true, why: '' }, changes: ['setup', 'setup', 'permission', 'ready'], kept: { token: 'tok-1', width: 1280, height: 800 }, mode: '600',
    });
  });

  test('a refused share is said in the words it was refused in, and the PC stays unshared', async () => {
    const { made, file } = source({ probe: { ok: true }, share: 'refuse' });

    await made.probe();
    const shared = await made.share();

    expect({ shared, desktop: made.desktop().state, failed: JSON.parse(fs.readFileSync(file, 'utf8')).failed }).toEqual({
      shared: { ok: false, why: 'sharing was not allowed on this PC' }, desktop: 'setup', failed: 'sharing was not allowed on this PC',
    });
  });

  test("a served screen draws the helper's frames, gives it the viewer's input in the portal's terms, and keeps each new token", async () => {
    const home = scratchDir('linux-screen-serve');
    const log = path.join(home, 'helper.log');
    const { made, file, helpers } = source({ accepts: 'tok-1', next: 'tok-2', width: 4, height: 2, frames: [{ width: 4, height: 2, jpeg: 'ffd8ffd9' }], log }, home);
    const drawn = Promise.withResolvers();

    fs.writeFileSync(file, JSON.stringify({ token: 'tok-1', width: 4, height: 2 }));
    const screen = await made.open({ onFrame: drawn.resolve, onEnd: () => {} });
    const frame = await drawn.promise;

    screen.key(true, 0x61);
    // Left button down at (3, 1); up with the wheel turning up; then a KasmVNC wheel delta down.
    screen.pointer(1, 3, 1, { x: 0, y: 0 });
    screen.pointer(8, 3, 1, { x: 0, y: 0 });
    screen.pointer(0, 3, 1, { x: 0, y: 120 });
    screen.close();
    // Its stdin closed, the helper writes `closed` and exits; one the source had to kill wrote no `closed`.
    const lines = await linesOnceExited(helpers[0], log);

    expect({
      screen: { width: screen.width, height: screen.height },
      frame: { serial: frame.serial, width: frame.width, height: frame.height, jpeg: frame.jpeg.toString('hex') },
      told: lines.map((line) => (line.startsWith('{') ? JSON.parse(line) : line)),
      token: JSON.parse(fs.readFileSync(file, 'utf8')).token,
    }).toEqual({
      screen: { width: 4, height: 2 },
      frame: { serial: 1, width: 4, height: 2, jpeg: 'ffd8ffd9' },
      told: [
        'tok-1',
        { type: 'key', keysym: 0x61, down: true },
        { type: 'motion', x: 3, y: 1 }, { type: 'button', button: 0x110, down: true },
        { type: 'motion', x: 3, y: 1 }, { type: 'button', button: 0x110, down: false }, { type: 'scroll', axis: 0, steps: -1 },
        { type: 'motion', x: 3, y: 1 }, { type: 'scroll', axis: 0, steps: 1 },
        'closed',
      ],
      token: 'tok-2',
    });
  });

  test('a token the portal no longer honours ends the open in words; a helper that fails mid-stream ends it with why', async () => {
    const home = scratchDir('linux-screen-refused');
    const refused = source({ accepts: 'another', log: path.join(home, 'helper.log') }, home);

    fs.writeFileSync(refused.file, JSON.stringify({ token: 'tok-1', width: 4, height: 2 }));
    await expect(refused.made.open({ onFrame: () => {}, onEnd: () => {} })).rejects.toThrow('sharing was not allowed on this PC');

    const failingHome = scratchDir('linux-screen-failing');
    const failing = source({ accepts: 'tok-1', next: 'tok-2', width: 4, height: 2, frames: [], fail: 'the screen stream failed: PipeWire went away', log: path.join(failingHome, 'helper.log') }, failingHome);
    const ended = Promise.withResolvers();

    fs.writeFileSync(failing.file, JSON.stringify({ token: 'tok-1', width: 4, height: 2 }));
    await failing.made.open({ onFrame: () => {}, onEnd: ended.resolve });
    expect(await ended.promise).toBe('the screen stream failed: PipeWire went away');
  });

  test('unsharing while the prompt is up ends the share, keeps nothing, and the PC reads as shareable', async () => {
    const { made, file, reports } = source({ probe: { ok: true }, share: 'waits' });
    const asking = reports('permission');

    await made.probe();
    const sharing = made.share();

    // The prompt is up once the helper says it is asking, which the source reports as permission.
    await asking;
    fs.rmSync(file, { force: true });
    await made.reread();

    expect({ shared: await sharing, file: fs.existsSync(file), desktop: made.desktop() }).toEqual({
      shared: { ok: false, why: 'sharing was turned off while the share was asked for' }, file: false, desktop: { state: 'setup', detail: expect.any(String) },
    });
  });

  test("a share the portal allows but keeps no token for is not kept, and says why", async () => {
    const { made } = source({ probe: { ok: true }, share: 'allow', token: '', width: 1280, height: 800 });

    await made.probe();

    expect({ shared: await made.share(), desktop: made.desktop().state }).toEqual({
      shared: { ok: false, why: 'this desktop allowed sharing once but keeps no share to restore, so each open would ask again' }, desktop: 'setup',
    });
  });

  test('a restore the person at the PC refuses revokes the share, and the PC reads as shareable', async () => {
    const home = scratchDir('linux-screen-revoked');
    const { made, file, changes } = source({ probe: { ok: true }, accepts: 'another', log: path.join(home, 'helper.log') }, home);

    await made.probe();
    fs.writeFileSync(file, JSON.stringify({ token: 'tok-1', width: 4, height: 2 }));
    await expect(made.open({ onFrame: () => {}, onEnd: () => {} })).rejects.toThrow('sharing was not allowed on this PC');

    expect({ desktop: made.desktop().state, changes: changes.slice(1) }).toEqual({ desktop: 'setup', changes: ['permission', 'setup'] });
  });

  test('a frame the helper draws before it says it is ready is the screen\'s first, not dropped', async () => {
    const home = scratchDir('linux-screen-early');
    const { made, file } = source({ accepts: 'tok-1', next: 'tok-2', width: 4, height: 2, early: { width: 4, height: 2, jpeg: 'ffd8ffd9' }, frames: [], log: path.join(home, 'helper.log') }, home);
    const drawn = Promise.withResolvers();

    fs.writeFileSync(file, JSON.stringify({ token: 'tok-1', width: 4, height: 2 }));
    const screen = await made.open({ onFrame: drawn.resolve, onEnd: () => {} });
    const frame = await drawn.promise;

    screen.close();
    expect({ serial: frame.serial, jpeg: frame.jpeg.toString('hex') }).toEqual({ serial: 1, jpeg: 'ffd8ffd9' });
  });

  test('a PC never shared opens nothing, and says how to share it', () => {
    const { made } = source({});

    expect(() => made.open({ onFrame: () => {}, onEnd: () => {} })).toThrow("this PC's screen is not shared: Share this PC's screen once: run `kinu desktop share` on it");
  });

  test('the real helper, on a machine with no desktop session, reports none and says why', async () => {
    const logged = [];

    const made = createLinuxSource({
      home: scratchDir('linux-screen-real'),
      log: (...words) => { logged.push(words.join(' ')); },
      spawn: (argv, options) => Bun.spawn(argv, { ...options, env: { PATH: process.env.PATH ?? '', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/kinu-bus' } }),
    });

    const probed = await made.probe();

    expect({ desktop: made.desktop(), probed: probed.ok, said: logged.length === 1 && logged[0].startsWith('device.screen_unavailable ') && logged[0].length > 'device.screen_unavailable '.length })
      .toEqual({ desktop: { state: 'none' }, probed: false, said: true });
  });
});
