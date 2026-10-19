// Kinu PC agent — a Linux PC's screen, from the desktop portal (1014-t).
//
// The daemon serves RFB itself (screen.js); this is where its frames come
// from on Linux. A helper in Python, run as `python3 -c`, holds a
// RemoteDesktop session of the desktop portal with the monitor's screen in it
// (org.freedesktop.portal.RemoteDesktop and ScreenCast), encodes what PipeWire
// gives it as JPEG with GStreamer, and forwards the viewer's keys and pointer
// back through the same session. The portal is the consent: the first time,
// someone at the PC allows sharing in its own prompt (`kinu desktop share`
// asks for it); the restore token it hands back opens the screen after that
// without asking, until the person revokes it. The system shows its own
// screen-sharing indicator while a stream is open.
//
// The helper ships inside the daemon file, not beside it: an updater lands
// only the files it already knew (packages/cli/src/daemon-build.ts).
'use strict';

const fs = require('node:fs');

const os = require('node:os');

const path = require('node:path');

/** Its stdout: each record a big-endian u32 length, a kind byte, then the record: JSON, or a frame's u16 width and
 *  height and its JPEG. Its stdin: the restore token on the first line when serving, then one command a line. */
const LINUX_SCREEN_PY = String.raw`
import json, os, struct, sys
import gi
gi.require_version('Gio', '2.0')
gi.require_version('Gst', '1.0')
from gi.repository import Gio, GLib, Gst

PORTAL = 'org.freedesktop.portal.Desktop'
PORTAL_PATH = '/org/freedesktop/portal/desktop'
SCREEN_CAST = 'org.freedesktop.portal.ScreenCast'
REMOTE = 'org.freedesktop.portal.RemoteDesktop'
KEYBOARD_AND_POINTER = 3
MONITOR = 1
CURSOR_EMBEDDED = 2
PERSIST_UNTIL_REVOKED = 2
EVENT, FRAME = 0, 1
FRAMES_PER_SECOND = 15
JPEG_QUALITY = 70

out = sys.stdout.buffer
loop = GLib.MainLoop()
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
sender = bus.get_unique_name()[1:].replace('.', '_')
calls = [0]


def say(event):
    payload = json.dumps(event).encode()
    out.write(struct.pack('>IB', len(payload), EVENT) + payload)
    out.flush()


def fail(why, code=1):
    say({'type': 'failed', 'why': why})
    sys.exit(code)


def portal(interface, method, params, reply='(o)', fds=None):
    if fds is None:
        return bus.call_sync(PORTAL, PORTAL_PATH, interface, method, params, GLib.VariantType(reply), Gio.DBusCallFlags.NONE, 30000, None)
    return bus.call_with_unix_fd_list_sync(PORTAL, PORTAL_PATH, interface, method, params, GLib.VariantType(reply), Gio.DBusCallFlags.NONE, 30000, fds, None)


def request(interface, method, leading, options):
    """A portal call answered by its Request's Response signal: (code, results). 0 granted, 1 refused, 2 failed."""
    calls[0] += 1
    token = 'kinu%d' % calls[0]
    path = '%s/request/%s/%s' % (PORTAL_PATH, sender, token)
    answer = {}

    def on_response(_conn, _sender, _path, _iface, _signal, params):
        answer['code'], answer['results'] = params.unpack()
        loop.quit()

    watch = bus.signal_subscribe(PORTAL, 'org.freedesktop.portal.Request', 'Response', path, None, Gio.DBusSignalFlags.NO_MATCH_RULE, on_response)
    options = dict(options, handle_token=GLib.Variant('s', token))
    signature = '(%sa{sv})' % ''.join(kind for kind, _ in leading)
    portal(interface, method, GLib.Variant(signature, tuple(value for _, value in leading) + (options,)))
    loop.run()
    bus.signal_unsubscribe(watch)
    return answer['code'], answer['results']


def property_of(interface, name):
    reply = bus.call_sync(PORTAL, PORTAL_PATH, 'org.freedesktop.DBus.Properties', 'Get', GLib.Variant('(ss)', (interface, name)), GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 5000, None)
    return reply.unpack()[0]


def probe():
    try:
        Gst.init(None)
        if Gst.ElementFactory.find('pipewiresrc') is None or Gst.ElementFactory.find('jpegenc') is None:
            return {'ok': False, 'why': 'GStreamer has no pipewiresrc or jpegenc (gstreamer1.0-pipewire, gstreamer1.0-plugins-good)'}
        if not property_of(SCREEN_CAST, 'AvailableSourceTypes') & MONITOR:
            return {'ok': False, 'why': 'the desktop portal shares no screen here (no graphical session)'}
        if not property_of(REMOTE, 'AvailableDeviceTypes') & KEYBOARD_AND_POINTER:
            return {'ok': False, 'why': 'the desktop portal offers no remote keyboard and pointer here'}
    except GLib.Error as error:
        return {'ok': False, 'why': 'the desktop portal did not answer: %s' % error.message}
    return {'ok': True}


def start(restore):
    """A RemoteDesktop session with the monitor's screen in it, restored from the token in restore when it holds one, else
    allowed by someone at the PC in the portal's own prompt."""
    code, results = request(REMOTE, 'CreateSession', [], {'session_handle_token': GLib.Variant('s', 'kinu')})
    if code != 0:
        fail('the desktop portal opened no session (%d)' % code)
    session = results['session_handle']
    devices = {'types': GLib.Variant('u', KEYBOARD_AND_POINTER), 'persist_mode': GLib.Variant('u', PERSIST_UNTIL_REVOKED)}
    if restore:
        devices['restore_token'] = GLib.Variant('s', restore)
    if request(REMOTE, 'SelectDevices', [('o', session)], devices)[0] != 0:
        fail('the desktop portal refused the keyboard and pointer')
    sources = {'types': GLib.Variant('u', MONITOR), 'cursor_mode': GLib.Variant('u', CURSOR_EMBEDDED)}
    if request(SCREEN_CAST, 'SelectSources', [('o', session)], sources)[0] != 0:
        fail('the desktop portal refused the screen')
    say({'type': 'asking'})
    code, results = request(REMOTE, 'Start', [('o', session), ('s', '')], {})
    if code == 1:
        fail('sharing was not allowed on this PC', 3)
    if code != 0 or not results.get('streams'):
        fail('the desktop portal started no screen (%d)' % code)
    node, properties = results['streams'][0]
    width, height = properties.get('size', (0, 0))
    return session, node, width, height, results.get('restore_token', '')


def serve(session, node, logical, commands):
    fds = Gio.UnixFDList.new()
    reply, received = portal(SCREEN_CAST, 'OpenPipeWireRemote', GLib.Variant('(oa{sv})', (session, {})), '(h)', fds)
    fd = received.get(reply.unpack()[0])
    Gst.init(None)
    pipeline = Gst.parse_launch(
        'pipewiresrc fd=%d path=%d always-copy=true ! videoconvert ! videorate max-rate=%d ! jpegenc quality=%d '
        '! appsink name=sink emit-signals=true max-buffers=1 drop=true' % (fd, node, FRAMES_PER_SECOND, JPEG_QUALITY))
    size = {'frame': logical}

    def on_sample(sink):
        sample = sink.emit('pull-sample')
        caps = sample.get_caps().get_structure(0)
        width, height = caps.get_value('width'), caps.get_value('height')
        size['frame'] = (width, height)
        jpeg = sample.get_buffer().extract_dup(0, sample.get_buffer().get_size())
        out.write(struct.pack('>IBHH', len(jpeg) + 4, FRAME, width, height) + jpeg)
        out.flush()
        return Gst.FlowReturn.OK

    pipeline.get_by_name('sink').connect('new-sample', on_sample)

    def on_message(_bus, message):
        if message.type == Gst.MessageType.ERROR:
            error, _ = message.parse_error()
            say({'type': 'failed', 'why': 'the screen stream failed: %s' % error.message})
            loop.quit()
        elif message.type == Gst.MessageType.EOS:
            loop.quit()

    watch = pipeline.get_bus()
    watch.add_signal_watch()
    watch.connect('message', on_message)

    def notify(method, signature, values):
        bus.call(PORTAL, PORTAL_PATH, REMOTE, method, GLib.Variant(signature, (session, {}) + values), None, Gio.DBusCallFlags.NONE, 5000, None, None, None)

    def on_input(stream, result):
        line = stream.read_line_finish_utf8(result)[0]
        if line is None:
            loop.quit()
            return
        command = json.loads(line)
        kind = command['type']
        if kind == 'key':
            notify('NotifyKeyboardKeysym', '(oa{sv}iu)', (command['keysym'], 1 if command['down'] else 0))
        elif kind == 'motion':
            frame_width, frame_height = size['frame']
            x = command['x'] * logical[0] / max(frame_width, 1)
            y = command['y'] * logical[1] / max(frame_height, 1)
            notify('NotifyPointerMotionAbsolute', '(oa{sv}udd)', (node, x, y))
        elif kind == 'button':
            notify('NotifyPointerButton', '(oa{sv}iu)', (command['button'], 1 if command['down'] else 0))
        elif kind == 'scroll':
            notify('NotifyPointerAxisDiscrete', '(oa{sv}ui)', (command['axis'], command['steps']))
        stream.read_line_async(GLib.PRIORITY_DEFAULT, None, on_input)

    commands.read_line_async(GLib.PRIORITY_DEFAULT, None, on_input)
    pipeline.set_state(Gst.State.PLAYING)
    loop.run()
    pipeline.set_state(Gst.State.NULL)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    if mode == 'probe':
        say({'type': 'probed', **probe()})
        return
    if mode not in ('share', 'serve'):
        fail('usage: share | serve, with the restore token on the first line of stdin')
    # One reader for all of stdin: the token, then the viewer's input, each a line.
    commands = Gio.DataInputStream.new(Gio.UnixInputStream.new(0, False))
    restore = (commands.read_line_utf8(None)[0] or '').strip() if mode == 'serve' else ''
    session, node, width, height, token = start(restore)
    say({'type': 'ready', 'width': width, 'height': height, 'token': token})
    try:
        if mode == 'serve':
            serve(session, node, (width, height), commands)
    finally:
        bus.call_sync(PORTAL, session, 'org.freedesktop.portal.Session', 'Close', None, None, Gio.DBusCallFlags.NONE, 5000, None)


main()
`;

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
 * The Linux screen source for screen.js. `home` is the daemon's own directory,
 * where `desktop.json` keeps the portal's restore token at 0600; `onChange` is
 * told whenever what the HELLO reports changes. `command(mode)` is the helper's
 * argv, a fake's in tests.
 */
function createLinuxSource({
  home, log, onChange = () => {}, after = afterTimer, spawn = Bun.spawn,
  command = (mode) => ['python3', '-c', LINUX_SCREEN_PY, mode],
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

      if (!probed.ok) return { state: 'none' };
      const shared = tokenOf(readShared(file));

      return shared === null ? { state: 'setup', detail: SHARE_STEP } : { state: 'ready', width: shared.width, height: shared.height };
    },

    /** Whether this machine can share a screen at all: Python, GStreamer's PipeWire source and a desktop portal. */
    async probe() {
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

      sharing = helper.exited.then(({ code, why }) => {
        cancel();

        // Unshared while the prompt was up: nothing is kept, and nothing is said in desktop.json, which is gone.
        if (generation !== at) return { ok: false, why: 'sharing was turned off while the prompt was up' };
        const ok = code === 0 && kept;
        const said = code === 0 && !kept ? NOT_KEPT : why;

        if (!ok) writeShared(file, { failed: said, at: Date.now() });
        log(ok ? 'device.screen_shared' : 'device.screen_share_failed', ok ? '' : said);

        return { ok, why: ok ? '' : said };
      }).finally(() => {
        sharing = null;
        setAsking(false);
      });

      return sharing;
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
              key: (down, keysym) => send(helper.child, `${JSON.stringify({ type: 'key', keysym, down })}\n`),
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
          onFrame: (bytes) => {
            if (screen === null || closed) return;
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

module.exports = { createLinuxSource };
