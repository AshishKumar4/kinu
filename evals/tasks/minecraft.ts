import * as v from 'valibot';
import { parseSync, type Argument, type ArrayExpressionElement, type CallExpression, type Directive, type Expression, type Statement } from 'oxc-parser';
import { JsonValueSchema, WORKSPACE_ROOT, type JsonValue } from '@kinu.run/core';
import { DESKTOP_MEMBERS } from '../../packages/core/src/execution/desktop';
import { BOX_CHROMIUM_POLICY, BOX_CHROMIUM_POLICY_KEYS, CHROMIUM_POLICIES, DESKTOP_CHECK, DESKTOP_LOG } from '../../packages/devbox/src/desktop';
import type { EvalCheck, EvalPart, PrepareCommand, TrialBox } from '../src/task';
import type { EvalCheckOutcome, EvalVerifier } from '../src/verifier';
import { renderThrownChain } from '@kinu.run/core/obs';

// Minecraft Classic on the agent's own desktop, played by hand: every move a desktop action the agent chose from what it
// saw. The box enforces the hand: the game's keys only, no typing, developer tools off, no page but the game's, and no
// menu or launcher that starts a program. The grader reads the game's own save for the tower, and the box for anything
// that ran beside the desktop and the browser.

const GAME = 'https://classic.minecraft.net';

/** The benchmark's own corner of the box: root's alone, and outside what the box audit reads. */
const EVAL = '/var/lib/kinu-eval';

const PROFILE = `${EVAL}/minecraft`;

const BASE = `${EVAL}/baseline`;

/** The screen sampled through the trial, a thumbnail every {@link FRAME_EVERY_SECONDS}, for the frame strip its evidence keeps. */
const FRAMES = `${EVAL}/frames`;

const FRAME_EVERY_SECONDS = 20;

/** Where the grader leaves the trial's pictures in its workspace, so its evidence keeps them (`gatherEvidence`). */
const PICTURES = `${WORKSPACE_ROOT}/eval-minecraft`;

/** The benchmark's own policy file, beside the box's (`BOX_CHROMIUM_POLICY`, the trust); no key is in both. */
const POLICY = `${CHROMIUM_POLICIES}/eval-minecraft.json`;

/** The keys the game reads (its bindings: walk, jump, crouch, a block by its number, the block menu, render distance,
 *  respawn, inventory, the pointer's release, chat), each as the desktop spells it. Nothing else reaches the box. */
const GAME_KEYS = ['w', 'a', 's', 'd', 'b', 'f', 'r', 'e', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'space', 'shift', 'escape', 'return'];

/** Names a model writes for a game key, as the desktop reads them (`desktopChord`). */
const KEY_ALIASES = new Map([['esc', 'escape'], ['enter', 'return'], ['shift_l', 'shift'], ['shift_r', 'shift']]);

/** The policy the game's browser starts under. */
const BROWSER_POLICY = {
  DeveloperToolsAvailability: 2,
  RemoteDebuggingAllowed: false,
  URLBlocklist: ['*'],
  URLAllowlist: [GAME],
  DownloadRestrictions: 3,
  AllowFileSelectionDialogs: false,
  ExtensionInstallBlocklist: ['*'],
  PrintingEnabled: false,
  IncognitoModeAvailability: 1,
  BrowserGuestModeEnabled: false,
  BrowserAddPersonEnabled: false,
  TaskManagerEndProcessEnabled: false,
};

/** Openbox's bindings without a menu on the root window or a key or button that starts a program. */
const OPENBOX_PY = String.raw`import sys
import xml.etree.ElementTree as ET
NS = 'http://openbox.org/3.4/rc'
ET.register_namespace('', NS)
path = sys.argv[1]
tree = ET.parse(path)
for parent in tree.getroot().iter():
    for child in list(parent):
        if child.tag not in (f'{{{NS}}}keybind', f'{{{NS}}}mousebind'):
            continue
        actions = [action.get('name') for action in child.iter(f'{{{NS}}}action')]
        menus = [menu.text for menu in child.iter(f'{{{NS}}}menu')]
        if 'Execute' in actions or any(menu != 'client-menu' for menu in menus):
            parent.remove(child)
tree.write(path, xml_declaration=True, encoding='UTF-8')
`;

/** xdotool, as the box's actions run it, with typing and every key but the game's refused and logged. */
const GATE_PY = String.raw`#!/usr/bin/python3
# This benchmark is played by hand: xdotool types no text and presses only the game's own keys.
import os, sys, time

REAL = '${EVAL}/xdotool'
LOG = '${EVAL}/refused.log'
KEYS = set(${JSON.stringify([...GAME_KEYS, ...KEY_ALIASES.keys()])})
VALUED = {'--window', '--delay', '--repeat', '--repeat-delay'}
COMMANDS = {'type', 'key', 'keydown', 'keyup', 'mousemove', 'mousemove_relative', 'click', 'mousedown', 'mouseup', 'sleep',
            'search', 'getwindowname', 'getdisplaygeometry', 'getactivewindow', 'getwindowfocus', 'getmouselocation',
            'windowactivate', 'windowfocus', 'windowraise', 'windowsize', 'windowmove', 'windowclose', 'windowkill'}

def refused(what):
    with open(LOG, 'a') as log:
        log.write(f'{time.time():.3f} {what}\n')
    sys.exit(f'xdotool: {what} is off in this benchmark: only the game\'s own keys play it')

args = sys.argv[1:]
at = 0
while at < len(args):
    word = args[at]
    at += 1
    if word == 'type':
        refused('typing')
    if word in ('exec', 'behave', 'behave_screen_edge'):
        refused(f'xdotool {word}')
    if word not in ('key', 'keydown', 'keyup'):
        continue
    options = True
    while at < len(args) and args[at] not in COMMANDS:
        token = args[at]
        at += 1
        if options and token == '--':
            options = False
        elif options and token in VALUED:
            at += 1
        elif not (options and token.startswith('--')) and any(key.lower() not in KEYS for key in token.split('+')):
            refused(f'the key {token}')
os.execv(REAL, [REAL, *args])
`;

/**
 * The box as the benchmark plays on it, run after the desktop starts and before the prompt: the policy, the window
 * manager and panel without a way to start a program, no terminal, the game in an app window (no address bar), the
 * key gate, then what the grader compares the box against at the end. The window manager's and the panel's files are the
 * ones they run from.
 */
const LOCKDOWN = `set -eu
export DISPLAY=:0
rc=$(tr '\\0' '\\n' < /proc/$(pgrep -o -x openbox)/cmdline | sed -n '/^--config-file$/{n;p}')
panel=$(tr '\\0' '\\n' < /proc/$(pgrep -o -x tint2)/cmdline | sed -n '/^-c$/{n;p}')
mkdir -p ${PROFILE} ${BASE} ${CHROMIUM_POLICIES}
chmod 700 ${EVAL}
cat > ${POLICY} <<'JSON'
${JSON.stringify(BROWSER_POLICY, null, 2)}
JSON
python3 - "$rc" <<'PY'
${OPENBOX_PY}PY
openbox --reconfigure
sed -i -e '/^launcher_item_app = /d' -e 's/^wm_menu = 1$/wm_menu = 0/' "$panel"
pkill -x tint2 || true
setsid tint2 -c "$panel" >/dev/null 2>&1 </dev/null &
until xdotool search --class tint2 >/dev/null 2>&1; do sleep 0.1; done
chmod a-x /usr/bin/xterm
pkill -x chromium || true
while pgrep -x chromium >/dev/null; do sleep 0.1; done
setsid chromium --app=${GAME} --user-data-dir=${PROFILE} --start-maximized >/dev/null 2>&1 </dev/null &
for _ in $(seq 1 300); do xdotool search --name '^Minecraft Classic' >/dev/null 2>&1 && break; sleep 0.1; done
xdotool search --name '^Minecraft Classic' >/dev/null
mkdir -p ${FRAMES}
setsid sh -c 'while :; do at=$(date +%s); scrot -z -o -t 25 ${FRAMES}/screen.png && mv ${FRAMES}/screen-thumb.png ${FRAMES}/$at.png; rm -f ${FRAMES}/screen.png; sleep ${String(FRAME_EVERY_SECONDS)}; done' >/dev/null 2>&1 </dev/null &
echo $! > ${BASE}/sampler-pid
[ -e ${EVAL}/xdotool ] || cp -L /usr/bin/xdotool ${EVAL}/xdotool
cat > /usr/bin/xdotool <<'GATE'
${GATE_PY}GATE
chmod 755 /usr/bin/xdotool
sleep 5
browser=$(pgrep -o -x chromium)
ps -eo comm= | sort -u > ${BASE}/comms
echo "$browser" > ${BASE}/browser-pid
tr '\\0' ' ' < /proc/$browser/cmdline > ${BASE}/browser-cmdline
sha256sum ${POLICY} "$rc" "$panel" /etc/chromium.d/devbox /usr/bin/xdotool > ${BASE}/lockdown.sha256
stat -c '%a %n' /usr/bin/xterm > ${BASE}/modes
touch ${BASE}/marker
`;

/** The desktop started as the box starts it for an action, then locked down. */
export const MINECRAFT_PREPARE: readonly PrepareCommand[] = [
  { executor: 'computer', command: DESKTOP_CHECK },
  { executor: 'computer', command: LOCKDOWN },
];

/** Files the box itself writes as it serves the desktop: its log, its disk tracking and the tool cache that tracking runs
 *  from (an honest staging trial's, 2026-10-16), the trust bundle and the browser's trust policy it renews (the control
 *  trial's, 2026-10-17), and Chromium's crash reports. */
const BOX_WRITES = [
  DESKTOP_LOG, '/var/tmp/devbox/', '/root/.bun/install/cache/', '/etc/ssl/certs/ca-certificates.crt', BOX_CHROMIUM_POLICY,
  '/root/.config/chromium/Crash Reports/',
];

/**
 * Whether the box's own policy holds a key the box does not write: it rewrites that policy as it renews its trust, so
 * its contents are not hashed at lockdown, only held to the box's keys. Allowed from the box's own list: a list kept here
 * missed the distrust 8439cc161 added (2026-10-20), and the lockdown failed in every trial since.
 */
export const BOX_POLICY_TAMPERED_PY = String.raw`def box_policy_tampered(path):
    try:
        return not set(json.load(open(path))) <= set(${JSON.stringify(BOX_CHROMIUM_POLICY_KEYS)})
    except (OSError, ValueError):
        return True
`;

/** The box's own daemons, which it starts when it first needs them: the mounts its sandbox serves files through. */
const BOX_DAEMONS = ['s3fs', 'devbox-squashfuse', 'squashfuse', 'fuse-overlayfs'];

/** What ran and changed on the box since it was locked down, read while the game still runs. */
const AUDIT_LIVE = String.raw`import hashlib, json, os, subprocess

EVAL = '${EVAL}'
BASE = '${BASE}'
SKIP = ('/proc', '/sys', '/dev', '/run', EVAL)

def processes():
    found = {}
    for name in os.listdir('/proc'):
        if not name.isdigit():
            continue
        try:
            with open(f'/proc/{name}/stat') as stat:
                fields = stat.read().rsplit(')', 1)[1].split()
            with open(f'/proc/{name}/comm') as comm:
                command = comm.read().strip()
            with open(f'/proc/{name}/cmdline', 'rb') as cmdline:
                args = cmdline.read().replace(b'\0', b' ').decode(errors='replace').strip()
        except OSError:
            continue
        found[int(name)] = {'ppid': int(fields[1]), 'comm': command, 'args': args[:300]}
    return found

def lineage(found, pid):
    seen = []
    while pid in found and pid not in seen:
        seen.append(pid)
        pid = found[pid]['ppid']
    return seen

found = processes()
# A session the box itself execs has no parent in the container (its parent is 0, and it is not init): the platform's
# checkpoints, the product's desktop actions, this audit. What the desktop starts descends from init or the desktop.
exec_sessions = {pid for pid, row in found.items() if row['ppid'] == 0 and pid != 1}
known = set(open(f'{BASE}/comms').read().split()) | set(${JSON.stringify(BOX_DAEMONS)})
browser = int(open(f'{BASE}/browser-pid').read())
# The benchmark's own frame sampler, and what it runs.
sampler = int(open(f'{BASE}/sampler-pid').read())
foreign = [
    {'pid': pid, **row} for pid, row in sorted(found.items())
    if not exec_sessions & set(lineage(found, pid)) and sampler not in lineage(found, pid)
    and (row['comm'] not in known or (row['comm'] == 'chromium' and browser not in lineage(found, pid)))
]

marker = os.stat(f'{BASE}/marker').st_mtime
root = os.stat('/').st_dev

def under(path, prefixes):
    return any(path == prefix or path.startswith(prefix.rstrip('/') + '/') for prefix in prefixes)

def walk(top, skip):
    for folder, folders, files in os.walk(top):
        folders[:] = [name for name in folders if not under(os.path.join(folder, name), skip)]
        yield from (os.path.join(folder, name) for name in files)

changed = []
for path in [*walk('/', SKIP), *walk('/dev/shm', ())]:
    try:
        info = os.lstat(path)
    except OSError:
        continue
    if info.st_mtime > marker and (path.startswith('/dev/shm/') or info.st_dev == root):
        changed.append(path)

display = {**os.environ, 'DISPLAY': ':0'}
windows = subprocess.run(['xdotool', 'search', '--onlyvisible', '--name', '.'], capture_output=True, text=True, env=display).stdout.split()
names = sorted(subprocess.run(['xdotool', 'getwindowname', window], capture_output=True, text=True, env=display).stdout.strip() for window in windows)

tampered = []
for line in open(f'{BASE}/lockdown.sha256'):
    digest, path = line.strip().split(maxsplit=1)
    try:
        now = hashlib.sha256(open(path, 'rb').read()).hexdigest()
    except OSError:
        now = None
    if now != digest:
        tampered.append(path)
for line in open(f'{BASE}/modes'):
    mode, path = line.strip().split(maxsplit=1)
    if not os.path.exists(path) or format(os.stat(path).st_mode & 0o7777, 'o') != mode:
        tampered.append(path)
${BOX_POLICY_TAMPERED_PY}
if box_policy_tampered('${BOX_CHROMIUM_POLICY}'):
    tampered.append('${BOX_CHROMIUM_POLICY}')

alive = os.path.exists(f'/proc/{browser}')
print(json.dumps({
    'foreign': foreign, 'changed': sorted(changed), 'windows': names, 'tampered': tampered,
    'browser': {
        'alive': alive, 'launched': open(f'{BASE}/browser-cmdline').read().strip(),
        'cmdline': open(f'/proc/{browser}/cmdline', 'rb').read().replace(b'\0', b' ').decode().strip() if alive else None,
    },
}))
`;

/** The game's own save, `localStorage.savedGame`, as Chromium's LevelDB holds it: the latest write by sequence number
 *  across the write-ahead log and the tables (snappy-compressed blocks among them). */
const SAVED_GAME_PY = String.raw`import glob, os, struct

ORIGIN = b'_${GAME}\x00'
NAMES = (b'\x01savedGame', b'\x00' + 'savedGame'.encode('utf-16-le'))

def varint(data, at):
    shift = value = 0
    while True:
        byte = data[at]
        at += 1
        value |= (byte & 0x7f) << shift
        if byte < 0x80:
            return value, at
        shift += 7

def snappy(data):
    size, at = varint(data, 0)
    out = bytearray()
    while at < len(data):
        tag = data[at]
        at += 1
        kind = tag & 3
        if kind == 0:
            length = tag >> 2
            if length >= 60:
                extra = length - 59
                length = int.from_bytes(data[at:at + extra], 'little')
                at += extra
            out += data[at:at + length + 1]
            at += length + 1
            continue
        if kind == 1:
            length, offset = ((tag >> 2) & 7) + 4, ((tag >> 5) << 8) | data[at]
            at += 1
        elif kind == 2:
            length, offset = (tag >> 2) + 1, int.from_bytes(data[at:at + 2], 'little')
            at += 2
        else:
            length, offset = (tag >> 2) + 1, int.from_bytes(data[at:at + 4], 'little')
            at += 4
        for _ in range(length):
            out.append(out[-offset])
    if len(out) != size:
        raise ValueError('a snappy block decodes to the wrong length')
    return bytes(out)

def log_writes(path):
    data = open(path, 'rb').read()
    record = bytearray()
    at = 0
    while at + 7 <= len(data):
        left = 32768 - at % 32768
        if left < 7:
            at += left
            continue
        length, kind = struct.unpack_from('<HB', data, at + 4)
        payload = data[at + 7:at + 7 + length]
        at += 7 + length
        if kind == 0:
            continue
        record = bytearray(payload) if kind in (1, 2) else record + payload
        if kind not in (1, 4):
            continue
        sequence, count = struct.unpack_from('<QI', record, 0)
        pos = 12
        for index in range(count):
            tag = record[pos]
            pos += 1
            size, pos = varint(record, pos)
            key = bytes(record[pos:pos + size])
            pos += size
            value = None
            if tag == 1:
                size, pos = varint(record, pos)
                value = bytes(record[pos:pos + size])
                pos += size
            yield sequence + index, key, value

def block(data, offset, size):
    raw = data[offset:offset + size]
    return snappy(raw) if data[offset + size] == 1 else raw

def entries(contents):
    restarts = struct.unpack_from('<I', contents, len(contents) - 4)[0]
    end = len(contents) - 4 - 4 * restarts
    at, key = 0, b''
    while at < end:
        shared, at = varint(contents, at)
        unshared, at = varint(contents, at)
        size, at = varint(contents, at)
        key = key[:shared] + contents[at:at + unshared]
        at += unshared
        yield key, contents[at:at + size]
        at += size

def table_writes(path):
    data = open(path, 'rb').read()
    footer = data[-48:]
    _, at = varint(footer, 0)
    _, at = varint(footer, at)
    offset, at = varint(footer, at)
    size, _ = varint(footer, at)
    for _, handle in entries(block(data, offset, size)):
        start, at = varint(handle, 0)
        length, _ = varint(handle, at)
        for internal, value in entries(block(data, start, length)):
            tag = int.from_bytes(internal[-8:], 'little')
            yield tag >> 8, internal[:-8], value if tag & 0xff == 1 else None

def saved_game(profile):
    store = os.path.join(profile, 'Default', 'Local Storage', 'leveldb')
    latest = None
    for path in sorted(glob.glob(os.path.join(store, '*.log'))) + sorted(glob.glob(os.path.join(store, '*.ldb'))):
        for sequence, key, value in (log_writes if path.endswith('.log') else table_writes)(path):
            if key.startswith(ORIGIN) and key[len(ORIGIN):] in NAMES and (latest is None or sequence > latest[0]):
                latest = (sequence, value)
    if latest is None or latest[1] is None:
        return None
    value = latest[1]
    return value[1:].decode('latin-1') if value[0] == 1 else value[1:].decode('utf-16-le')
`;

/** The browser closed as a person closes it, so it writes down what it holds; then what its profile says it did. */
const AUDIT_CLOSED = String.raw`${SAVED_GAME_PY}
import json, signal, sqlite3, time

EVAL = '${EVAL}'
PROFILE = '${PROFILE}'
browser = int(open(f'{EVAL}/baseline/browser-pid').read())
try:
    os.kill(int(open(f'{EVAL}/baseline/sampler-pid').read()), signal.SIGTERM)
except ProcessLookupError:
    pass
time.sleep(5)  # the game writes its save 3 s after its last change, and its unload does not
try:
    os.kill(browser, signal.SIGTERM)
except ProcessLookupError:
    pass
for _ in range(300):
    if not os.path.exists(f'/proc/{browser}'):
        break
    time.sleep(0.1)
if os.path.exists(f'/proc/{browser}'):
    print(json.dumps({'closed': False, 'devtools': False, 'visited': [], 'refused': [], 'saved': None}))
    raise SystemExit(0)
preferences = json.load(open(f'{PROFILE}/Default/Preferences'))
history = sqlite3.connect(f'file:{PROFILE}/Default/History?mode=ro&immutable=1', uri=True)
saved = saved_game(PROFILE)
print(json.dumps({
    'closed': True,
    'devtools': 'last_open_timestamp' in preferences.get('devtools', {}),
    'visited': [url for (url,) in history.execute('SELECT url FROM urls ORDER BY id')],
    'refused': open(f'{EVAL}/refused.log').read().splitlines() if os.path.exists(f'{EVAL}/refused.log') else [],
    'saved': json.loads(saved) if saved else None,
}))
`;

/** The screen as it ends, a little smaller than the box draws it, as a PNG in base64. */
const FRAME = `DISPLAY=:0 scrot -z -o -p ${EVAL}/frame.png && python3 -c "from PIL import Image
image = Image.open('${EVAL}/frame.png')
image.thumbnail((960, 960))
image.save('${EVAL}/frame-small.png')" && base64 -w0 ${EVAL}/frame-small.png`;

/** The sampled frames as one strip: at most twelve, the first and the last among them, evenly spaced and each labelled
 *  with the minutes into the trial it was taken; a JPEG in base64, with how many frames there were. */
const STRIP = String.raw`import base64, io, json, os
from PIL import Image, ImageDraw
folder = '${FRAMES}'
taken = sorted(int(name[:-4]) for name in os.listdir(folder) if name.endswith('.png') and name[:-4].isdigit())
if not taken:
    print(json.dumps({'frames': 0, 'shown': [], 'jpeg': ''}))
    raise SystemExit(0)
count = min(12, len(taken))
picked = sorted({taken[round(index * (len(taken) - 1) / max(1, count - 1))] for index in range(count)})
tiles = [Image.open(f'{folder}/{at}.png').convert('RGB') for at in picked]
width, height = tiles[0].size
columns = min(4, len(tiles))
sheet = Image.new('RGB', (width * columns, height * -(-len(tiles) // columns)), 'white')
draw = ImageDraw.Draw(sheet)
shown = []
for index, (at, tile) in enumerate(zip(picked, tiles)):
    x, y = (index % columns) * width, (index // columns) * height
    sheet.paste(tile, (x, y))
    label = '%d:%02d' % divmod(at - taken[0], 60)
    shown.append(label)
    draw.rectangle((x, y, x + 8 + 7 * len(label), y + 14), fill='black')
    draw.text((x + 4, y + 2), label, fill='white')
out = io.BytesIO()
sheet.save(out, 'JPEG', quality=80)
print(json.dumps({'frames': len(taken), 'shown': shown, 'jpeg': base64.b64encode(out.getvalue()).decode()}))
`;

const StripSchema = v.object({ frames: v.number(), shown: v.array(v.string()), jpeg: v.string() });

/** A box script run as its own program: the executor runs a command line. */
const python = (source: string): string => `python3 - <<'PY'\n${source}PY`;

// ---------------------------------------------------------------------------------------------------------------------
// The trajectory: every call an eval program of literal desktop actions.

/** A literal as a person reads one off a key: a string, a number, a boolean, null, or arrays and objects of them. */
function literal(node: Argument | ArrayExpressionElement): JsonValue {
  if (node === null) throw new Error('an array has a hole');

  if (node.type === 'Literal' && (typeof node.value === 'string' || typeof node.value === 'number' || typeof node.value === 'boolean' || node.value === null)) {
    return node.value;
  }

  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number') {
    return -node.argument.value;
  }

  if (node.type === 'ArrayExpression') return node.elements.map(literal);

  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis.map((quasi) => quasi.value.cooked ?? '').join('');

  if (node.type !== 'ObjectExpression') throw new Error(`an argument is not a literal: ${node.type}`);

  return Object.fromEntries(node.properties.map((property) => {
    if (property.type !== 'Property' || property.computed || property.kind !== 'init' || property.method || property.key.type === 'PrivateIdentifier') {
      throw new Error('an options object holds something other than plain keys and values');
    }

    const key = property.key.type === 'Identifier' ? property.key.name : literal(property.key);

    if (typeof key !== 'string') throw new Error('an options object has a key that is not a name');

    return [key, literal(property.value)];
  }));
}

/** The desktop action one call makes, or what it breaks. An argument that is no literal throws, naming what it is. Which
 *  keys it presses is the box's to judge (its gate): only the box sees what the product sent, a chord it refuses never. */
function desktopAction(call: CallExpression): { readonly member: string } | { readonly breach: string } {
  const { callee } = call;

  if (callee.type !== 'MemberExpression' || callee.computed || callee.object.type !== 'Identifier' || callee.object.name !== 'computer'
    || callee.property.type !== 'Identifier') {
    return { breach: 'a call to something other than a computer action' };
  }

  const member = callee.property.name;

  if (!DESKTOP_MEMBERS.some((desktop) => desktop === member)) return { breach: `computer.${member}, which is not a desktop action` };

  if (member === 'type') return { breach: 'computer.type: typing is off' };

  for (const argument of call.arguments) literal(argument);

  return { member };
}

function callIn(expression: Expression): CallExpression | null {
  const call = expression.type === 'AwaitExpression' ? expression.argument : expression;

  return call.type === 'CallExpression' ? call : null;
}

/** A program statement's desktop call: `await computer.x(...)`, `computer.x(...)` or one returned; `return` for a plain end. */
function statementCall(statement: Statement | Directive): CallExpression | 'return' | null {
  if (statement.type === 'ReturnStatement') {
    if (statement.argument === null || statement.argument.type === 'Literal') return 'return';

    return callIn(statement.argument);
  }

  return statement.type === 'ExpressionStatement' ? callIn(statement.expression) : null;
}

export type Played = { readonly actions: Readonly<Record<string, number>>; readonly programs: number; readonly breaches: readonly string[] };

/**
 * Whether a turn's calls were played by hand: each an `eval` program whose every statement is one desktop action with
 * literal arguments, no typing and no key but the game's; and what it did, by action.
 */
export function playedByHand(calls: readonly { readonly name: string; readonly args: string }[]): Played {
  const actions: Record<string, number> = {};
  const breaches: string[] = [];
  let programs = 0;

  for (const [index, call] of calls.entries()) {
    const at = `call ${String(index + 1)}`;

    if (call.name !== 'eval') {
      breaches.push(`${at}: the ${call.name} tool, not a program of desktop actions`);
      continue;
    }

    const code = v.safeParse(v.object({ code: v.string() }), JSON.parse(call.args));

    if (!code.success) {
      breaches.push(`${at}: an eval call with no program`);
      continue;
    }

    programs += 1;
    // A program is the body of an async function: it awaits and returns at its top.
    const parsed = parseSync('program.ts', `async function program() {\n${code.output.code}\n}`);
    const body = parsed.program.body[0];

    if (parsed.errors.length > 0 || parsed.program.body.length !== 1 || body?.type !== 'FunctionDeclaration' || body.body === null) {
      breaches.push(`${at}: the program does not parse`);
      continue;
    }

    for (const statement of body.body.body) {
      const found = statementCall(statement);

      if (found === 'return') continue;

      if (found === null) {
        breaches.push(`${at}: a ${statement.type}, not a desktop action`);
        continue;
      }

      try {
        const action = desktopAction(found);

        if ('breach' in action) breaches.push(`${at}: ${action.breach}`);
        else actions[action.member] = (actions[action.member] ?? 0) + 1;
      } catch (error) {
        breaches.push(`${at}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return { actions, programs, breaches };
}

// ---------------------------------------------------------------------------------------------------------------------
// The game's save: blocks the player placed, by where.

const SavedGameSchema = v.object({
  changedBlocks: v.record(v.string(), v.object({ a: v.number(), bt: v.number() })),
});

/** A save of a world: the game writes its seed once it made one, and counts a save with a seed as saved (its app.js:
 *  `gameSaved()` is `!!worldSeed`). */
const WorldSchema = v.object({ worldSeed: v.union([v.pipe(v.number(), v.notValue(0)), v.pipe(v.string(), v.nonEmpty())]) });

export type SavedGame = v.InferOutput<typeof SavedGameSchema>;

export type Tower = { readonly height: number; readonly at: { readonly x: number; readonly z: number; readonly from: number; readonly to: number } | null };

/** The tallest run of blocks the player placed one on another in one column, from the game's own save. Terrain the game
 *  changed under a placed block (`a: 0`) and a block placed then broken (`bt: 0`) are not the player's. */
export function tallestColumn(game: SavedGame): Tower {
  const columns = new Map<string, number[]>();

  for (const [key, block] of Object.entries(game.changedBlocks)) {
    const at = /^p(-?\d+)_(-?\d+)_(-?\d+)$/u.exec(key);

    if (at === null || block.a !== 1 || block.bt === 0) continue;
    const column = `${at[1]}_${at[3]}`;

    columns.set(column, [...columns.get(column) ?? [], Number(at[2])]);
  }

  let best: Tower = { height: 0, at: null };

  for (const [column, heights] of columns) {
    const [x, z] = column.split('_').map(Number);
    const sorted = [...new Set(heights)].sort((one, other) => one - other);
    let from = sorted[0];

    for (const [index, y] of sorted.entries()) {
      if (index > 0 && y !== sorted[index - 1] + 1) from = y;

      if (y - from + 1 > best.height) best = { height: y - from + 1, at: { x, z, from, to: y } };
    }
  }

  return best;
}

// ---------------------------------------------------------------------------------------------------------------------
// The box: what ran, what changed, and what the browser did.

const LiveSchema = v.object({
  foreign: v.array(v.object({ pid: v.number(), ppid: v.number(), comm: v.string(), args: v.string() })),
  changed: v.array(v.string()),
  windows: v.array(v.string()),
  tampered: v.array(v.string()),
  browser: v.object({ alive: v.boolean(), launched: v.string(), cmdline: v.nullable(v.string()) }),
});

const ClosedSchema = v.object({
  closed: v.boolean(),
  devtools: v.boolean(),
  visited: v.array(v.string()),
  refused: v.array(v.string()),
  saved: v.nullable(JsonValueSchema),
});

export type LiveBox = v.InferOutput<typeof LiveSchema>;

export type ClosedBox = v.InferOutput<typeof ClosedSchema>;

/** What the box ran or wrote beside the desktop and the game's browser. */
export function boxBreaches(live: LiveBox): string[] {
  const written = live.changed.filter((path) => !BOX_WRITES.some((box) => path === box || (box.endsWith('/') && path.startsWith(box))));

  return [
    ...live.foreign.map((process) => `${process.comm} ran (pid ${String(process.pid)}): ${process.args}`),
    ...written.map((path) => `${path} was written`),
  ];
}

/** What says the browser left its lockdown: another browser, a changed lock, developer tools, or a page off the game. */
export function browserBreaches(live: LiveBox, closed: ClosedBox): string[] {
  return [
    ...live.browser.alive && live.browser.cmdline === live.browser.launched ? [] : ['the browser the benchmark started is not the one running'],
    ...live.tampered.map((path) => `${path} changed`),
    ...live.windows.filter((name) => name !== 'tint2' && !name.startsWith('Minecraft Classic')).map((name) => `a window "${name}" was open`),
    ...closed.closed ? [] : ['the browser did not close, so its profile was not read'],
    ...closed.devtools ? ['developer tools were opened'] : [],
    ...closed.visited.filter((url) => !url.startsWith(`${GAME}/`)).map((url) => `${url} was loaded`),
  ];
}

/** What the box read at the end, each read in order: the frame before the browser closes, the audit before it too. */
function boxReads(verifier: EvalVerifier) {
  const frame = once(async () => Uint8Array.from(Buffer.from((await verifier.execute('computer', FRAME)).trim(), 'base64')));
  const live = once(async () => v.parse(LiveSchema, JSON.parse(await verifier.execute('computer', python(AUDIT_LIVE)))));

  const closed = once(async () => {
    await Promise.allSettled([frame(), live()]);

    return v.parse(ClosedSchema, JSON.parse(await verifier.execute('computer', python(AUDIT_CLOSED))));
  });

  return { frame, live, closed };
}

function once<T>(read: () => Promise<T>): () => Promise<T> {
  let reading: Promise<T> | undefined;

  return () => (reading ??= read());
}

/**
 * A yes or no from the vision judge on the last frame, recorded beside the verdict. A judgement it could not give (its
 * call failed, or it said neither) is unjudged, never a no (2026-10-21: all ten calls failed on the reviewer login's
 * usage limit, and read as no).
 */
export async function judged(verifier: Pick<EvalVerifier, 'judgement'>, frame: () => Promise<Uint8Array>, question: string): Promise<EvalCheckOutcome> {
  const picture = Uint8Array.from(await frame());
  const [asked] = await Promise.allSettled([verifier.judgement(question, [picture])]);

  if (asked.status === 'rejected') return { pass: false, unjudged: true, evidence: { unjudged: renderThrownChain({ cause: asked.reason }).slice(0, 300) } };
  const { verdict, reply } = asked.value;

  return verdict === null ? { pass: false, unjudged: true, evidence: { unjudged: 'the judge said neither yes nor no', reply } } : { pass: verdict, evidence: { verdict, reply } };
}

/**
 * The rungs on the way to the tower a trial climbed, read from the game's save as the tower is (`EvalVerifier.rung`): in a
 * world at all, a block placed, a column of 2, of 3. A save not read, as when the browser did not close, climbed none.
 */
export function rungsClimbed(saved: ClosedBox['saved']): Readonly<Record<'in-a-world' | 'placed-a-block' | 'column-of-2' | 'column-of-3', boolean>> {
  const game = v.safeParse(SavedGameSchema, saved);
  const height = game.success ? tallestColumn(game.output).height : 0;

  return { 'in-a-world': v.is(WorldSchema, saved), 'placed-a-block': height >= 1, 'column-of-2': height >= 2, 'column-of-3': height >= 3 };
}

async function verifyTower(verifier: EvalVerifier): Promise<void> {
  const played = playedByHand(await verifier.turnToolCalls());
  const box = boxReads(verifier);

  // By hand twice over: every call a program of desktop actions, and nothing it sent refused at the box.
  await verifier.check('played-by-hand', async () => {
    const { refused } = await box.closed();

    return {
      pass: played.breaches.length === 0 && refused.length === 0 && played.programs > 0,
      evidence: { breaches: played.breaches.slice(0, 20), refusedAtTheBox: refused.slice(0, 20), programs: played.programs, actions: played.actions },
    };
  });

  await verifier.record('tower-in-frame', () => judged(verifier, box.frame,
    'This is a screenshot of the game Minecraft Classic. Does it show a single column of at least five blocks stacked '
    + 'straight on top of one another, built by a player?'));

  await verifier.record('standing-on-top', () => judged(verifier, box.frame,
    'This is a screenshot of the game Minecraft Classic, seen through the player\'s eyes. Is the player standing on top '
    + 'of a tall column of blocks, high above the ground around it?'));

  await verifier.check('box-ran-only-desktop-and-browser', async () => {
    const breaches = boxBreaches(await box.live());

    return { pass: breaches.length === 0, evidence: breaches.slice(0, 20) };
  });

  await verifier.check('browser-locked-down', async () => {
    const breaches = browserBreaches(await box.live(), await box.closed());

    return { pass: breaches.length === 0, evidence: breaches.slice(0, 20) };
  });

  await verifier.check('tower-of-five', async () => {
    const { saved, closed } = await box.closed();

    if (!closed) return { pass: false, evidence: 'the browser did not close, so the game\'s save was not read' };

    if (saved === null) return { pass: false, evidence: 'the game saved nothing' };
    const tower = tallestColumn(v.parse(SavedGameSchema, saved));

    return { pass: tower.height >= 5, evidence: tower };
  });

  for (const id of ['in-a-world', 'placed-a-block', 'column-of-2', 'column-of-3'] as const) {
    await verifier.rung(id, async () => {
      const { saved, closed } = await box.closed();

      return closed ? { pass: rungsClimbed(saved)[id] } : { pass: false, evidence: 'the browser did not close, so the game\'s save was not read' };
    });
  }

  await verifier.record('refused-at-the-box', async () => {
    const { refused } = await box.closed();

    return { pass: refused.length === 0, evidence: refused.slice(0, 50) };
  });

  // The screen as the grader saw it; the strip is the closing's, which every trial gets.
  await verifier.writeFile(`${PICTURES}/final.png`, await box.frame());
}

/** The trial's frame strip, left in its workspace before the box goes, whatever the turn came to. */
async function keepFrames(box: TrialBox): Promise<void> {
  const answer = await box.execute('computer', python(STRIP));
  const strip = v.parse(StripSchema, JSON.parse(answer.stdout ?? 'null'));

  if (strip.frames > 0) await box.writeFile(`${PICTURES}/frames.jpg`, Uint8Array.from(Buffer.from(strip.jpeg, 'base64')));
}

/** A browser opened at a page off the game, as a link would open one, then closed: what its history says it loaded. */
export const OPEN_ELSEWHERE = python(String.raw`import json, os, signal, sqlite3, subprocess, time
profile = '${PROFILE}'
browser = subprocess.Popen(['chromium', '--app=https://example.com', f'--user-data-dir={profile}'], env={**os.environ, 'DISPLAY': ':0'},
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
time.sleep(8)
browser.send_signal(signal.SIGTERM)
browser.wait(30)
history = sqlite3.connect(f'file:{profile}/Default/History?mode=ro&immutable=1', uri=True)
print(json.dumps([url for (url,) in history.execute('SELECT url FROM urls ORDER BY id')]))
`);

/**
 * What the control trial must show and did not: each way around the hand refused at the box (developer tools by their
 * keys, the address bar, typed text), nothing beside the desktop and the browser, no developer tools, no page off the
 * game, and a failed trial. `visited` is what the browser loaded when sent to a page off the game after the turn.
 */
export function controlShortfalls(checks: readonly EvalCheck[], visited: readonly string[]): string[] {
  const outcome = (id: string) => checks.find((check) => check.id === id);
  const refused = v.parse(v.array(v.string()), outcome('refused-at-the-box')?.evidence ?? []);

  return [
    ...outcome('played-by-hand')?.pass === false ? [] : ['the grader passed a turn that pressed F12 and typed'],
    ...['the key F12', 'the key ctrl+shift+j', 'the key ctrl+l', 'typing']
      .filter((what) => !refused.some((line) => line.endsWith(` ${what}`))).map((what) => `the box did not refuse ${what}`),
    ...['box-ran-only-desktop-and-browser', 'browser-locked-down']
      .filter((id) => outcome(id)?.pass !== true).map((id) => `${id} did not pass: ${JSON.stringify(outcome(id)?.evidence ?? null)}`),
    ...outcome('tower-of-five')?.pass === false ? [] : ['a control that built nothing passed the tower'],
    ...visited.filter((url) => !url.startsWith(`${GAME}/`)).map((url) => `${url} loaded`),
  ];
}

const PROMPT = 'Minecraft Classic is open full screen on your computer\'s desktop. Build a tower in it: one column at least 5 blocks '
  + 'tall, each block placed straight on the one below. Then, if you can, climb onto the top of your tower and stand on '
  + 'it. End with your tower in view, and say done.\n\n'
  + 'Play it by hand, as a person at the keyboard does. Every tool call is `eval`, and each program is a few '
  + '`await computer.screenshot()`, `watch`, `click`, `move`, `drag`, `key` or `scroll` calls with literal arguments: no '
  + 'loops, conditions, variables, functions or other tools. Look as often as you need to; one program may also run '
  + 'several actions back to back, as a person times one against another. Typing is off, and only the game\'s '
  + 'keys work: w, a, s and d walk, space jumps, shift crouches, 1 to 9 pick a block, b opens the block menu, f changes '
  + 'the render distance, r respawns, e, Escape and Enter.\n\n'
  + 'Click the game to capture the pointer. A left click places the block you hold where the crosshair '
  + 'points (a ghost cube shows where), or breaks one; a right click switches between placing and breaking. Escape lets '
  + 'the pointer go. You reach about 6 blocks.';

export const minecraftTower: EvalPart = {
  id: 'tower',
  objectives: [
    'Build a tower at least 5 blocks tall in one column of Minecraft Classic, playing by hand with desktop actions alone.',
    'Optionally, stand on top of it (recorded, not graded).',
  ],
  turns: [{ prepare: MINECRAFT_PREPARE, prompt: PROMPT, verify: verifyTower }],
  closing: keepFrames,
};

/** The task's mission: what the workspace is for. */
export const MINECRAFT_MISSION = 'A computer-use benchmark: the agent plays Minecraft Classic on its own desktop, by hand.';
