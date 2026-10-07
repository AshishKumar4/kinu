/** The former image-only recovery regressions, on the golden's real kernel, shim and R2 route. */
import { diskChain, DiskChainStateSchema, type DiskChainPorts, type DiskChainState } from '../src/disk-chain';
import { settle } from '../src/errors';
import { chainStoreRoot, storeObjectUrl } from '../src/store-gateway';
import { DEVBOX_RUNTIME_DIR as RT, DEVBOX_WORKDIR as WD, type CheckpointOutcome } from '../src/storage';
import * as v from 'valibot';

import type { DiskContract } from './contract-types';

const KEY = 'contract:disk-chain';

const EXCLUDES = ['node_modules', '*.log'];

const PRUNE = "\\( -name node_modules -o -name '*.log' \\) -prune -o";

const TREE = `cd ${WD}; find . -xdev ${PRUNE} ! -path . -printf '%P %y %m %l\\n' | LC_ALL=C sort; `
  + `find . -xdev ${PRUNE} -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum`;

const UNMOUNT = `s=$(cat ${RT}/disk-hydrate.pid 2>/dev/null); if [ -n "$s" ]; then kill -KILL -- -"$s" 2>/dev/null || true; `
  + 'while ps -eo sid=,stat= | awk -v s="$s" \'$1 == s && $2 !~ /^Z/ {alive=1} END {exit !alive}\'; do sleep 0.05; done; fi; '
  + `for m in ${WD} ${RT}/disk-lowers ${RT}/disk-blk $(ls -d ${RT}/disk-layers/* 2>/dev/null); do mountpoint -q "$m" && fusermount3 -u "$m"; done; true`;

function equal<Value>(actual: Value, expected: Value): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`disk contract mismatch: ${JSON.stringify({ actual, expected })}`);
}

interface LevelsBox {
  readonly sh: (command: string) => Promise<string>;
  readonly save: (checkpoint?: 'tick' | 'quiesce') => Promise<CheckpointOutcome>;
  readonly attach: (snapshot?: boolean) => Promise<{ readonly detail: string }>;
  readonly reset: () => Promise<void>;
  readonly copied: () => Promise<string>;
  readonly poke: (offset: number, bytes: number, byte: string) => Promise<string>;
  readonly small: (saved: CheckpointOutcome) => void;
  readonly deltaSaves: () => number[] | undefined;
}

/** Saves are held as a binary counter's layers (D77); each merged layer is cut from its boundary's digests, so an edited
 *  block travels as a block, and the chain reads back exactly. A directory becomes a file on the way. */
async function levelsContract(box: LevelsBox): Promise<void> {
  await box.sh(`set -e; cd ${WD}; mkdir -p a keep; echo 0 >keep/f; echo x >a/b; head -c 2097152 /dev/urandom >db.bin`);
  equal((await box.save()).kind, 'committed');
  const counts: number[][] = [];

  for (let n = 1; n <= 7; n++) {
    await box.sh(`echo ${String(n)} >${WD}/keep/f; echo ${String(n)} >${WD}/n${String(n)}`);

    if (n === 2) await box.sh(`rm -rf ${WD}/a; echo file >${WD}/a`);

    if (n === 3 || n === 6) await box.poke(n * 300_000, 4096, n === 3 ? 'L' : 'M');

    if (n === 5) await box.sh(`rm ${WD}/n1 ${WD}/n4`);
    box.small(await box.save());
    counts.push(box.deltaSaves() ?? []);
  }

  equal(counts, [[1], [2], [2, 1], [4], [4, 1], [4, 2], [4, 2, 1]]);
  const expected = await box.sh(TREE);
  await box.reset(); await box.attach(); equal(await box.sh(TREE), expected);
  // A save on a mounted recovery takes in none of its layers.
  await box.copied();
  await box.sh(`echo 8 >${WD}/keep/f`);
  box.small(await box.save());
  equal(box.deltaSaves(), [4, 2, 1, 1]);
  // Once the copy is the workspace, the next save takes them all in, their lists read from their objects.
  await box.sh(UNMOUNT); equal((await box.attach(true)).detail, 'recovery made plain');
  await box.sh(`echo 9 >${WD}/keep/f`);
  equal((await box.save()).kind, 'committed');
  equal(box.deltaSaves(), [9]);
  const later = await box.sh(TREE);
  await box.reset(); await box.attach(); equal(await box.sh(TREE), later);
}

export async function diskContract(kind: DiskContract, input: {
  readonly container: Container;
  readonly kv: DurableObjectStorage['kv'];
  readonly bucket: R2Bucket;
  readonly id: string;
}): Promise<void> {
  const exec = async (command: string) => {
    const ran = await (await input.container.exec(['/bin/bash', '-o', 'pipefail', '-c', command], { cwd: '/' })).output();

    return { stdout: new TextDecoder().decode(ran.stdout).trim(), stderr: new TextDecoder().decode(ran.stderr).trim(), exitCode: ran.exitCode };
  };

  const sh = async (command: string) => {
    const ran = await exec(command);

    if (ran.exitCode !== 0) throw new Error(`${command.slice(0, 160)}: ${ran.stderr}`);

    return ran.stdout;
  };

  const readState = (): DiskChainState | null => {
    const held = v.safeParse(DiskChainStateSchema, input.kv.get(KEY));

    return held.success ? held.output : null;
  };

  const root = chainStoreRoot(`boxes/${input.id}`);
  let clock = Date.now();

  const ports: DiskChainPorts = {
    exec, readState: async () => readState(),
    writeState: async (state, expected) => {
      equal(readState()?.rev ?? null, expected);
      input.kv.put(KEY, state);
    },
    storeRoot: () => root,
    storeObjectUrl: key => storeObjectUrl(root, 'STORE', key),
    objectBytes: async key => (await input.bucket.head(key))?.size,
    deleteObjects: async keys => { if (keys.length !== 0) await input.bucket.delete([...keys]); },
    mountStore: async () => undefined,
    excludes: () => EXCLUDES,
    now: () => clock,
    log: () => undefined,
  };

  const chain = diskChain(ports);
  const save = (checkpoint: 'tick' | 'quiesce' = 'tick') => settle(chain.commit(checkpoint));
  const attach = (snapshot = false) => settle(chain.attach(snapshot));
  const reset = async () => { await sh(`${UNMOUNT}; rm -rf ${RT}/disk-* ${WD}; mkdir -p ${WD}`); };

  const copied = () => sh(`until [ -e ${RT}/disk-hydrate.done ]; do sleep 0.05; done`);
  const copyEnded = () => sh(`until [ -e ${RT}/disk-hydrate.pid ] && ! kill -0 "$(cat ${RT}/disk-hydrate.pid)" 2>/dev/null; do sleep 0.05; done`);
  const poke = (offset: number, bytes: number, byte: string) => sh(`python3 -c "import os; f=os.open('${WD}/db.bin',os.O_WRONLY); os.pwrite(f,b'${byte}'*${String(bytes)},${String(offset)}); os.close(f)"`);

  const small = (saved: CheckpointOutcome) => { equal(saved.kind, 'committed');

 if ((saved.movedBytes ?? Infinity) >= 256 * 1024) throw new Error('the changed blocks travelled as a whole file'); };

  await reset();
  input.kv.delete(KEY);

  switch (kind) {
    case 'blocks': {
      await sh(`set -e; cd ${WD}; mkdir -p src/deep private gone/sub empty node_modules/pkg; chmod 700 private; `
        + 'echo secret >private/key; echo gone >gone/sub/f; echo old >src/f; ln -s src/f link; '
        + 'head -c 4194304 /dev/urandom >db.bin; head -c 2097152 /dev/urandom >log.jsonl; echo excluded >node_modules/pkg/f; echo noise >build.log');
      equal((await save()).kind, 'committed');
      await poke(100_000, 4096, 'A');
      await sh(`echo first >>${WD}/src/f; rm -rf ${WD}/gone; head -c 51200 /dev/urandom >>${WD}/log.jsonl`);
      small(await save());
      await poke(100_100, 20, 'B');
      await sh(`truncate -s 1572864 ${WD}/log.jsonl; rm ${WD}/link; ln -s private ${WD}/link; chmod 750 ${WD}/src/deep`);
      small(await save());
      await poke(4_194_300, 100, 'C');
      small(await save());
      equal((await save()).kind, 'skipped');
      const expected = await sh(TREE);
      await reset();
      await attach();
      equal(await sh(TREE), expected);
      await copied();
      await poke(2_000_000, 1, 'D');
      small(await save());
      const later = await sh(TREE);
      await sh(UNMOUNT);
      equal((await attach(true)).detail, 'recovery made plain');
      equal(await sh(TREE), later);
      equal((await exec(`mountpoint -q ${WD}`)).exitCode !== 0, true);
      await reset();
      await attach();
      equal(await sh(TREE), later);
      equal((await exec(`test -e ${WD}/node_modules || test -e ${WD}/build.log`)).exitCode, 1);
      // writable MAP_SHARED and SQLite WAL on the fallback's actual mount, not a copied fixture.
      await sh(`python3 -c "import mmap,sqlite3; p='${WD}/map.bin'; open(p,'wb').write(b'A'*4096); f=open(p,'r+b'); m=mmap.mmap(f.fileno(),0); m[0:4]=b'WAL!'; m.flush(); m.close(); c=sqlite3.connect('${WD}/wal.db'); assert c.execute('pragma journal_mode=wal').fetchone()[0]=='wal'; c.execute('create table t(x)'); c.execute('insert into t values(7)'); c.commit(); r=sqlite3.connect('${WD}/wal.db'); assert r.execute('select x from t').fetchone()[0]==7"`);
      break;
    }

    case 'levels': await levelsContract({ sh, save, attach, reset, copied, poke, small, deltaSaves: () => readState()?.deltas.map(delta => delta.saves) }); break;

    case 'compact': {
      await sh(`head -c 1048576 /dev/urandom >${WD}/a; echo small >${WD}/s`);
      await save();
      await sh(`head -c 524288 /dev/urandom >${WD}/b`);
      await save();
      const before = readState();
      const keys = before === null ? [] : [before.base.key, ...before.deltas.map(layer => layer.key)];
      equal((await save('quiesce')).kind, 'committed');
      equal(readState()?.deltas.length, 0);

      for (const key of keys) equal(await input.bucket.head(key), null);
      const expected = await sh(TREE);
      await reset(); await attach(); equal(await sh(TREE), expected);
      break;
    }

    case 'baseline': {
      await sh(`echo before >${WD}/s`); await save();
      const base = readState()?.base.key;
      await sh(`rm ${RT}/disk-inventory.rev; echo after >${WD}/s`);
      equal((await save()).kind, 'committed');
      equal(readState()?.base.key === base, false); equal(readState()?.deltas.length, 0);
      break;
    }

    case 'streaming': {
      await sh(`mount -t tmpfs -o size=76m contract-runtime ${RT}; head -c 67108864 /dev/urandom >${WD}/db.bin`);

      try {
        equal((await save()).kind, 'committed');
        await sh(`dd if=/dev/urandom of=${WD}/db.bin bs=1M count=64 conv=notrunc status=none`);
        equal((await save()).kind, 'committed');
        const expected = await sh(TREE);
        await reset(); await attach(); equal(await sh(TREE), expected);
      } finally { await reset(); await sh(`umount ${RT}`); }

      break;
    }

    case 'parallel-mounts': {
      await sh(`echo a >${WD}/a`); await save();

      // Seven saves over the base are three deltas (D77): four layers to mount.
      for (const file of ['b', 'c', 'd', 'e', 'f', 'g', 'h']) { await sh(`echo ${file} >${WD}/${file}`); await save(); }

      const expected = await sh(TREE);
      await reset();
      await sh(`mv /usr/local/bin/devbox-squashfuse /usr/local/bin/devbox-squashfuse.real; rm -f ${RT}.mounts; `
        + `printf '%s\\n' '#!/bin/sh' 'echo start >>${RT}.mounts' `
        + `'for i in $(seq 1 50); do [ "$(grep -c start ${RT}.mounts)" -ge 4 ] && break; sleep 0.1; done' `
        + `'echo end >>${RT}.mounts' 'exec /usr/local/bin/devbox-squashfuse.real "$@"' >/usr/local/bin/devbox-squashfuse; chmod +x /usr/local/bin/devbox-squashfuse`);

      try { await attach(); equal(await sh(`${TREE}`), expected); equal((await sh(`cat ${RT}.mounts`)).split('\n'), ['start', 'start', 'start', 'start', 'end', 'end', 'end', 'end']); }
      finally { await sh('mv /usr/local/bin/devbox-squashfuse.real /usr/local/bin/devbox-squashfuse'); }

      break;
    }

    case 'low-disk':
    case 'lost-inventory': {
      await sh(`head -c 50331648 /dev/urandom >${WD}/db.bin`); await save();
      const expected = await sh(TREE);
      await reset(); await sh(`mount -t tmpfs -o size=40m contract-runtime ${RT}`);

      try {
        await attach(); equal(await sh(TREE), expected); await copyEnded();
        await sh(`echo before >${WD}/before`);

        if (kind === 'lost-inventory') {
          let recorded = false;
          let lost = false;

          const dropped = diskChain({ ...ports,
            writeState: async (state, rev) => { await ports.writeState(state, rev); recorded = true; },
            exec: async command => recorded && !lost ? (lost = true, { stdout: '', stderr: 'contract lost inventory dispatch', exitCode: 1 }) : exec(command),
          });

          const [saved] = await Promise.allSettled([settle(dropped.commit('tick'))]);
          equal(saved?.status, 'rejected'); equal(lost, true);
        } else equal((await save()).kind, 'committed');
        await sh(UNMOUNT); await attach(true); await copyEnded();
        await sh(`echo after >${WD}/after`); equal((await save()).kind, 'committed');
        const later = await sh(TREE);
        await reset(); await attach(); equal(await sh(TREE), later);
      } finally { await reset(); await sh(`umount ${RT}`); }

      break;
    }

    case 'quiesce-tick': {
      clock = 0;
      await sh(`echo a >${WD}/a`); equal((await save()).kind, 'committed');
      clock = 10_000;
      await sh(`echo b >${WD}/b`); equal((await save('quiesce')).kind, 'committed');
      clock = 60_000;
      await sh(`echo c >${WD}/c`); equal((await save()).kind, 'committed');
      break;
    }
  }

  await reset();
}
