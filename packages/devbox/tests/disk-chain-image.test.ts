// D55: the hybrid's chain backup in the image, with real FUSE, squashfs tools and the shipped publisher.
// The store is served inside the container (support/store-box.ts) and outlives every wipe of the disk,
// as R2 outlives a lost container.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settle } from '../src/errors';
import { diskChain, type DiskChainPorts, type DiskChainState } from '../src/disk-chain';
import { STORE_MOUNT, storeObjectUrl } from '../src/store-gateway';
import { DEVBOX_RUNTIME_DIR as RT, DEVBOX_WORKDIR as WD } from '../src/storage';
import { buildBlockImage, removeBlockImage } from './support/block-image';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';

const image = `devbox-diskchain-${process.pid}`;

const name = `devbox-diskchain-${process.pid}`;

const ROOT = 'boxes/disk-test/backups';

const EXCLUDES = ['node_modules', '*.log'];

function sh(script: string) {
  const ran = spawnSync('docker', ['exec', name, 'bash', '-c', script], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

  return { status: ran.status ?? -1, stdout: ran.stdout.trim(), stderr: ran.stderr.trim() };
}

function must(script: string): string {
  const ran = sh(script);

  if (ran.status !== 0) throw new Error(`${script.slice(0, 160)} exited ${String(ran.status)}: ${ran.stderr}`);

  return ran.stdout;
}

let stored: DiskChainState | null = null;

/** The record as the box holds it now; a function, so each read sees the latest commit. */
const record = (): DiskChainState | null => stored;

const ports: DiskChainPorts = {
  exec: (command) => {
    const ran = sh(command);

    return Promise.resolve({ stdout: ran.stdout, stderr: ran.stderr, exitCode: ran.status });
  },
  readState: () => Promise.resolve(stored),
  writeState: (state, expectedRev) => {
    if ((stored?.rev ?? null) !== expectedRev) return Promise.reject(new Error(`the record moved: ${String(stored?.rev)} against ${String(expectedRev)}`));
    stored = state;

    return Promise.resolve();
  },
  storeRoot: () => ROOT,
  storeObjectUrl: (key) => storeObjectUrl(ROOT, 'bucket', key),
  objectBytes: (key) => {
    const size = sh(`stat -c %s ${STORE_MOUNT}/${key.slice(ROOT.length + 1)}`);

    return Promise.resolve(size.status === 0 ? Number(size.stdout) : undefined);
  },
  deleteObjects: (keys) => {
    must(`rm -f ${keys.map((key) => `${STORE_MOUNT}/${key.slice(ROOT.length + 1)}`).join(' ')}`);

    return Promise.resolve();
  },
  mountStore: () => Promise.resolve(),
  excludes: () => EXCLUDES,
  checkpointIntervalMs: () => 0,
  now: () => Date.now(),
  log: () => undefined,
};

const chain = diskChain(ports);

/** What the chain's inventory prunes for {@link EXCLUDES}. */
const PRUNE = "\\( -name 'node_modules' -o -name '*.log' \\) -prune -o";

/** Every entry the chain keeps, with its type, mode, link target and content digest; and each file's
 *  mtime to the second, which is what a squashfs keeps. */
const TREE = `cd ${WD} && find . -xdev ${PRUNE} ! -path . -printf '%P %y %m %l\\n' | LC_ALL=C sort `
  + `&& find . -xdev ${PRUNE} -type f -printf '%P %T@\\n' | sed 's/\\.[0-9]*$//' | LC_ALL=C sort `
  + `&& find . -xdev ${PRUNE} -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum`;

const tree = () => must(TREE);

/** The disk lost: everything but the store, as a replaced container leaves it. */
function loseTheDisk(): void {
  must(`for m in ${WD} ${RT}/disk-lowers $(ls -d ${RT}/disk-layers/* 2>/dev/null); do mountpoint -q $m && fusermount3 -u $m; done; `
    + `pkill -f '[c]p -a ${RT}/disk-lowers' || true; rm -rf ${RT}/disk-* && rm -rf ${WD} && mkdir -p ${WD}`);
}

/** A container stop: every mount goes and the disk stays, as a snapshot keeps it. */
function stopTheContainer(): void {
  must(`for m in ${WD} ${RT}/disk-lowers $(ls -d ${RT}/disk-layers/* 2>/dev/null); do mountpoint -q $m && fusermount3 -u $m; done; true`);
}

const commit = (kind: 'tick' | 'quiesce') => settle(chain.commit(kind));

let scratch = '';

beforeAll(async () => {
  buildBlockImage(image);
  scratch = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}disk-chain-`));
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, 'support/store-box.ts')], target: 'bun', outdir: scratch });

  if (!built.success) throw new AggregateError(built.logs, 'the store did not build');

  const started = spawnSync('docker', ['run', '--detach', '--name', name, '--network=none', '--device', '/dev/fuse', '--cap-add', 'SYS_ADMIN',
    '--security-opt', 'apparmor=unconfined', '--add-host', 's3-devbox-publish.sandbox.internal:127.0.0.1', image], { encoding: 'utf8' });

  if (started.status !== 0) throw new Error(started.stderr);
  spawnSync('docker', ['cp', join(scratch, 'store-box.js'), `${name}:/var/tmp/store-box.js`]);
  spawnSync('docker', ['exec', '--detach', name, 'bun', '/var/tmp/store-box.js', STORE_MOUNT]);
  must('until curl -sf http://s3-devbox-publish.sandbox.internal/ready >/dev/null; do sleep 0.1; done');
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  spawnSync('docker', ['rm', '-f', name]);
  removeBlockImage(image);
});

test('a base and two deltas recover exactly, lazily in the gate and then as a plain disk', async () => {
  must(`set -e; cd ${WD}; mkdir -p src/deep/er private gone/sub empty node_modules/pkg; chmod 700 private; `
    + 'for i in $(seq 1 40); do echo "file $i" > src/f-$i.txt; done; echo secret > private/key; echo x > gone/sub/y; echo z > gone/z; '
    + 'head -c 8388608 /dev/urandom > big.bin; ln -s src/f-1.txt link; echo skipped > node_modules/pkg/index.js; echo noise > build.log; '
    + 'echo old > typechange; touch -d 2020-01-01 src/f-2.txt');
  const base = await commit('tick');
  must(`set -e; cd ${WD}; echo edited >> src/f-1.txt; mkdir -p new/dir; echo new > new/dir/file; rm src/f-3.txt; rm -rf gone; chmod 750 src/deep; `
    + 'mv src/f-4.txt src/renamed.txt; rm typechange; mkdir typechange; echo inside > typechange/x');
  const first = await commit('tick');
  must(`set -e; cd ${WD}; dd if=/dev/urandom of=big.bin bs=4096 count=1 seek=7 conv=notrunc status=none; echo again >> src/f-5.txt; rm link; ln -s private link`);
  const second = await commit('tick');
  const unchanged = await commit('tick');
  const expected = tree();

  loseTheDisk();
  const recovered = await settle(chain.attach(false));
  const lazily = tree();
  must(`set -e; cd ${WD}; echo after >> src/f-6.txt; rm src/f-7.txt; mkdir -p later && echo later > later/file`);
  must(`for _ in $(seq 1 600); do [ -e ${RT}/disk-hydrate.done ] && break; sleep 0.1; done; [ -e ${RT}/disk-hydrate.done ]`);
  const afterRecovery = await commit('tick');
  const expectedLater = tree();
  stopTheContainer();
  const settled = (await settle(chain.attach(true))).detail;
  const onDisk = tree();
  const mountedNow = sh(`mountpoint -q ${WD}`).status === 0;
  loseTheDisk();
  await settle(chain.attach(false));
  const recoveredAgain = tree();

  expect({
    kinds: [base.kind, first.kind, second.kind, unchanged.kind, recovered.kind, afterRecovery.kind, settled],
    layers: (record()?.deltas.length ?? -1) + 1,
    // A layer holds whole files: the 4 KiB written into the 8 MiB file re-sends that file.
    deltaSizes: [(first.movedBytes ?? 0) < 1024 * 1024, (second.movedBytes ?? 0) < 9 * 1024 * 1024],
    lazilyExact: lazily === expected,
    plainExact: onDisk === expectedLater,
    mountedNow,
    againExact: recoveredAgain === expectedLater,
    excluded: sh(`ls ${WD}/node_modules ${WD}/build.log 2>&1 | head -1`).stdout.includes('No such file'),
  }).toEqual({
    kinds: ['committed', 'committed', 'committed', 'skipped', 'attached', 'committed', 'recovery made plain'],
    layers: 4, deltaSizes: [true, true], lazilyExact: true, plainExact: true, mountedNow: false, againExact: true, excluded: true,
  });
});

test('a rest compacts the deltas into a new base once they outgrow a quarter of it, and deletes the old layers', async () => {
  stopTheContainer();
  must(`set -e; rm -rf ${RT}/disk-* ${WD} && mkdir -p ${WD} && cd ${WD} && head -c 1048576 /dev/urandom > a.bin && echo small > s.txt`);
  stored = null;
  await commit('tick');

  const oldKeys = (): string[] => {
    const now = record();

    return now === null ? [] : [now.base.key, ...now.deltas.map((layer) => layer.key)];
  };

  must(`head -c 524288 /dev/urandom > ${WD}/b.bin`);
  await commit('tick');
  const before = oldKeys();
  const rest = await commit('quiesce');
  const expected = tree();
  const left = before.filter((key) => sh(`[ -e ${STORE_MOUNT}/${key.slice(ROOT.length + 1)} ]`).status === 0);
  loseTheDisk();
  await settle(chain.attach(false));

  expect({ rest: rest.kind, deltas: record()?.deltas.length, left, exact: tree() === expected }).toEqual({ rest: 'committed', deltas: 0, left: [], exact: true });
});

test('a disk whose baseline is not the record\'s saves a whole base, never a delta against the wrong tree', async () => {
  must(`for _ in $(seq 1 600); do [ -e ${RT}/disk-hydrate.done ] && break; sleep 0.1; done`);
  stopTheContainer();
  await settle(chain.attach(true));
  const before = record()?.base.key;
  must(`rm -f ${RT}/disk-inventory.rev; echo changed > ${WD}/s.txt`);
  const saved = await commit('tick');

  expect({ kind: saved.kind, newBase: record()?.base.key !== before, deltas: record()?.deltas.length }).toEqual({ kind: 'committed', newBase: true, deltas: 0 });
});
