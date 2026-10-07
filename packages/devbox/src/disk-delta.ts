// The delta a save publishes above the layers below it (D55, D63): what changed since a boundary, a large file as its
// changed blocks against the digests held for that boundary.
import { shellPath } from './stream-archive';

/**
 * What a delta is cut from and kept as: the tree, the change lists (`<changes>.changed`, `<changes>.deleted`), the block
 * digests held for the boundary below it (null: its large files travel whole), and where the digests of the tree it
 * leaves and its own list of the paths it holds are written.
 */
interface DeltaCut {
  readonly dir: string;
  readonly changes: string;
  readonly below: string | null;
  readonly next: string;
  readonly listing: string;
}

export function deltaTarCommand(cut: DeltaCut): string {
  const args = [`${cut.changes}.changed`, `${cut.changes}.deleted`, cut.dir, cut.below ?? '', cut.next, cut.listing];

  return `python3 -c ${shellPath(DELTA_SCRIPT)} ${args.map(shellPath).join(' ')}`;
}

const DELTA_SCRIPT = `
import hashlib, io, json, os, shutil, stat, sys, tarfile, time
changed_path, deleted_path, workdir, blocks, nxt, listing = sys.argv[1:7]
BLOCK, BIG = 16384, 1048576
def entries(path):
    return [item.decode('utf-8', 'surrogateescape') for item in open(path, 'rb').read().split(b'\\0') if item]
def name(path):
    return hashlib.sha256(path.encode('utf-8', 'surrogateescape')).hexdigest()
def index(pages):
    built = [bytearray(128) for _ in pages]
    def build(lo, hi):
        if lo == hi:
            return bytes(32)
        mid = (lo + hi) // 2
        left, right = build(lo, mid), build(mid + 1, hi)
        at, digest = pages[mid]
        page = built[mid]
        page[0:8] = at.to_bytes(8, 'little')
        page[8] = 1 if digest else 2
        if digest:
            page[16:48] = digest
        page[48:80], page[80:112] = left, right
        return hashlib.sha256(page).digest()
    root = build(0, len(pages)) if pages else hashlib.sha256(b'').digest()
    data = b''.join(built)
    return {'index': hashlib.sha256(data).hexdigest(), 'root': root.hex(), 'count': len(pages)}, data
# Unbuffered, so a write the archiver no longer reads fails where it is made.
out = tarfile.open(fileobj=open(1, 'wb', buffering=0, closefd=False), mode='w|', format=tarfile.PAX_FORMAT,
                   encoding='utf-8', errors='surrogateescape', copybufsize=BLOCK)
now, made = int(time.time()), set()
def put(arcname, data=b'', kind=tarfile.REGTYPE):
    parent = os.path.dirname(arcname)
    if parent and parent not in made:
        put(parent, kind=tarfile.DIRTYPE)
    made.add(arcname)
    info = tarfile.TarInfo(arcname)
    info.type, info.size, info.mtime, info.mode = kind, len(data), now, 0o755 if kind == tarfile.DIRTYPE else 0o644
    out.addfile(info, io.BytesIO(data) if data else None)
class Promised:
    """The \`size\` bytes its header promised, zero-padded if it shrank; each read is one 16 KiB block, digested."""
    def __init__(self, source, size):
        self.source, self.left, self.digests = source, size, bytearray()
    def read(self, size):
        want = min(size, self.left)
        data = self.source.read(want)
        while len(data) < want:
            more = self.source.read(want - len(data))
            if not more:
                break
            data += more
        data += bytes(want - len(data))
        self.left -= want
        self.digests += hashlib.sha256(data).digest()
        return data
def blocks_of(path, before):
    """One read: every block's digest, and each block that differs from \`before\` into the delta."""
    pages, digests, size = [], bytearray(), 0
    with open(path, 'rb') as source:
        info = os.fstat(source.fileno())
        while True:
            data = source.read(BLOCK)
            if not data:
                break
            digest = hashlib.sha256(data).digest()
            digests += digest
            if before[size // BLOCK * 32:size // BLOCK * 32 + 32] != digest:
                if data.count(0) == len(data):
                    pages.append((size, None))
                else:
                    chunk = '.devbox-delta/chunks/' + digest.hex()[:2] + '/' + digest.hex()
                    if chunk not in made:
                        put(chunk, data)
                    pages.append((size, digest))
            size += len(data)
    return info, pages, bytes(digests), size
changed, deleted = entries(changed_path), entries(deleted_path)
shutil.rmtree(nxt, ignore_errors=True)
os.makedirs(nxt)
known = set()
if blocks and os.path.isfile(os.path.join(blocks, 'paths')):
    known = set(entries(os.path.join(blocks, 'paths')))
    for path in known:
        os.link(os.path.join(blocks, name(path)), os.path.join(nxt, name(path)))
gone, tops = set(), []
for path in deleted:
    parts = path.split('/')
    if any('/'.join(parts[:at]) in gone for at in range(1, len(parts))):
        continue
    gone.add(path)
    tops.append(path)
cached_before, changing = set(known), set(changed)
for path in list(known):
    if path in gone or path in changing or any(path.startswith(top + '/') for top in tops):
        known.discard(path)
        os.unlink(os.path.join(nxt, name(path)))
put('tree', kind=tarfile.DIRTYPE)
records, whole = [], []
for path in changed:
    full = os.path.join(workdir, path)
    info = os.lstat(full) if os.path.lexists(full) else None
    cached = os.path.join(blocks, name(path))
    if path in cached_before and info is not None and os.path.isfile(full) and not os.path.islink(full) and info.st_size >= BIG:
        info, pages, digests, size = blocks_of(full, open(cached, 'rb').read())
        over, data = index(pages)
        if '.devbox-delta/' + over['index'] not in made:
            put('.devbox-delta/' + over['index'], data)
        records.append({'p': path, 's': size, 'mode': info.st_mode & 0o7777, 'uid': info.st_uid, 'gid': info.st_gid, 't': info.st_mtime_ns, 'over': over})
        open(os.path.join(nxt, name(path)), 'wb').write(digests)
        known.add(path)
    else:
        whole.append(path)
wanted, sent = set(whole), set(whole)
for path in whole + tops:
    parts = path.split('/')
    wanted.update('/'.join(parts[:at]) for at in range(1, len(parts)))
# Parents sort before what they hold; a path gone since the inventory is skipped, as tar's --ignore-failed-read did.
for path in sorted(wanted):
    full = os.path.join(workdir, path)
    try:
        info = out.gettarinfo(full, 'tree/' + path)
    except OSError:
        continue
    if info is None:
        continue
    info.mtime, info.uname, info.gname = int(info.mtime), '', ''
    made.add(info.name)
    if not info.isreg():
        out.addfile(info)
        continue
    try:
        source = open(full, 'rb')
    except OSError:
        continue
    with source:
        promised = Promised(source, info.size)
        out.addfile(info, promised)
    if path in sent and info.size >= BIG:
        open(os.path.join(nxt, name(path)), 'wb').write(bytes(promised.digests))
        known.add(path)
def under_directories(path):
    """Whether every directory above \`path\` is one now: a file or link in its place hides all the layers below held there."""
    parts = path.split('/')[:-1]
    try:
        return all(stat.S_ISDIR(os.lstat(os.path.join(workdir, *parts[:at])).st_mode) for at in range(1, len(parts) + 1))
    except OSError:
        return False
for path in tops:
    parent, base = os.path.split(path)
    if under_directories(path):
        put(os.path.join('tree', parent, '.wh.' + base))
if records:
    put('.devbox-delta/manifest.json', json.dumps({'v': 4, 'files': records}).encode())
# Every path this layer answers for, in it for a later merge and on this disk for the next one (D77).
held = b''.join(path.encode('utf-8', 'surrogateescape') + b'\\0' for path in changed + deleted)
put('.devbox-delta/paths', held)
os.makedirs(os.path.dirname(listing), exist_ok=True)
open(listing, 'wb').write(held)
with open(os.path.join(nxt, 'paths'), 'wb') as listing:
    for path in sorted(known):
        listing.write(path.encode('utf-8', 'surrogateescape') + b'\\0')
try:
    out.close()
except BrokenPipeError:
    # The archiver stops reading at the end-of-archive blocks; the record's padding after them has no reader.
    pass
`;

/**
 * How many of a chain's deltas a save keeps, and how many saves its own layer then covers (D77). A binary counter: the
 * new layer takes in each newest layer no larger than what it has gathered, so n saves since the base are held in at
 * most floor(log2 n) + 1 deltas. A layer a recovery has mounted stays while it is mounted.
 */
export function levelsAfter(deltas: readonly { readonly key: string; readonly saves: number }[], mounted: ReadonlySet<string>) {
  let keep = deltas.length;
  let saves = 1;

  for (let last = deltas[keep - 1]; last !== undefined && !mounted.has(last.key) && last.saves <= saves; last = deltas[keep - 1]) {
    saves += last.saves;
    keep -= 1;
  }

  return { keep, saves };
}

/** A merged layer's changes since the boundary below it: each path its layers or this save touched, as it is now. */
export function mergeListsCommand(changes: string, inventory: string, lists: readonly string[]): string {
  return `python3 -c ${shellPath(MERGE_LISTS)} ${[changes, inventory, ...lists].map(shellPath).join(' ')}`;
}

const MERGE_LISTS = `
import sys
changes, inventory, *lists = sys.argv[1:]
def entries(path):
    return [item for item in open(path, 'rb').read().split(b'\\0') if item]
touched = set(entries(changes + '.changed')) | set(entries(changes + '.deleted'))
for listing in lists:
    touched.update(entries(listing))
now = {item.split(b'\\t', 1)[0] for item in entries(inventory)}
for suffix, paths in (('.changed', touched & now), ('.deleted', touched - now)):
    with open(changes + suffix, 'wb') as out:
        out.write(b''.join(path + b'\\0' for path in sorted(paths)))
`;
