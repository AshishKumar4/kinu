// Kinu PC agent — a PC's screen from a helper process of its own system (1014-t).
//
// The daemon serves RFB itself (screen.js); a source gives it frames. Linux's
// and macOS's come from a helper the daemon runs: the desktop portal's on
// Linux (linux-screen.js), ScreenCaptureKit's on a Mac (mac-screen.js). Both
// speak one protocol on stdio, so this file is the source for either: its
// stdout is records, each a big-endian u32 length, a kind byte, then the
// record, JSON or a frame's u16 width and height and its JPEG; its stdin is
// the restore token on the first line when serving, then one command a line.
// A share is the system's own consent, asked once in its own prompt; the
// system shows its screen-sharing indicator while a stream is open.
'use strict';

const fs = require('node:fs');

const os = require('node:os');

const path = require('node:path');

const RECORD = { event: 0, frame: 1 };

/** A person has this long to answer the portal's prompt before the share is given up. */
const SHARE_PROMPT_MS = 180_000;

/** A served screen whose token the portal no longer honours asks the person at the PC again; past this it is ended. */
const SERVE_START_MS = 60_000;

const PROBE_MS = 15_000;

/** After its stdin closes the helper closes the portal session and exits; past this it is killed. */
const HELPER_GRACE_MS = 5_000;

const SHARE_STEP = 'Share this PC\'s screen once: run `kinu desktop share` on it, and allow it in the prompt there.';

/** The portal's Start allowed, but handed back no restore token: every open would ask the person at the PC again. */
const NOT_KEPT = 'this desktop allowed sharing once but keeps no share to restore, so each open would ask again';

const TURNED_OFF = 'sharing was turned off while the share was asked for';

/** The helper's exit when the person at the PC refused, in the portal's prompt. */
const REFUSED_EXIT = 3;

/** evdev's codes for RFB's first three buttons: left, middle, right. */
const BUTTONS = [0x110, 0x112, 0x111];

/** RFB's wheel buttons: up and down on the vertical axis, left and right on the horizontal. */
const WHEEL = [{ bit: 3, axis: 0, steps: -1 }, { bit: 4, axis: 0, steps: 1 }, { bit: 5, axis: 1, steps: -1 }, { bit: 6, axis: 1, steps: 1 }];

function afterTimer(ms, fn) {
  const timer = setTimeout(fn, ms);

  return () => clearTimeout(timer);
}

/** The helper's stdout read as its records, each handed to `onRecord(kind, bytes)`. */
async function readRecords(stdout, onRecord) {
  let pending = Buffer.alloc(0);

  for await (const chunk of stdout) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);

    while (pending.byteLength >= 5 && pending.byteLength >= 5 + pending.readUInt32BE(0)) {
      const length = pending.readUInt32BE(0);

      onRecord(pending[4], pending.subarray(5, 5 + length));
      pending = pending.subarray(5 + length);
    }
  }
}

/** What `kinu desktop share` left: a token and the screen's size, a request to share, or a share that failed; null
 *  when there is no file, sharing off. */
function readShared(file) {
  try {
    const shared = JSON.parse(fs.readFileSync(file, 'utf8'));

    return shared !== null && typeof shared === 'object' ? shared : {};
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;

    return {};
  }
}

function writeShared(file, shared) {
  const temporary = `${file}.${process.pid}.tmp`;

  fs.writeFileSync(temporary, `${JSON.stringify(shared)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function tokenOf(shared) {
  return typeof shared?.token === 'string' && Number.isInteger(shared.width) && Number.isInteger(shared.height) ? shared : null;
}

/**
 * A screen source for screen.js, driven by a helper process of this system's
 * own (`command(mode)`, its argv). `home` is the daemon's own directory, where
 * `desktop.json` keeps what the share left at 0600; `onChange` is told whenever
 * what the HELLO reports changes. `keyCommand(down, keysym)` is a key in the
 * helper's terms, or null for one it has no key for. A system may decide by
 * itself whether it can share (`probe`) and get its helper ready to ask
 * (`prepare`).
 */
function createHelperSource({
  home, log, command, keyCommand, onChange = () => {}, after = afterTimer, spawn = Bun.spawn,
  probe: probeSystem = null, prepare = async () => ({ ok: true, why: '' }),
}) {
  const file = path.join(home, 'desktop.json');
  let probed = { ok: false, why: 'not probed yet' };
  let asking = false;
  let sharing = null;
  // Every helper running, so none outlives `dispose`; and the share's generation, which unsharing ends, so a helper
  // that answers after it keeps nothing.
  const helpers = new Set();
  let generation = 0;

  /** One helper run: its process, and its records as they come. */
  function run(mode, { onEvent, onFrame = () => {} }) {
    const child = spawn(command(mode), { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const said = [];

    const forget = () => { helpers.delete(child); };

    helpers.add(child);
    child.exited.then(forget, forget);

    const records = readRecords(child.stdout, (kind, bytes) => {
      if (kind === RECORD.frame) return onFrame(bytes);

      if (kind !== RECORD.event) return;
      const event = JSON.parse(bytes.toString('utf8'));

      said.push(event);
      onEvent(event);
    });

    const exited = Promise.all([child.exited, records, new Response(child.stderr).text()]).then(([code, , stderr]) => {
      const failed = said.find((event) => event.type === 'failed');
      const last = stderr.trim().split('\n').pop() ?? '';

      return { code, why: failed?.why ?? (last === '' ? `the screen helper exited ${code}` : last) };
    });

    return { child, exited };
  }

  function send(child, line) {
    try {
      child.stdin.write(line);
    } catch (err) {
      log('device.screen_input_unsent', err instanceof Error ? err.message : String(err));
    }
  }

  function stop(child) {
    try {
      child.stdin.end();
    } catch (err) {
      log('device.screen_helper_stdin', err instanceof Error ? err.message : String(err));
    }

    after(HELPER_GRACE_MS, () => child.kill());
  }

  function failShare(why) {
    writeShared(file, { failed: why, at: Date.now() });
    log('device.screen_share_failed', why);

    return { ok: false, why };
  }

  function setAsking(now) {
    if (asking === now) return;
    asking = now;
    onChange();
  }

  /** The viewer's pointer as the portal takes it: a position, each RFB button that changed, a wheel turn. */
  function pointerCommands(previous, { buttons, x, y, wheel }) {
    const commands = [{ type: 'motion', x, y }];

    for (const [bit, button] of BUTTONS.entries()) {
      if (((buttons ^ previous) >> bit) & 1) commands.push({ type: 'button', button, down: ((buttons >> bit) & 1) === 1 });
    }

    // A wheel button counts once, as it goes down.
    for (const turn of WHEEL) {
      if (((buttons & ~previous) >> turn.bit) & 1) commands.push({ type: 'scroll', axis: turn.axis, steps: turn.steps });
    }

    if (wheel.y !== 0) commands.push({ type: 'scroll', axis: 0, steps: Math.sign(wheel.y) });

    if (wheel.x !== 0) commands.push({ type: 'scroll', axis: 1, steps: Math.sign(wheel.x) });

    return commands;
  }

  return {
    /** What a HELLO reports (screen.js's `desktop()`). */
    desktop() {
      if (asking) return { state: 'permission' };

      // A step on the PC before it can share at all, as a Mac with no compiler has.
      if (!probed.ok) return probed.setup === undefined ? { state: 'none' } : { state: 'setup', detail: probed.setup };
      const shared = tokenOf(readShared(file));

      return shared === null ? { state: 'setup', detail: SHARE_STEP } : { state: 'ready', width: shared.width, height: shared.height };
    },

    /** Whether this machine can share a screen at all, as its system decides, or its helper's `probe` says. */
    async probe() {
      if (probeSystem !== null) {
        probed = await probeSystem();

        if (!probed.ok) log('device.screen_unavailable', probed.why);
        onChange();

        return probed;
      }

      let answer = null;
      let helper;

      try {
        helper = run('probe', { onEvent: (event) => { if (event.type === 'probed') answer = { ok: event.ok === true, why: event.why ?? '' }; } });
      } catch (err) {
        // No Python at all: the machine shares no screen, and says why.
        helper = { child: { kill: () => {} }, exited: Promise.resolve({ code: -1, why: `the screen helper did not start: ${err instanceof Error ? err.message : String(err)}` }) };
      }

      const cancel = after(PROBE_MS, () => helper.child.kill());
      const { why } = await helper.exited;

      cancel();
      probed = answer ?? { ok: false, why };

      if (!probed.ok) log('device.screen_unavailable', probed.why);
      onChange();

      return probed;
    },

    /** `kinu desktop share`'s signal: a request in desktop.json shares, and no file stops sharing, a share still
     *  waiting on the portal's prompt and every served screen included. */
    async reread() {
      const shared = readShared(file);

      if (shared?.request === 'share') return await this.share();

      if (shared === null) this.dispose();
      onChange();

      return { ok: tokenOf(shared) !== null, why: '' };
    },

    /** Ends every helper; what any of them answers after this is not kept. */
    dispose() {
      generation += 1;

      for (const child of helpers) child.kill();
    },

    /** Asks the person at the PC, in the portal's prompt, to allow sharing; keeps the token it hands back. */
    share() {
      if (sharing !== null) return sharing;
      const at = generation;

      // The system is asked again first: a step the PC named (a compiler installed since) may be done now.
      sharing = this.probe()
        .then(async (found) => (found.ok ? await prepare() : { ok: false, why: found.why }))
        .then((ready) => {
          if (generation !== at) return { ok: false, why: TURNED_OFF };

          return ready.ok ? this.ask(at) : failShare(ready.why);
        })
        .finally(() => {
          sharing = null;
          setAsking(false);
        });

      return sharing;
    },

    /** The share's own prompt, once the helper is ready to show it; `at` is the share's generation. */
    ask(at) {
      let kept = false;

      const helper = run('share', {
        onEvent: (event) => {
          if (event.type === 'asking') setAsking(true);

          if (event.type !== 'ready' || event.token === '' || generation !== at) return;
          writeShared(file, { token: event.token, width: event.width, height: event.height, sharedAt: Date.now() });
          kept = true;
        },
      });

      const cancel = after(SHARE_PROMPT_MS, () => helper.child.kill());

      return helper.exited.then(({ code, why }) => {
        cancel();

        // Unshared while the prompt was up: nothing is kept, and nothing is said in desktop.json, which is gone.
        if (generation !== at) return { ok: false, why: TURNED_OFF };

        if (code === 0 && kept) {
          log('device.screen_shared', '');

          return { ok: true, why: '' };
        }

        return failShare(code === 0 ? NOT_KEPT : why);
      });
    },

    /** A served screen, for one viewer: frames to `onFrame`, and its end, with why, to `onEnd`. */
    open({ onFrame, onEnd }) {
      const shared = tokenOf(readShared(file));

      if (shared === null) throw new Error(`this PC's screen is not shared: ${SHARE_STEP}`);
      const at = generation;
      let serial = 0;
      let mask = 0;
      let screen = null;
      let closed = false;

      return new Promise((resolve, reject) => {
        const helper = run('serve', {
          onEvent: (event) => {
            // The portal no longer honours the token and asks the person at the PC again.
            if (event.type === 'asking') return setAsking(true);

            if (event.type !== 'ready' || screen !== null) return;
            cancelStart();
            setAsking(false);

            if (generation !== at) {
              stop(helper.child);

              return reject(new Error('sharing was turned off while the screen opened'));
            }

            // Each start spends the token and hands back the one the next restores with; none means the next would
            // ask again, so the PC reads as shareable, not shared, once this screen closes.
            writeShared(file, event.token === '' ? { failed: NOT_KEPT, at: Date.now() } : { ...shared, token: event.token, width: event.width, height: event.height });

            if (event.token === '') onChange();

            screen = {
              width: event.width,
              height: event.height,
              name: os.hostname(),
              key: (down, keysym) => {
                const key = keyCommand(down, keysym);

                if (key !== null) send(helper.child, `${JSON.stringify(key)}\n`);
              },
              pointer: (buttons, x, y, wheel) => {
                const lines = pointerCommands(mask, { buttons, x, y, wheel }).map((line) => `${JSON.stringify(line)}\n`);

                mask = buttons;
                send(helper.child, lines.join(''));
              },
              close: () => {
                closed = true;
                stop(helper.child);
              },
            };
            resolve(screen);
          },
          // A frame the helper drew before it said it was ready (a Mac's can) is the screen's first, not dropped.
          onFrame: (bytes) => {
            if (closed) return;
            serial += 1;
            onFrame({ serial, width: bytes.readUInt16BE(0), height: bytes.readUInt16BE(2), jpeg: bytes.subarray(4) });
          },
        });

        const cancelStart = after(SERVE_START_MS, () => {
          if (screen === null) helper.child.kill();
        });

        send(helper.child, `${shared.token}\n`);
        helper.exited.then(({ code, why }) => {
          cancelStart();
          // Refused when the portal asked again: the share is revoked, and the PC reads as shareable.
          const revoked = screen === null && code === REFUSED_EXIT && generation === at;

          if (revoked) writeShared(file, { failed: why, at: Date.now() });

          if (asking) setAsking(false);
          else if (revoked) onChange();

          if (screen === null) reject(new Error(why));
          else if (!closed) onEnd(why);
        }, reject);
      });
    },
  };
}

module.exports = { createHelperSource };
