// Kinu PC agent — a Linux PC's screen, from the desktop portal (1014-t).
//
// A helper in Python, run as `python3 -c`, holds a RemoteDesktop session of
// the desktop portal with the monitor's screen in it
// (org.freedesktop.portal.RemoteDesktop and ScreenCast), encodes what PipeWire
// gives it as JPEG with GStreamer, and forwards the viewer's keys and pointer
// back through the same session (the protocol is screen-helper.js's). The
// portal is the consent: the first time, someone at the PC allows sharing in
// its own prompt (`kinu desktop share` asks for it); the restore token it hands
// back opens the screen after that without asking, until the person revokes it.
//
// The helper ships inside the daemon file, not beside it: an updater lands
// only the files it already knew (packages/cli/src/daemon-build.ts).
'use strict';

const { createHelperSource } = require('./screen-helper.js');

const LINUX_SCREEN_PY = String.raw`
import ctypes, json, os, struct, sys

# Ends with the daemon that started it, which names itself after the mode (PR_SET_PDEATHSIG, SIGKILL): a daemon killed
# while this waited on the desktop portal left it running, its GStreamer scanner writing a cache under a home already
# removed (2026-10-21). A daemon gone before this line ran sends no signal, so this ends now.
ctypes.CDLL(None).prctl(1, 9)
if len(sys.argv) > 2 and os.getppid() != int(sys.argv[2]):
    sys.exit(1)

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

/** A Linux PC's screen source: the portal takes the viewer's keys as the X keysyms RFB carries. */
function createLinuxSource(options) {
  return createHelperSource({
    command: (mode) => ['python3', '-c', LINUX_SCREEN_PY, mode, String(process.pid)],
    keyCommand: (down, keysym) => ({ type: 'key', keysym, down }),
    ...options,
  });
}

module.exports = { createLinuxSource };
