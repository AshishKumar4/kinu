// D55's R2 backup: a save publishes a layer of what changed, a large file as its changed blocks
// (D63); a recovery mounts the layers lazily in the gate (R1, R2) and copies them to disk.
import { Effect } from 'effect';
import * as v from 'valibot';
import { DevboxError, attempt, attemptSync, settle } from './errors';
import { DEVBOX_RUNTIME_DIR, DEVBOX_WORKDIR, type AttachOutcome, type CheckpointKind, type CheckpointOutcome, type DevboxStorage } from './storage';
import { STORE_MOUNT } from './store-gateway';
import { type ArchiveSource, DISK_STREAM, normalizeArchiveExclude, shellPath, streamCommand } from './stream-archive';

/** What a save leaves out unless a box names its own: each regenerates from the rest. */
export const DEFAULT_EXCLUDES = ['node_modules', '*.log', '.cache', '.bun', '__pycache__', '.venv', 'target', '.next', '.turbo', 'dist'] as const;

const DISK_CHAIN_FORMAT = 'disk-chain/2';

const Layer = v.object({ key: v.string(), bytes: v.pipe(v.number(), v.safeInteger(), v.minValue(1)), committedAt: v.number() });

export const DiskChainStateSchema = v.object({
  format: v.literal(DISK_CHAIN_FORMAT),
  rev: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  base: Layer,
  deltas: v.array(Layer),
  committedAt: v.number(),
});

export type DiskChainState = v.InferOutput<typeof DiskChainStateSchema>;

const COMPACT_SHARE = 0.25;

const COMPACT_LAYERS = 8;

const COPY_HEADROOM = 1024 * 1024 * 1024;

const RT = DEVBOX_RUNTIME_DIR;

const INVENTORY = `${RT}/disk-inventory`;

const INVENTORY_REV = `${RT}/disk-inventory.rev`;

const NEXT_INVENTORY = `${RT}/disk-inventory.next`;

const NEXT_INVENTORY_REV = `${RT}/disk-inventory.next.rev`;

const KEEP_INVENTORY = `{ [ ! -e ${shellPath(NEXT_INVENTORY)} ] || mv ${shellPath(NEXT_INVENTORY)} ${shellPath(INVENTORY)}; } `
  + `&& mv ${shellPath(NEXT_INVENTORY_REV)} ${shellPath(INVENTORY_REV)}`;

const CHANGES = `${RT}/disk-changes`;

const STAGED_BY_AN_OLDER_IMAGE = `${RT}/disk-stage`;

const PACK = `${RT}/disk-pack/layer.sqsh`;

const LAYERS = `${RT}/disk-layers`;

const LOWERS = `${RT}/disk-lowers`;

const UPPER = `${RT}/disk-upper`;

const WORK = `${RT}/disk-work`;

const HYDRATE = `${RT}/disk-hydrate`;

const RECOVERED = `${RT}/disk-recovered.json`;

const HYDRATED = `${RT}/disk-hydrate.done`;

const HYDRATING = `${RT}/disk-hydrate.pid`;

const BLOCKS = `${RT}/disk-blocks`;

const BLOCKS_REV = `${RT}/disk-blocks.rev`;

const BLOCK_LOWER = `${RT}/disk-blk`;

export interface DiskChainPorts {
  readonly exec: (command: string) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;
  readonly readState: () => Promise<DiskChainState | null>;
  readonly writeState: (state: DiskChainState, expectedRev: number | null) => Promise<void>;
  readonly storeRoot: () => string;
  readonly storeObjectUrl: (key: string) => string;
  readonly objectBytes: (key: string) => Promise<number | undefined>;
  readonly deleteObjects: (keys: readonly string[]) => Promise<void>;
  readonly mountStore: () => Promise<void>;
  readonly excludes: () => readonly string[];
  readonly now: () => number;
  readonly log: (message: string) => void;
}

function pruneExpression(patterns: readonly string[]): string {
  const tests: string[] = [];

  for (const pattern of patterns) {
    const normalized = normalizeArchiveExclude(pattern);

    if (normalized === null) continue;
    tests.push(normalized.includes('/') ? `-path ${shellPath(`./${normalized}`)} -o -path ${shellPath(`*/${normalized}`)}` : `-name ${shellPath(normalized)}`);
  }

  return tests.length === 0 ? '' : `\\( ${tests.join(' -o ')} \\) -prune -o`;
}

/** No inode or ctime: a snapshot's restore keeps neither. */
function inventoryCommand(dir: string, excludes: readonly string[], to: string): string {
  return `cd ${shellPath(dir)} && find . -xdev ${pruneExpression(excludes)} ! -path . -printf '%P\\t%y\\t%s\\t%T@\\t%m\\t%l\\0' `
    + `| LC_ALL=C sort -z > ${shellPath(`${to}.tmp`)} && mv ${shellPath(`${to}.tmp`)} ${shellPath(to)}`;
}

function changesCommand(before: string, after: string): string {
  const changed = `${CHANGES}.changed`;
  const deleted = `${CHANGES}.deleted`;

  return [
    'set -e', `rm -rf ${shellPath(STAGED_BY_AN_OLDER_IMAGE)}`,
    `LC_ALL=C comm -z -13 ${shellPath(before)} ${shellPath(after)} | cut -z -f1 > ${shellPath(changed)}`,
    `cut -z -f1 ${shellPath(before)} > ${shellPath(`${deleted}.before`)} && cut -z -f1 ${shellPath(after)} > ${shellPath(`${deleted}.after`)}`,
    `LC_ALL=C comm -z -23 ${shellPath(`${deleted}.before`)} ${shellPath(`${deleted}.after`)} > ${shellPath(deleted)}`,
    `printf '%s %s' "$(tr -cd '\\000' < ${shellPath(changed)} | wc -c)" "$(tr -cd '\\000' < ${shellPath(deleted)} | wc -c)"`,
  ].join('\n');
}

function deltaTarCommand(dir: string, cached: boolean): string {
  return `python3 -c ${shellPath(DELTA_SCRIPT)} ${shellPath(`${CHANGES}.changed`)} ${shellPath(`${CHANGES}.deleted`)} ${shellPath(dir)} ${shellPath(BLOCKS)} ${cached ? '1' : '0'}`;
}

const DELTA_SCRIPT = `
import hashlib, io, json, os, shutil, sys, tarfile, time
changed_path, deleted_path, workdir, blocks, blocks_ok = sys.argv[1:6]
BLOCK, BIG = 16384, 1048576
nxt = blocks + '.next'
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
if blocks_ok == '1' and os.path.isfile(os.path.join(blocks, 'paths')):
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
for path in tops:
    parent, base = os.path.split(path)
    put(os.path.join('tree', parent, '.wh.' + base))
if records:
    put('.devbox-delta/manifest.json', json.dumps({'v': 4, 'files': records}).encode())
with open(os.path.join(nxt, 'paths'), 'wb') as listing:
    for path in sorted(known):
        listing.write(path.encode('utf-8', 'surrogateescape') + b'\\0')
try:
    out.close()
except BrokenPipeError:
    # The archiver stops reading at the end-of-archive blocks; the record's padding after them has no reader.
    pass
`;

/** Under one lock, so no cache carries a rev the inventory has moved past. */
function blockSwapCommand(next: string, rev: number): string {
  const swap = `[ "$(cat ${shellPath(INVENTORY_REV)} 2>/dev/null)" = ${String(rev)} ] || { rm -rf ${shellPath(next)}; exit 0; }; `
    + `rm -rf ${shellPath(BLOCKS)} && mv ${shellPath(next)} ${shellPath(BLOCKS)} && printf %s ${String(rev)} > ${shellPath(BLOCKS_REV)}`;

  return `flock ${shellPath(`${BLOCKS}.lock`)} sh -c ${shellPath(swap)}`;
}

/** `stable` keeps only a file whose size and time held across the read. */
function blockCacheCommand(root: string, inventory: string, rev: number, stable: boolean): string {
  const next = `${BLOCKS}.${stable ? 'base' : 'recovered'}`;

  return `rm -rf ${shellPath(next)} && python3 -c ${shellPath(CACHE_SCRIPT)} ${shellPath(root)} ${shellPath(inventory)} ${shellPath(next)} ${stable ? '1' : '0'} `
    + `&& ${blockSwapCommand(next, rev)}`;
}

const CACHE_SCRIPT = `
import hashlib, os, sys
root, inventory, out, stable = sys.argv[1:5]
BLOCK, BIG = 16384, 1048576
os.makedirs(out)
kept = []
for item in open(inventory, 'rb').read().split(b'\\0'):
    fields = item.decode('utf-8', 'surrogateescape').split('\\t')
    if len(fields) < 4 or fields[1] != 'f' or int(fields[2]) < BIG:
        continue
    path, size = fields[0], int(fields[2])
    seconds, _, fraction = fields[3].partition('.')
    when = int(seconds) * 1000000000 + int((fraction + '000000000')[:9])
    full = os.path.join(root, path)
    try:
        before = os.lstat(full)
        if stable == '1' and (before.st_size, before.st_mtime_ns) != (size, when):
            continue
        digests = bytearray()
        with open(full, 'rb') as source:
            while True:
                data = source.read(BLOCK)
                if not data:
                    break
                digests += hashlib.sha256(data).digest()
        after = os.lstat(full)
    except OSError:
        continue
    if stable == '1' and (after.st_size, after.st_mtime_ns) != (size, when):
        continue
    open(os.path.join(out, hashlib.sha256(path.encode('utf-8', 'surrogateescape')).hexdigest()), 'wb').write(digests)
    kept.append(path)
with open(os.path.join(out, 'paths'), 'wb') as listing:
    for path in sorted(kept):
        listing.write(path.encode('utf-8', 'surrogateescape') + b'\\0')
print(len(kept), end='')
`;

function heldBytes(state: DiskChainState): number {
  return state.deltas.reduce((sum, layer) => sum + layer.bytes, state.base.bytes);
}

function mounted(root: string, key: string): string {
  return `${STORE_MOUNT}/${key.slice(root.length + 1)}`;
}

export interface DiskChainAttach {
  readonly kind: 'empty' | 'attached';
  readonly detail: string;
  readonly recoveredTo: number | undefined;
}

export interface DiskChain {
  readonly attach: (fromSnapshot: boolean) => Effect.Effect<DiskChainAttach, DevboxError>;
  readonly commit: (kind: CheckpointKind) => Effect.Effect<CheckpointOutcome, DevboxError>;
}

export function diskChain(ports: DiskChainPorts): DiskChain {
  const run = (doing: string, command: string): Effect.Effect<string, DevboxError> => Effect.gen(function* () {
    const result = yield* attempt('io', () => ports.exec(command), doing);

    if (result.exitCode !== 0) return yield* Effect.fail(new DevboxError('io', `${doing} exited ${String(result.exitCode)}: ${(result.stderr || result.stdout).trim().slice(-800)}`));

    return result.stdout.trim();
  });

  const read = (path: string) => run(`reading ${path}`, `cat ${shellPath(path)} 2>/dev/null || true`);

  const publish = (key: string, source: ArchiveSource): Effect.Effect<number, DevboxError> => Effect.gen(function* () {
    const command = streamCommand({ ...source, archivePath: PACK, objectUrl: ports.storeObjectUrl(key), profile: DISK_STREAM });

    const result = yield* attempt('io', () => ports.exec(command), `publishing ${key}`);
    const out = result.stdout.trim();
    const [code, size] = out.split(/\s+/);
    const bytes = Number(size);

    if (result.exitCode !== 0 || code !== '0' || !Number.isSafeInteger(bytes) || bytes <= 0) {
      return yield* Effect.fail(new DevboxError('io', `publishing ${key} failed (${code ?? '?'}): ${result.stderr.trim().slice(-800) || out.slice(-400)}`));
    }

    const landed = yield* attempt('io', () => ports.objectBytes(key));

    if (landed !== bytes) return yield* Effect.fail(new DevboxError('io', `the store holds ${String(landed)} bytes for ${key} where ${String(bytes)} were sent; nothing is recorded`));
    yield* run(`reading ${key} back as a squashfs`, `/usr/bin/unsquashfs -l ${shellPath(mounted(ports.storeRoot(), key))} >/dev/null`);

    return bytes;
  });

  /** Held under its rev before the record: a keep lost after the record is redone next save. */
  const advance = (state: DiskChainState, expectedRev: number | null, staged: boolean) => Effect.gen(function* () {
    yield* run('holding the inventory', `printf %s ${String(state.rev)} > ${shellPath(NEXT_INVENTORY_REV)}`);
    yield* attempt('io', () => ports.writeState(state, expectedRev));
    yield* run('keeping the inventory', KEEP_INVENTORY + (staged ? ` && ${blockSwapCommand(`${BLOCKS}.next`, state.rev)}` : ''));
  });

  const commitBase = (prior: DiskChainState | null, at: number) => Effect.gen(function* () {
    const id = crypto.randomUUID();
    const key = `${ports.storeRoot()}/disk/${id}/base.sqsh`;
    const bytes = yield* publish(key, { sourceDir: DEVBOX_WORKDIR, excludeFile: `${RT}/disk-pack/excludes.txt`, excludes: ports.excludes() });
    const state: DiskChainState = { format: DISK_CHAIN_FORMAT, rev: (prior?.rev ?? 0) + 1, base: { key, bytes, committedAt: at }, deltas: [], committedAt: at };
    yield* advance(state, prior?.rev ?? null, false);
    yield* run('caching the base\'s block digests', blockCacheCommand(DEVBOX_WORKDIR, INVENTORY, state.rev, true)).pipe(
      Effect.catchTag('DevboxError', failure => Effect.sync(() => ports.log(`the next save sends changed large files whole: ${failure.message}`))),
    );

    if (prior !== null) {
      yield* attempt('io', () => ports.deleteObjects([prior.base.key, ...prior.deltas.map(layer => layer.key)])).pipe(
        Effect.catchTag('DevboxError', failure => Effect.sync(() => ports.log(`the superseded layers stay in the store: ${failure.message}`))),
      );
    }

    return { kind: 'committed', reason: undefined, bytes: state.base.bytes, movedBytes: bytes } satisfies CheckpointOutcome;
  });

  /** `layers` newest first; the block lower sits above the deltas' trees. */
  const mountLayers = (layers: readonly string[]) => Effect.gen(function* () {
    yield* attempt('io', () => ports.mountStore());

    const at = (index: number) => `${LAYERS}/${String(index)}`;
    const deltas = layers.slice(0, -1).map((_, index) => at(index));
    const base = at(layers.length - 1);
    const lowers = [...deltas.map(delta => `${delta}/tree`), base].map(shellPath).join(':');

    const mounts = [...layers.map((key, index) => `{ mountpoint -q ${shellPath(at(index))} || { mkdir -p ${shellPath(at(index))} && `
      + `/usr/local/bin/devbox-squashfuse ${shellPath(mounted(ports.storeRoot(), key))} ${shellPath(at(index))} -o allow_other,ro,nonempty; }; } & pids="$pids $!"`),
    'for pid in $pids; do wait "$pid"; done'];

    const blocks = `/usr/local/bin/devbox-block-lower --base ${shellPath(base)} ${[...deltas].reverse().map(delta => `--layer ${shellPath(delta)}`).join(' ')} `
      + `--mount ${shellPath(BLOCK_LOWER)} --stats ${shellPath(`${BLOCK_LOWER}.json`)}`;

    yield* run('mounting the recovered layers', [
      'set -e', "pids=''", ...mounts, `mkdir -p ${shellPath(UPPER)} ${shellPath(WORK)} ${shellPath(LOWERS)} ${shellPath(DEVBOX_WORKDIR)} ${shellPath(BLOCK_LOWER)}`,
      `top=''; held=''`,
      ...deltas.map(delta => `[ -e ${shellPath(`${delta}/.devbox-delta/manifest.json`)} ] && held=1`),
      `if [ -n "$held" ]; then`,
      // A shell holding the exec's stdout holds the exec (D64).
      `  mountpoint -q ${shellPath(BLOCK_LOWER)} || { (cd / && exec setsid nohup ${blocks}) >${shellPath(`${BLOCK_LOWER}.log`)} 2>&1 </dev/null &`,
      `    for i in $(seq 1 100); do mountpoint -q ${shellPath(BLOCK_LOWER)} && break; sleep 0.1; done; }`,
      `  mountpoint -q ${shellPath(BLOCK_LOWER)} || { cat ${shellPath(`${BLOCK_LOWER}.log`)} >&2; exit 1; }`,
      `  top=${shellPath(BLOCK_LOWER)}:`,
      'fi',
      `{ mountpoint -q ${shellPath(DEVBOX_WORKDIR)} || /usr/bin/fuse-overlayfs -o "lowerdir=$top"${lowers},upperdir=${shellPath(UPPER)},workdir=${shellPath(WORK)} ${shellPath(DEVBOX_WORKDIR)}; } & work=$!`,
      `mountpoint -q ${shellPath(LOWERS)} || /usr/bin/fuse-overlayfs -o "lowerdir=$top"${lowers} ${shellPath(LOWERS)}`,
      'wait "$work"',
    ].join('\n'));
  });

  const startHydration = (rev: number, layers: readonly string[]) => {
    const recovered = `${INVENTORY}.recovered`;

    // s3fs keeps each layer byte it reads on this disk.
    const fits = `need=$(( $(tr '\\0' '\\n' < ${shellPath(recovered)} | awk -F '\\t' '{s+=$3} END {printf "%d", s}') `
      + `+ $(stat -c %s ${layers.map(key => shellPath(mounted(ports.storeRoot(), key))).join(' ')} | awk '{s+=$1} END {printf "%d", s}') + ${String(COPY_HEADROOM)} )); `
      + `[ "$need" -le "$(df -B1 --output=avail ${shellPath(RT)} | tail -1)" ] || { echo "the copy needs $need bytes free; the workspace stays lazy"; exit 0; }`;

    // Once per recovery.
    const script = `${inventoryCommand(LOWERS, ports.excludes(), recovered)} `
      + `&& { [ -e ${shellPath(INVENTORY_REV)} ] || { cp ${shellPath(recovered)} ${shellPath(INVENTORY)} && printf %s ${String(rev)} > ${shellPath(INVENTORY_REV)}; }; } `
      + `&& { ${fits}; } && rm -rf ${shellPath(`${HYDRATE}.tmp`)} && mkdir -p ${shellPath(`${HYDRATE}.tmp`)} `
      + `&& cp -a ${shellPath(LOWERS)}/. ${shellPath(`${HYDRATE}.tmp`)}/ && { ${blockCacheCommand(`${HYDRATE}.tmp`, recovered, rev, false)} || true; } `
      + `&& mv ${shellPath(`${HYDRATE}.tmp`)} ${shellPath(HYDRATE)} && touch ${shellPath(HYDRATED)}`;

    return run('starting the copy to disk', `cd / && { setsid nohup sh -c ${shellPath(script)} >${shellPath(`${RT}/disk-hydrate.log`)} 2>&1 </dev/null & `
      + `echo $! > ${shellPath(HYDRATING)}; }`).pipe(Effect.asVoid);
  };

  const recovery = () => Effect.gen(function* () {
    const recorded = yield* read(RECOVERED);

    if (recorded === '') return null;
    const parsed = v.safeParse(v.object({ rev: v.number(), layers: v.array(v.string()) }), yield* attemptSync('io', () => JSON.parse(recorded)));

    return parsed.success ? parsed.output : yield* Effect.fail(new DevboxError('io', `the recovery record at ${RECOVERED} does not parse`));
  });

  const commit = (kind: CheckpointKind): Effect.Effect<CheckpointOutcome, DevboxError> => Effect.gen(function* () {
    const at = ports.now();
    const state = yield* attempt('io', () => ports.readState());

    yield* attempt('io', () => ports.mountStore());

    if (state !== null && (yield* read(NEXT_INVENTORY_REV)) === String(state.rev)) yield* run('keeping the inventory', KEEP_INVENTORY);
    const recovered = yield* recovery();
    const recovering = recovered !== null;
    const baseline = yield* read(INVENTORY_REV);
    const dir = DEVBOX_WORKDIR;

    if (state !== null && recovered !== null && baseline !== String(state.rev)) {
      if ((yield* run('checking the copy', `kill -0 "$(cat ${shellPath(HYDRATING)} 2>/dev/null)" 2>/dev/null && echo alive || true`)) !== 'alive') {
        yield* startHydration(recovered.rev, recovered.layers);
      }

      return { kind: 'skipped', reason: 'the recovery is still taking its baseline', bytes: heldBytes(state), movedBytes: 0 } satisfies CheckpointOutcome;
    }

    yield* run('taking the inventory', inventoryCommand(dir, ports.excludes(), NEXT_INVENTORY));

    // A baseline not the record's can only save a base.
    if (state === null || baseline !== String(state.rev)) return yield* commitBase(state, at);

    if (kind === 'quiesce' && !recovering && (state.deltas.length >= COMPACT_LAYERS || heldBytes(state) - state.base.bytes > COMPACT_SHARE * state.base.bytes)) {
      return yield* commitBase(state, at);
    }

    const cached = (yield* read(BLOCKS_REV)) === baseline;
    const [changed = '0', deleted = '0'] = (yield* run('listing the changes', changesCommand(INVENTORY, NEXT_INVENTORY))).split(' ');

    if (changed === '0' && deleted === '0') {
      return { kind: 'skipped', reason: 'nothing changed since the last save', bytes: heldBytes(state), movedBytes: 0 } satisfies CheckpointOutcome;
    }

    const key = `${state.base.key.slice(0, state.base.key.lastIndexOf('/'))}/delta-${String(state.deltas.length + 1)}-${crypto.randomUUID()}.sqsh`;
    const bytes = yield* publish(key, { tar: deltaTarCommand(dir, cached) });
    const next: DiskChainState = { ...state, rev: state.rev + 1, deltas: [...state.deltas, { key, bytes, committedAt: at }], committedAt: at };
    yield* advance(next, state.rev, true);

    return { kind: 'committed', reason: undefined, bytes: heldBytes(next), movedBytes: bytes } satisfies CheckpointOutcome;
  });

  const recover = (): Effect.Effect<DiskChainAttach, DevboxError> => Effect.gen(function* () {
    const state = yield* attempt('io', () => ports.readState());

    if (state === null) return { kind: 'empty', detail: 'no disk chain record', recoveredTo: undefined };
    const layers = [...state.deltas].reverse().map(layer => layer.key).concat(state.base.key);
    yield* run('recording the recovery', `mkdir -p ${shellPath(RT)} && printf %s ${shellPath(JSON.stringify({ rev: state.rev, layers }))} > ${shellPath(RECOVERED)} `
      + `&& rm -f ${shellPath(INVENTORY_REV)} ${shellPath(HYDRATED)}`);
    yield* mountLayers(layers);
    yield* startHydration(state.rev, layers);

    return { kind: 'attached', detail: `rev ${String(state.rev)}, ${String(layers.length)} layers, lazy`, recoveredTo: state.committedAt };
  });

  /** A finished copy becomes the plain workspace with the upper merged in; else the overlay remounts. */
  const resume = (recovered: { readonly rev: number; readonly layers: readonly string[] }) => Effect.gen(function* () {
    const [workspace, hydrated] = (yield* run('checking the recovery', `mountpoint -q ${shellPath(DEVBOX_WORKDIR)} && echo mounted || echo unmounted; `
      + `[ -e ${shellPath(HYDRATED)} ] && echo done || echo copying`)).split('\n');

    if (workspace === 'mounted') return 'resumed';

    if (hydrated !== 'done') {
      yield* mountLayers(recovered.layers);
      yield* startHydration(recovered.rev, recovered.layers);

      return 'remounted';
    }

    yield* run('merging the upper into the copy', `python3 -c ${shellPath(MERGE_UPPER)} ${shellPath(UPPER)} ${shellPath(HYDRATE)} && `
      + `rmdir ${shellPath(DEVBOX_WORKDIR)} && mv ${shellPath(HYDRATE)} ${shellPath(DEVBOX_WORKDIR)} && `
      + `rm -rf ${shellPath(UPPER)} ${shellPath(WORK)} ${shellPath(LAYERS)} ${shellPath(LOWERS)} ${shellPath(RECOVERED)} ${shellPath(HYDRATED)}`);

    return 'made plain';
  });

  const attach = (fromSnapshot: boolean): Effect.Effect<DiskChainAttach, DevboxError> => Effect.gen(function* () {
    const recovered = yield* recovery();

    if (recovered !== null) return { kind: 'attached', detail: `recovery ${yield* resume(recovered)}`, recoveredTo: undefined };

    if (fromSnapshot) return { kind: 'attached', detail: 'the snapshot holds the workspace', recoveredTo: undefined };

    return yield* recover();
  });

  return { attach, commit };
}

export class DiskChainStorage implements DevboxStorage {
  readonly #chain: DiskChain;
  readonly #host: DiskChainHost;
  readonly discard: () => Promise<void>;

  constructor(chain: DiskChain, host: DiskChainHost) {
    this.#chain = chain;
    this.#host = host;
    this.discard = host.discard;
  }

  attach(): Promise<AttachOutcome> {
    const { prepare, fromSnapshot, recovered } = this.#host;
    const chain = this.#chain;

    return settle(Effect.gen(function* () {
      yield* prepare();
      const attached = yield* chain.attach(fromSnapshot());
      const restoredTo = attached.recoveredTo;

      if (restoredTo !== undefined) yield* attempt('io', () => recovered(restoredTo));

      return { kind: attached.kind, detail: attached.detail };
    }));
  }

  checkpoint(kind: CheckpointKind): Promise<CheckpointOutcome> {
    return settle(this.#chain.commit(kind).pipe(Effect.catchTag('DevboxError', failure => Effect.succeed<CheckpointOutcome>({
      kind: 'failed', reason: failure.message, bytes: undefined, movedBytes: undefined,
    }))));
  }
}

export interface DiskChainHost {
  readonly prepare: () => Effect.Effect<void, DevboxError>;
  readonly fromSnapshot: () => boolean;
  readonly recovered: (restoredTo: number) => Promise<void>;
  readonly discard: () => Promise<void>;
}

export function recoveryNotice(restoredTo: number, excludes: readonly string[]): string {
  return `The workspace was restored from its backup to ${new Date(restoredTo).toISOString()}: its snapshot was lost, expired or older than the backup. `
    + `The backup never holds ${excludes.join(', ')}; rebuild those (for example \`bun install\`) before relying on them.`;
}

/** Applies an overlay upper to a plain tree on the same filesystem. */
const MERGE_UPPER = `
import os, shutil, stat, sys
upper, tree = sys.argv[1], sys.argv[2]
def opaque(path):
    for name in ('trusted.overlay.opaque', 'user.overlay.opaque', 'user.fuseoverlayfs.opaque'):
        try:
            if os.getxattr(path, name, follow_symlinks=False) in (b'y', b'Y'):
                return True
        except OSError:
            pass
    return os.path.lexists(os.path.join(path, '.wh..wh..opq'))
def remove(path):
    if os.path.isdir(path) and not os.path.islink(path):
        shutil.rmtree(path)
    elif os.path.lexists(path):
        os.unlink(path)
dirs = []
for here, subdirs, files in os.walk(upper):
    rel = os.path.relpath(here, upper)
    target = tree if rel == '.' else os.path.join(tree, rel)
    if rel != '.':
        if opaque(here) or (os.path.lexists(target) and not os.path.isdir(target)):
            remove(target)
        os.makedirs(target, exist_ok=True)
        dirs.append((here, target))
    for name in subdirs + files:
        source = os.path.join(here, name)
        if name in subdirs and not os.path.islink(source):
            continue
        info = os.lstat(source)
        if name == '.wh..wh..opq':
            continue
        if name.startswith('.wh.'):
            remove(os.path.join(target, name[4:]))
        elif stat.S_ISCHR(info.st_mode) and info.st_rdev == 0:
            remove(os.path.join(target, name))
        else:
            remove(os.path.join(target, name))
            os.rename(source, os.path.join(target, name))
for here, target in reversed(dirs):
    info = os.lstat(here)
    os.chmod(target, stat.S_IMODE(info.st_mode))
    os.utime(target, ns=(info.st_atime_ns, info.st_mtime_ns))
`;

