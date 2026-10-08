// D55's R2 backup: a save publishes a layer of what changed, a large file as its changed blocks
// (D63), and takes in the newest layers as a binary counter does (D77); a recovery mounts the layers lazily in the gate
// (R1, R2) and copies them to disk.
import { Effect } from 'effect';
import * as v from 'valibot';
import { DevboxError, attempt, attemptSync, settle } from './errors';
import { DEVBOX_RUNTIME_DIR, DEVBOX_WORKDIR, type AttachOutcome, type CheckpointKind, type CheckpointOutcome, type DevboxStorage } from './storage';
import { STORE_MOUNT } from './store-gateway';
import { deltaTarCommand, levelsAfter, mergeListsCommand } from './disk-delta';
import { type ArchiveSource, DISK_STREAM, normalizeArchiveExclude, shellPath, streamCommand } from './stream-archive';

/** What a save leaves out unless a box names its own: each regenerates from the rest. */
export const DEFAULT_EXCLUDES = ['node_modules', '*.log', '.cache', '.bun', '__pycache__', '.venv', 'target', '.next', '.turbo', 'dist'] as const;

const DISK_CHAIN_FORMAT = 'disk-chain/2';

/** The SHA-256 of each part's SHA-256 in order, `partBytes` apiece, as the publisher reported it. */
const LayerDigest = v.object({ sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)), partBytes: v.pipe(v.number(), v.safeInteger(), v.minValue(1)) });

const Layer = v.object({
  key: v.string(), bytes: v.pipe(v.number(), v.safeInteger(), v.minValue(1)), committedAt: v.number(), digest: LayerDigest,
});

/** `saves`: how many saves the layer covers, from the boundary below it; a delta from before D77 covers one. */
const Delta = v.object({ ...Layer.entries, saves: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1)), 1) });

export const DiskChainStateSchema = v.object({
  format: v.literal(DISK_CHAIN_FORMAT),
  rev: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  base: Layer,
  deltas: v.array(Delta),
  committedAt: v.number(),
});

export type DiskChainState = v.InferOutput<typeof DiskChainStateSchema>;

const COMPACT_SHARE = 0.25;

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

/** What a recovery mounted, newest first, and the digests the layers' publications reported. */
const RecoveryRecord = v.object({
  rev: v.number(),
  layers: v.array(v.string()),
  digests: v.array(v.object({ key: v.string(), ...LayerDigest.entries })),
});

/** The words of a copy that refused itself: a layer it read is not the one that was published. */
const HYDRATE_REFUSED = `${RT}/disk-hydrate.refused`;

const HYDRATED = `${RT}/disk-hydrate.done`;

const HYDRATING = `${RT}/disk-hydrate.pid`;

const BLOCKS = `${RT}/disk-blocks`;

const BLOCKS_REV = `${RT}/disk-blocks.rev`;

const BLOCK_LOWER = `${RT}/disk-blk`;

/** Each kept delta's own list of the paths it answers for: a merge's changes are their union. */
const LEVELS = `${RT}/disk-levels`;

/** The block digests held for each boundary below a kept layer, so a merge cut from there sends changed blocks. */
const BOUNDS = `${RT}/disk-bounds`;

/** A layer's name on this disk: its object's base directory and file, unique to it. */
function levelName(key: string): string {
  return key.split('/').slice(-2).join('-');
}

function levelList(key: string): string {
  return `${LEVELS}/${levelName(key)}.paths`;
}

/** The digests of the tree the last save left, kept as the boundary `bound` names, if they are that tree's. */
function keepBoundCommand(bound: string, rev: string): string {
  const keep = `[ "$(cat ${shellPath(BLOCKS_REV)} 2>/dev/null)" = ${shellPath(rev)} ] || exit 0; `
    + `mkdir -p ${shellPath(BOUNDS)} && rm -rf ${shellPath(bound)} && cp -al ${shellPath(BLOCKS)} ${shellPath(bound)}`;

  return `flock ${shellPath(`${BLOCKS}.lock`)} sh -c ${shellPath(keep)}`;
}

/** Each merged layer's list, from this disk or else from its object; a line for each that neither holds. */
function gatherCommand(root: string, keys: readonly string[]): string {
  const scratch = shellPath(`${LEVELS}/.gather`);

  return [`mkdir -p ${shellPath(LEVELS)}`, ...keys.map((key) => {
    const local = shellPath(levelList(key));

    return `[ -e ${local} ] || { rm -rf ${scratch}; /usr/bin/unsquashfs -no-progress -d ${scratch} -f ${shellPath(mounted(root, key))} .devbox-delta/paths >/dev/null 2>&1; `
      + `[ -e ${scratch}/.devbox-delta/paths ] && mv ${scratch}/.devbox-delta/paths ${local}; rm -rf ${scratch}; }; [ -e ${local} ] || echo missing`;
  })].join('\n');
}

/** Only what a later merge is cut from: each kept delta's list, and the digests of each boundary below a kept delta. */
function pruneLevelsCommand(state: DiskChainState): string {
  const sweep = (dir: string, keep: readonly string[]) => `keep=${shellPath(` ${keep.join(' ')} `)}; for f in ${shellPath(dir)}/*; do [ -e "$f" ] || continue; `
    + 'case "$keep" in *" $(basename "$f") "*) ;; *) rm -rf "$f";; esac; done';

  return `${sweep(LEVELS, state.deltas.map((delta) => `${levelName(delta.key)}.paths`))}; `
    + `${sweep(BOUNDS, [state.base, ...state.deltas.slice(0, -1)].map((layer) => levelName(layer.key)))}`;
}

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

interface DiskChainAttach {
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

  const publish = (key: string, source: ArchiveSource): Effect.Effect<{ readonly bytes: number; readonly digest: v.InferOutput<typeof LayerDigest> }, DevboxError> => Effect.gen(function* () {
    const command = streamCommand({ ...source, archivePath: PACK, objectUrl: ports.storeObjectUrl(key), profile: DISK_STREAM });

    const result = yield* attempt('io', () => ports.exec(command), `publishing ${key}`);
    const out = result.stdout.trim();
    const [code, size, , sha256] = out.split(/\s+/);
    const bytes = Number(size);
    const digest = v.safeParse(LayerDigest, { sha256, partBytes: DISK_STREAM.partBytes });

    if (result.exitCode !== 0 || code !== '0' || !Number.isSafeInteger(bytes) || bytes <= 0 || !digest.success) {
      return yield* Effect.fail(new DevboxError('io', `publishing ${key} failed (${code ?? '?'}): ${result.stderr.trim().slice(-800) || out.slice(-400)}`));
    }

    const landed = yield* attempt('io', () => ports.objectBytes(key));

    if (landed !== bytes) return yield* Effect.fail(new DevboxError('io', `the store holds ${String(landed)} bytes for ${key} where ${String(bytes)} were sent; nothing is recorded`));
    yield* run(`reading ${key} back as a squashfs`, `/usr/bin/unsquashfs -l ${shellPath(mounted(ports.storeRoot(), key))} >/dev/null`);

    return { bytes, digest: digest.output };
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
    const { bytes, digest } = yield* publish(key, { sourceDir: DEVBOX_WORKDIR, excludeFile: `${RT}/disk-pack/excludes.txt`, excludes: ports.excludes() });
    const state: DiskChainState = { format: DISK_CHAIN_FORMAT, rev: (prior?.rev ?? 0) + 1, base: { key, bytes, committedAt: at, digest }, deltas: [], committedAt: at };
    yield* advance(state, prior?.rev ?? null, false);
    yield* run('forgetting the levels', `rm -rf ${shellPath(LEVELS)} ${shellPath(BOUNDS)}`);
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

  const startHydration = (rev: number, layers: readonly string[], digests: v.InferOutput<typeof RecoveryRecord>['digests']) => {
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
      // The copy has read every layer byte through the cache; each is held to the digest its publication reported.
      + `&& python3 -c ${shellPath(VERIFY_LAYERS)} ${shellPath(HYDRATE_REFUSED)} `
      + `${digests.map(layer => `${shellPath(mounted(ports.storeRoot(), layer.key))} ${layer.sha256} ${String(layer.partBytes)}`).join(' ')} `
      + `&& mv ${shellPath(`${HYDRATE}.tmp`)} ${shellPath(HYDRATE)} && touch ${shellPath(HYDRATED)}`;

    return run('starting the copy to disk', `cd / && { setsid nohup sh -c ${shellPath(script)} >${shellPath(`${RT}/disk-hydrate.log`)} 2>&1 </dev/null & `
      + `echo $! > ${shellPath(HYDRATING)}; }`).pipe(Effect.asVoid);
  };

  const recovery = () => Effect.gen(function* () {
    const recorded = yield* read(RECOVERED);

    if (recorded === '') return null;
    const parsed = v.safeParse(RecoveryRecord, yield* attemptSync('io', () => JSON.parse(recorded)));

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
        yield* startHydration(recovered.rev, recovered.layers, recovered.digests);
      }

      return { kind: 'skipped', reason: 'the recovery is still taking its baseline', bytes: heldBytes(state), movedBytes: 0 } satisfies CheckpointOutcome;
    }

    yield* run('taking the inventory', inventoryCommand(dir, ports.excludes(), NEXT_INVENTORY));

    // A baseline not the record's can only save a base.
    if (state === null || baseline !== String(state.rev)) return yield* commitBase(state, at);

    if (kind === 'quiesce' && !recovering && heldBytes(state) - state.base.bytes > COMPACT_SHARE * state.base.bytes) return yield* commitBase(state, at);
    const [changed = '0', deleted = '0'] = (yield* run('listing the changes', changesCommand(INVENTORY, NEXT_INVENTORY))).split(' ');

    if (changed === '0' && deleted === '0') {
      return { kind: 'skipped', reason: 'nothing changed since the last save', bytes: heldBytes(state), movedBytes: 0 } satisfies CheckpointOutcome;
    }

    const { keep, saves } = levelsAfter(state.deltas, new Set(recovered?.layers));
    const replaced = state.deltas.slice(keep);
    const bound = `${BOUNDS}/${levelName((state.deltas[keep - 1] ?? state.base).key)}`;

    // An appended layer is cut from the tree the last save left, whose digests become the boundary below it.
    if (replaced.length === 0) yield* run('keeping the boundary', keepBoundCommand(bound, baseline));

    if (replaced.length !== 0 && (yield* run('gathering the merged layers\' paths', gatherCommand(ports.storeRoot(), replaced.map(layer => layer.key)))) !== '') {
      ports.log('a merged layer\'s paths are held neither here nor in its object, so this save is a base');

      return yield* commitBase(state, at);
    }

    if (replaced.length !== 0) yield* run('merging the change lists', mergeListsCommand(CHANGES, NEXT_INVENTORY, replaced.map(layer => levelList(layer.key))));
    const below = (yield* run('finding the boundary\'s digests', `[ -d ${shellPath(bound)} ] && echo held || true`)) === 'held' ? bound : null;
    const key = `${state.base.key.slice(0, state.base.key.lastIndexOf('/'))}/delta-${String(keep + 1)}-${crypto.randomUUID()}.sqsh`;
    const { bytes, digest } = yield* publish(key, { tar: deltaTarCommand({ dir, changes: CHANGES, below, next: `${BLOCKS}.next`, listing: levelList(key) }) });
    const next: DiskChainState = { ...state, rev: state.rev + 1, deltas: [...state.deltas.slice(0, keep), { key, bytes, committedAt: at, saves, digest }], committedAt: at };
    yield* advance(next, state.rev, true);
    yield* run('pruning the levels', pruneLevelsCommand(next)).pipe(
      Effect.catchTag('DevboxError', failure => Effect.sync(() => ports.log(`stale levels stay on this disk: ${failure.message}`))),
    );

    if (replaced.length !== 0) {
      yield* attempt('io', () => ports.deleteObjects(replaced.map(layer => layer.key))).pipe(
        Effect.catchTag('DevboxError', failure => Effect.sync(() => ports.log(`the merged layers stay in the store: ${failure.message}`))),
      );
    }

    return { kind: 'committed', reason: undefined, bytes: heldBytes(next), movedBytes: bytes } satisfies CheckpointOutcome;
  });

  const recover = (): Effect.Effect<DiskChainAttach, DevboxError> => Effect.gen(function* () {
    const state = yield* attempt('io', () => ports.readState());

    if (state === null) return { kind: 'empty', detail: 'no disk chain record', recoveredTo: undefined };
    const held = [...[...state.deltas].reverse(), state.base];
    const layers = held.map(layer => layer.key);
    const digests = held.map(layer => ({ key: layer.key, ...layer.digest }));
    yield* run('recording the recovery', `mkdir -p ${shellPath(RT)} && printf %s ${shellPath(JSON.stringify({ rev: state.rev, layers, digests }))} > ${shellPath(RECOVERED)} `
      + `&& rm -f ${shellPath(INVENTORY_REV)} ${shellPath(HYDRATED)} ${shellPath(HYDRATE_REFUSED)}`);
    yield* mountLayers(layers);
    yield* startHydration(state.rev, layers, digests);

    return { kind: 'attached', detail: `rev ${String(state.rev)}, ${String(layers.length)} layers, lazy`, recoveredTo: state.committedAt };
  });

  /** A finished copy becomes the plain workspace with the upper merged in; else the overlay remounts. */
  const resume = (recovered: v.InferOutput<typeof RecoveryRecord>) => Effect.gen(function* () {
    const [workspace, hydrated] = (yield* run('checking the recovery', `mountpoint -q ${shellPath(DEVBOX_WORKDIR)} && echo mounted || echo unmounted; `
      + `[ -e ${shellPath(HYDRATED)} ] && echo done || echo copying`)).split('\n');

    if (workspace === 'mounted') return 'resumed';
    const refused = yield* read(HYDRATE_REFUSED);

    // The workspace is served from layers that are not the ones published; nothing here makes them right.
    if (refused !== '') return yield* Effect.fail(new DevboxError('refused', `the restored workspace was not committed to disk: ${refused}`));

    if (hydrated !== 'done') {
      yield* mountLayers(recovered.layers);
      yield* startHydration(recovered.rev, recovered.layers, recovered.digests);

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

/** Holds each layer to its published digest: argv is the refusal file, then path, SHA-256 and part size per layer. */
const VERIFY_LAYERS = `
import hashlib, sys
refused, rest = sys.argv[1], sys.argv[2:]
for at in range(0, len(rest), 3):
    path, want, part = rest[at], rest[at + 1], int(rest[at + 2])
    parts = hashlib.sha256()
    with open(path, 'rb') as layer:
        while True:
            chunk = layer.read(part)
            if not chunk:
                break
            parts.update(hashlib.sha256(chunk).digest())
    held = parts.hexdigest()
    if held != want:
        with open(refused, 'w') as out:
            out.write('the layer ' + path + ' reads as sha256 ' + held + ' where its publication recorded ' + want)
        sys.exit(3)
`;

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

