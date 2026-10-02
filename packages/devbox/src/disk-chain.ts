// D55's R2 backup: a save publishes an overlay layer of what changed since the last; a recovery
// mounts the layers lazily in the gate (R1, R2) and copies them to disk behind it.
import { Effect } from 'effect';
import * as v from 'valibot';
import { shellPath } from './chunked-delta';
import { DevboxError, attempt, attemptSync, settle } from './errors';
import { DEVBOX_RUNTIME_DIR, DEVBOX_WORKDIR, type AttachOutcome, type CheckpointKind, type CheckpointOutcome, type DevboxStorage } from './storage';
import { DISK_STREAM, normalizeArchiveExclude, streamCommand } from './stream-archive';

const DISK_CHAIN_FORMAT = 'disk-chain/1';

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

export const DISK_CHAIN_STORE_MOUNT = '/backups';

const RT = DEVBOX_RUNTIME_DIR;

const INVENTORY = `${RT}/disk-inventory`;

const INVENTORY_REV = `${RT}/disk-inventory.rev`;

const NEXT_INVENTORY = `${RT}/disk-inventory.next`;

const STAGE = `${RT}/disk-stage`;

const PACK = `${RT}/disk-pack/layer.sqsh`;

const LAYERS = `${RT}/disk-layers`;

const LOWERS = `${RT}/disk-lowers`;

const UPPER = `${RT}/disk-upper`;

const WORK = `${RT}/disk-work`;

const HYDRATE = `${RT}/disk-hydrate`;

const RECOVERED = `${RT}/disk-recovered.json`;

const HYDRATED = `${RT}/disk-hydrate.done`;

const HYDRATING = `${RT}/disk-hydrate.pid`;

/** `safe` when a snapshot holds the whole workspace: not an older chain's overlay. */
export const SNAPSHOT_SAFE_COMMAND = `if mountpoint -q ${DEVBOX_WORKDIR} && [ ! -e ${RECOVERED} ]; then echo unsafe; else echo safe; fi`;

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
  readonly checkpointIntervalMs: () => number;
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

function stageDeltaCommand(dir: string, before: string, after: string): string {
  const changed = `${STAGE}.changed`;
  const deleted = `${STAGE}.deleted`;
  const list = `${STAGE}.list`;

  return [
    'set -e', `rm -rf ${shellPath(STAGE)} && mkdir -p ${shellPath(STAGE)}`,
    `LC_ALL=C comm -z -13 ${shellPath(before)} ${shellPath(after)} | cut -z -f1 > ${shellPath(changed)}`,
    `cut -z -f1 ${shellPath(before)} > ${shellPath(`${deleted}.before`)} && cut -z -f1 ${shellPath(after)} > ${shellPath(`${deleted}.after`)}`,
    `LC_ALL=C comm -z -23 ${shellPath(`${deleted}.before`)} ${shellPath(`${deleted}.after`)} > ${shellPath(deleted)}`,
    `counts=$(python3 -c ${shellPath(STAGE_SCRIPT)} ${shellPath(STAGE)} ${shellPath(changed)} ${shellPath(deleted)} ${shellPath(list)})`,
    `tar -C ${shellPath(dir)} --null --no-recursion --ignore-failed-read --warning=no-file-changed -T ${shellPath(list)} -cf - | tar -C ${shellPath(STAGE)} -xpf -`,
    'printf %s "$counts"',
  ].join('\n');
}

const STAGE_SCRIPT = `
import os, sys
stage, changed_path, deleted_path, list_path = sys.argv[1:5]
def entries(path):
    return [item.decode('utf-8', 'surrogateescape') for item in open(path, 'rb').read().split(b'\\0') if item]
changed, deleted = entries(changed_path), entries(deleted_path)
gone, tops = set(), []
for path in deleted:
    parts = path.split('/')
    if any('/'.join(parts[:at]) in gone for at in range(1, len(parts))):
        continue
    gone.add(path)
    tops.append(path)
wanted = set(changed)
for path in changed + tops:
    parts = path.split('/')
    wanted.update('/'.join(parts[:at]) for at in range(1, len(parts)))
for path in tops:
    parent, name = os.path.split(path)
    os.makedirs(os.path.join(stage, parent), exist_ok=True)
    open(os.path.join(stage, parent, '.wh.' + name), 'w').close()
with open(list_path, 'wb') as out:
    for path in sorted(wanted):
        out.write(path.encode('utf-8', 'surrogateescape') + b'\\0')
print(len(changed), len(tops), end='')
`;

function heldBytes(state: DiskChainState): number {
  return state.deltas.reduce((sum, layer) => sum + layer.bytes, state.base.bytes);
}

function mounted(root: string, key: string): string {
  return `${DISK_CHAIN_STORE_MOUNT}/${key.slice(root.length + 1)}`;
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

  const publish = (key: string, sourceDir: string, excludes: readonly string[]): Effect.Effect<number, DevboxError> => Effect.gen(function* () {
    const out = yield* run(`publishing ${key}`, streamCommand({
      sourceDir, archivePath: PACK, excludeFile: `${RT}/disk-pack/excludes.txt`, excludes, objectUrl: ports.storeObjectUrl(key), profile: DISK_STREAM,
    }));

    const [code, size] = out.split(/\s+/);
    const bytes = Number(size);

    if (code !== '0' || !Number.isSafeInteger(bytes) || bytes <= 0) return yield* Effect.fail(new DevboxError('io', `publishing ${key} failed (${code ?? '?'}): ${out.slice(-400)}`));
    const landed = yield* attempt('io', () => ports.objectBytes(key));

    if (landed !== bytes) return yield* Effect.fail(new DevboxError('io', `the store holds ${String(landed)} bytes for ${key} where ${String(bytes)} were sent; nothing is recorded`));
    yield* run(`reading ${key} back as a squashfs`, `/usr/bin/unsquashfs -l ${shellPath(mounted(ports.storeRoot(), key))} >/dev/null`);

    return bytes;
  });

  /** The pre-pack inventory is the baseline once the record names the layer. */
  const advance = (state: DiskChainState, expectedRev: number | null) => Effect.gen(function* () {
    yield* attempt('io', () => ports.writeState(state, expectedRev));
    yield* run('keeping the inventory', `mv ${shellPath(NEXT_INVENTORY)} ${shellPath(INVENTORY)} && printf %s ${String(state.rev)} > ${shellPath(INVENTORY_REV)}`);
  });

  const commitBase = (prior: DiskChainState | null, at: number) => Effect.gen(function* () {
    const id = crypto.randomUUID();
    const key = `${ports.storeRoot()}/disk/${id}/base.sqsh`;
    const bytes = yield* publish(key, DEVBOX_WORKDIR, ports.excludes());
    const state: DiskChainState = { format: DISK_CHAIN_FORMAT, rev: (prior?.rev ?? 0) + 1, base: { key, bytes, committedAt: at }, deltas: [], committedAt: at };
    yield* advance(state, prior?.rev ?? null);

    if (prior !== null) {
      yield* attempt('io', () => ports.deleteObjects([prior.base.key, ...prior.deltas.map(layer => layer.key)])).pipe(
        Effect.catchTag('DevboxError', failure => Effect.sync(() => ports.log(`the superseded layers stay in the store: ${failure.message}`))),
      );
    }

    return { kind: 'committed', reason: undefined, bytes: state.base.bytes, movedBytes: bytes } satisfies CheckpointOutcome;
  });

  const mountLayers = (layers: readonly string[]) => Effect.gen(function* () {
    yield* attempt('io', () => ports.mountStore());

    const lowers = layers.map((_, at) => `${LAYERS}/${String(at)}`);

    const mounts = layers.map((key, at) => `mountpoint -q ${shellPath(`${LAYERS}/${String(at)}`)} || { mkdir -p ${shellPath(`${LAYERS}/${String(at)}`)} && `
      + `/usr/local/bin/devbox-squashfuse ${shellPath(mounted(ports.storeRoot(), key))} ${shellPath(`${LAYERS}/${String(at)}`)} -o allow_other,ro,nonempty; }`);

    yield* run('mounting the recovered layers', [
      'set -e', ...mounts, `mkdir -p ${shellPath(UPPER)} ${shellPath(WORK)} ${shellPath(LOWERS)} ${shellPath(DEVBOX_WORKDIR)}`,
      `mountpoint -q ${shellPath(DEVBOX_WORKDIR)} || /usr/bin/fuse-overlayfs -o lowerdir=${lowers.map(shellPath).join(':')},upperdir=${shellPath(UPPER)},workdir=${shellPath(WORK)} ${shellPath(DEVBOX_WORKDIR)}`,
      `mountpoint -q ${shellPath(LOWERS)} || /usr/bin/fuse-overlayfs -o lowerdir=${lowers.map(shellPath).join(':')} ${shellPath(LOWERS)}`,
    ].join('\n'));
  });

  const startHydration = (rev: number) => {
    const script = `${inventoryCommand(LOWERS, ports.excludes(), `${INVENTORY}.recovered`)} && mv ${shellPath(`${INVENTORY}.recovered`)} ${shellPath(INVENTORY)} `
      + `&& printf %s ${String(rev)} > ${shellPath(INVENTORY_REV)} && rm -rf ${shellPath(`${HYDRATE}.tmp`)} && mkdir -p ${shellPath(`${HYDRATE}.tmp`)} `
      + `&& cp -a ${shellPath(LOWERS)}/. ${shellPath(`${HYDRATE}.tmp`)}/ && mv ${shellPath(`${HYDRATE}.tmp`)} ${shellPath(HYDRATE)} && touch ${shellPath(HYDRATED)}`;

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

    if (kind === 'tick' && state !== null && at - state.committedAt < ports.checkpointIntervalMs()) {
      return { kind: 'skipped', reason: 'within the minimum checkpoint interval', bytes: heldBytes(state), movedBytes: 0 } satisfies CheckpointOutcome;
    }

    yield* attempt('io', () => ports.mountStore());
    const recovered = yield* recovery();
    const recovering = recovered !== null;
    const baseline = yield* read(INVENTORY_REV);
    const dir = DEVBOX_WORKDIR;

    if (state !== null && recovered !== null && baseline !== String(state.rev)) {
      if ((yield* run('checking the copy', `kill -0 "$(cat ${shellPath(HYDRATING)} 2>/dev/null)" 2>/dev/null && echo alive || true`)) !== 'alive') {
        yield* startHydration(recovered.rev);
      }

      return { kind: 'skipped', reason: 'the recovery is still taking its baseline', bytes: heldBytes(state), movedBytes: 0 } satisfies CheckpointOutcome;
    }

    yield* run('taking the inventory', inventoryCommand(dir, ports.excludes(), NEXT_INVENTORY));

    // A baseline not the record's can only save a base.
    if (state === null || baseline !== String(state.rev)) return yield* commitBase(state, at);

    if (kind === 'quiesce' && !recovering && (state.deltas.length >= COMPACT_LAYERS || heldBytes(state) - state.base.bytes > COMPACT_SHARE * state.base.bytes)) {
      return yield* commitBase(state, at);
    }

    const [changed = '0', deleted = '0'] = (yield* run('staging the changes', stageDeltaCommand(dir, INVENTORY, NEXT_INVENTORY))).split(' ');

    if (changed === '0' && deleted === '0') {
      return { kind: 'skipped', reason: 'nothing changed since the last save', bytes: heldBytes(state), movedBytes: 0 } satisfies CheckpointOutcome;
    }

    const key = `${state.base.key.slice(0, state.base.key.lastIndexOf('/'))}/delta-${String(state.deltas.length + 1)}-${crypto.randomUUID()}.sqsh`;
    const bytes = yield* publish(key, STAGE, []);
    const next: DiskChainState = { ...state, rev: state.rev + 1, deltas: [...state.deltas, { key, bytes, committedAt: at }], committedAt: at };
    yield* advance(next, state.rev);

    return { kind: 'committed', reason: undefined, bytes: heldBytes(next), movedBytes: bytes } satisfies CheckpointOutcome;
  });

  const recover = (): Effect.Effect<DiskChainAttach, DevboxError> => Effect.gen(function* () {
    const state = yield* attempt('io', () => ports.readState());

    if (state === null) return { kind: 'empty', detail: 'no disk chain record', recoveredTo: undefined };
    const layers = [...state.deltas].reverse().map(layer => layer.key).concat(state.base.key);
    yield* run('recording the recovery', `mkdir -p ${shellPath(RT)} && printf %s ${shellPath(JSON.stringify({ rev: state.rev, layers }))} > ${shellPath(RECOVERED)} `
      + `&& rm -f ${shellPath(INVENTORY_REV)} ${shellPath(HYDRATED)}`);
    yield* mountLayers(layers);
    yield* startHydration(state.rev);

    return { kind: 'attached', detail: `rev ${String(state.rev)}, ${String(layers.length)} layers, lazy`, recoveredTo: state.committedAt };
  });

  /** A finished copy becomes the plain workspace with the upper merged in; else the overlay remounts. */
  const resume = (recovered: { readonly rev: number; readonly layers: readonly string[] }) => Effect.gen(function* () {
    const [workspace, hydrated] = (yield* run('checking the recovery', `mountpoint -q ${shellPath(DEVBOX_WORKDIR)} && echo mounted || echo unmounted; `
      + `[ -e ${shellPath(HYDRATED)} ] && echo done || echo copying`)).split('\n');

    if (workspace === 'mounted') return 'resumed';

    if (hydrated !== 'done') {
      yield* mountLayers(recovered.layers);
      yield* startHydration(recovered.rev);

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
    const { legacy, fromSnapshot, recovered } = this.#host;
    const chain = this.#chain;

    return settle(Effect.gen(function* () {
      const older = legacy();

      if (older !== undefined) return yield* attempt('io', () => older.attach());
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
  readonly fromSnapshot: () => boolean;
  readonly legacy: () => DevboxStorage | undefined;
  readonly recovered: (restoredTo: number) => Promise<void>;
  readonly discard: () => Promise<void>;
}

export function recoveryNotice(restoredTo: number, excludes: readonly string[]): string {
  return `the workspace was restored from its backup to ${new Date(restoredTo).toISOString()}: its snapshot was lost, expired or older than the backup. `
    + `The backup never holds ${excludes.join(', ')}; rebuild those (for example \`npm install\`) before relying on them.`;
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

