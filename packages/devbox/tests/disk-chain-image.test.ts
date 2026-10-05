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

/** Answers when the command's stdout closes, as the platform's exec does, not when its shell exits:
 *  a process left holding that pipe holds the exec too. */
function sh(script: string) {
  const ran = spawnSync('docker', ['exec', name, 'bash', '-o', 'pipefail', '-c', `{ ${script}\n} | cat`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

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

/** A container's end: the copy to disk's session stops first, as it holds the layers it reads, then every mount goes. */
const UNMOUNT = `s=$(cat ${RT}/disk-hydrate.pid 2>/dev/null); if [ -n "$s" ]; then pkill -9 -s "$s"; while pgrep -s "$s" >/dev/null; do sleep 0.05; done; fi; `
  + `for m in ${WD} ${RT}/disk-lowers ${RT}/disk-blk $(ls -d ${RT}/disk-layers/* 2>/dev/null); do mountpoint -q $m && fusermount3 -u $m; done`;

/** The disk lost: everything but the store, as a replaced container leaves it. */
function loseTheDisk(): void {
  must(`${UNMOUNT}; rm -rf ${RT}/disk-* && rm -rf ${WD} && mkdir -p ${WD}`);
}

/** A container stop: every mount goes and the disk stays, as a snapshot keeps it. */
function stopTheContainer(): void {
  must(`${UNMOUNT}; true`);
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
    // The 4 KiB written into the 8 MiB file travels as the one 16 KiB block it touched.
    deltaSizes: [(first.movedBytes ?? 0) < 1024 * 1024, (second.movedBytes ?? 0) < 256 * 1024],
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

/** Writes `count` bytes of `byte` at `offset` into `file` in place, as a database page write does. */
const poke = (file: string, offset: number, count: number, byte: string) =>
  `python3 -c "import os; f=os.open('${WD}/${file}', os.O_WRONLY); os.pwrite(f, b'${byte}' * ${String(count)}, ${String(offset)}); os.close(f)"`;

const waitForTheCopy = () => must(`for _ in $(seq 1 600); do [ -e ${RT}/disk-hydrate.done ] && break; sleep 0.1; done; [ -e ${RT}/disk-hydrate.done ]`);

test('files written in place travel as their changed blocks, and recover exactly through every layer', async () => {
  loseTheDisk();
  stored = null;
  must(`set -e; cd ${WD}; head -c 4194304 /dev/urandom > db.bin; head -c 2097152 /dev/urandom > log.jsonl; echo small > s.txt`);
  const base = await commit('tick');
  must(`set -e; ${poke('db.bin', 100_000, 4096, 'A')}; ${poke('db.bin', 3_000_000, 10, 'B')}; head -c 51200 /dev/urandom >> ${WD}/log.jsonl`);
  const first = await commit('tick');
  must(`set -e; ${poke('db.bin', 100_100, 20, 'C')}; ${poke('db.bin', 0, 1, 'D')}; truncate -s 1572864 ${WD}/log.jsonl; echo edited >> ${WD}/s.txt`);
  const second = await commit('tick');
  must(`set -e; ${poke('db.bin', 4_194_300, 100, 'E')}`);
  const third = await commit('tick');
  const expected = tree();
  const blocks = sh(`tr '\\0' ' ' < ${RT}/disk-blocks/paths`).stdout;

  loseTheDisk();
  await settle(chain.attach(false));
  const lazily = tree();
  waitForTheCopy();
  must(poke('db.bin', 2_000_000, 1, 'F'));
  const afterRecovery = await commit('tick');
  const expectedLater = tree();
  stopTheContainer();
  await settle(chain.attach(true));
  const onDisk = tree();
  loseTheDisk();
  await settle(chain.attach(false));
  const again = tree();

  expect({
    kinds: [base.kind, first.kind, second.kind, third.kind, afterRecovery.kind],
    // Each save moves its touched 16 KiB blocks, not the 4 MiB and 2 MiB files.
    small: [first, second, third, afterRecovery].map(saved => (saved.movedBytes ?? Infinity) < 256 * 1024),
    cached: blocks.trim().split(' ').sort(),
    lazilyExact: lazily === expected,
    plainExact: onDisk === expectedLater,
    againExact: again === expectedLater,
  }).toEqual({
    kinds: ['committed', 'committed', 'committed', 'committed', 'committed'],
    small: [true, true, true, true], cached: ['db.bin', 'log.jsonl'], lazilyExact: true, plainExact: true, againExact: true,
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

test('a rewrite saves with its changed bytes on the disk once, as the archive streams, and recovers exactly', async () => {
  // D68: a staged delta met ENOSPC at 18 GB; this disk holds the 64 MiB rewrite once, with 12 MiB spare.
  loseTheDisk();
  stored = null;
  must(`set -e; mount -t tmpfs -o size=76m devbox-runtime ${RT}; head -c 67108864 /dev/urandom > ${WD}/db.bin; echo small > ${WD}/s.txt`);

  try {
    const base = await commit('tick');
    must(`dd if=/dev/urandom of=${WD}/db.bin bs=1M count=64 conv=notrunc status=none`);
    const rewrite = await commit('tick');
    const expected = tree();
    loseTheDisk();
    await settle(chain.attach(false));

    expect({ base: base.kind, rewrite: rewrite.kind, reason: rewrite.reason, exact: tree() === expected })
      .toEqual({ base: 'committed', rewrite: 'committed', reason: undefined, exact: true });
  } finally {
    loseTheDisk();
    must(`umount ${RT}`);
  }
});

test('a lost-snapshot wake mounts its layers at once, not one store round trip after another', async () => {
  // D68 lost wake at 2 GB: 3.4 s, mostly squashfuse mounting each layer over the store in turn.
  loseTheDisk();
  stored = null;
  must(`set -e; cd ${WD}; echo a > a.txt`);
  await commit('tick');

  for (const file of ['b', 'c', 'd']) {
    must(`echo ${file} > ${WD}/${file}.txt`);
    await commit('tick');
  }

  const expected = tree();
  loseTheDisk();
  // Each mount waits, up to 5 s, for every layer's mount to start before it mounts.
  must(`set -e; mv /usr/local/bin/devbox-squashfuse /usr/local/bin/devbox-squashfuse.real; rm -f ${RT}.mounts; `
    + `printf '%s\\n' '#!/bin/sh' 'echo start >> ${RT}.mounts' `
    + `'for i in $(seq 1 50); do [ "$(grep -c start ${RT}.mounts)" -ge 4 ] && break; sleep 0.1; done' `
    + `'echo end >> ${RT}.mounts' 'exec /usr/local/bin/devbox-squashfuse.real "$@"' > /usr/local/bin/devbox-squashfuse; chmod +x /usr/local/bin/devbox-squashfuse`);

  try {
    await settle(chain.attach(false));

    expect({ order: must(`cat ${RT}.mounts`).split('\n'), exact: tree() === expected })
      .toEqual({ order: ['start', 'start', 'start', 'start', 'end', 'end', 'end', 'end'], exact: true });
  } finally {
    must('mv /usr/local/bin/devbox-squashfuse.real /usr/local/bin/devbox-squashfuse');
  }
});

test('a lost wake whose copy to disk would not fit stays lazy, and the workspace keeps taking writes and saves', async () => {
  // 18 GB lost wake: the copy and s3fs's read cache of the archive filled the disk and reads failed with EIO.
  loseTheDisk();
  stored = null;
  must(`head -c 50331648 /dev/urandom > ${WD}/db.bin`);
  await commit('tick');
  const expected = tree();
  loseTheDisk();
  // A disk with room for the 48 MiB workspace's writes, not for a copy of it.
  must(`mount -t tmpfs -o size=40m devbox-runtime ${RT}`);

  try {
    await settle(chain.attach(false));
    const lazily = tree();
    must(`for _ in $(seq 1 100); do [ -e ${RT}/disk-hydrate.pid ] && ! kill -0 "$(cat ${RT}/disk-hydrate.pid)" 2>/dev/null && break; sleep 0.1; done`);
    const wrote = sh(`echo after > ${WD}/after.txt`);
    const saved = await commit('tick');

    expect({ exact: lazily === expected, wrote: wrote.status === 0 ? 'ok' : wrote.stderr, saved: saved.kind })
      .toEqual({ exact: true, wrote: 'ok', saved: 'committed' });
  } finally {
    loseTheDisk();
    must(`umount ${RT}`);
  }
});

test('a quiesce commit does not push the next periodic tick a period back', async () => {
  // A quiesce whose stop then fails leaves the box running; its next tick must still save. The alarm spaces ticks.
  let clock = 0;
  const timed = diskChain({ ...ports, now: () => clock });
  loseTheDisk();
  stored = null;
  must(`echo a > ${WD}/a.txt`);
  const first = await settle(timed.commit('tick'));
  clock = 10_000;
  must(`echo b > ${WD}/b.txt`);
  const quiesced = await settle(timed.commit('quiesce'));
  clock = 60_000;
  must(`echo c > ${WD}/c.txt`);
  const tick = await settle(timed.commit('tick'));

  expect([first.kind, quiesced.kind, tick.kind, tick.reason]).toEqual(['committed', 'committed', 'committed', undefined]);
});
