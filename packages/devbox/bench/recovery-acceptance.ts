/**
 * A2 and m1966b's acceptance: hours of a box's saves, then a fresh container's cold recovery, timed against the 30 s
 * a container's start holds its object (blockConcurrencyWhile), with what that recovery read counted: the layers it
 * mounted (D77 holds them at floor(log2 n) + 2 for n saves since the base) and the block records their manifests held.
 *
 * `fill` makes a workspace of small files and of large files a save sends as changed blocks, and saves its base.
 * `saves` makes `count` saves from `from`, each a box's 5-minute tick: a line on a small file, a new small file, now and
 * then a deletion, and a 4 KiB write into each of `bigPerSave` large files in turn. `seal` keeps the tree's digest.
 * `recover`, on the fresh container the tier's crash left, attaches the chain cold and reads the tree back.
 */
import * as v from 'valibot';
import { DEVBOX_RUNTIME_DIR as RT, DEVBOX_WORKDIR as WD } from '../src/storage';
import type { RecoveryAcceptance } from './contract-types';
import { diskHarness, TREE, type DiskContractInput } from './disk-contracts';

const KEY = 'acceptance:recovery-chain';

const DIGEST = 'acceptance:recovery-tree';

const LayerRecordsSchema = v.array(v.object({ records: v.number(), bytes: v.number() }));

/** What block-lower counted of its reads (`devbox-block-lower --stats`), or null before it started. */
const BlockLowerStatsSchema = v.nullable(v.object({ payloadBytes: v.number(), indexPages: v.number(), readRequests: v.number() }));

/** One phase's measurements, as the tier's report keeps them. */
export type RecoveryMeasurement =
  | { readonly phase: 'fill'; readonly bytes: number; readonly baseMs: number; readonly baseBytes: number | undefined }
  | {
    readonly phase: 'saves'; readonly saves: number; readonly layers: number; readonly deltaSaves: readonly number[];
    readonly medianMs: number; readonly maxMs: number; readonly moved: number;
  }
  | { readonly phase: 'seal'; readonly saves: number }
  | {
    readonly phase: 'recover'; readonly saves: number; readonly layers: number; readonly bound: number; readonly attachMs: number;
    readonly detail: string; readonly firstReadMs: number; readonly records: v.InferOutput<typeof LayerRecordsSchema>;
    readonly blockLower: v.InferOutput<typeof BlockLowerStatsSchema>; readonly treeMs: number;
  };

const FILL = `
import os, sys
ws, small, big, size = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
total = 0
for i in range(small):
    os.makedirs(f'{ws}/src/m{i % 200:03d}', exist_ok=True)
    data = os.urandom(1024 + (i * 7919) % 15360)
    open(f'{ws}/src/m{i % 200:03d}/f{i:05d}.txt', 'wb').write(data)
    total += len(data)
for k in range(big):
    os.makedirs(f'{ws}/big/d{k % 32:02d}', exist_ok=True)
    with open(f'{ws}/big/d{k % 32:02d}/b{k:05d}.bin', 'wb') as out:
        left = size
        while left > 0:
            out.write(os.urandom(min(left, 16777216)))
            left -= min(left, 16777216)
    total += size
os.makedirs(f'{ws}/edits', exist_ok=True)
print(total)
`;

const EDIT = `
import os, sys
ws, i, small, big, per = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
x = (i * 37) % small
open(f'{ws}/src/m{x % 200:03d}/f{x:05d}.txt', 'ab').write(f'save {i}\\n'.encode())
open(f'{ws}/edits/e{i:05d}.bin', 'wb').write(os.urandom(4096))
if i % 8 == 0 and os.path.exists(f'{ws}/edits/e{i - 7:05d}.bin'):
    os.remove(f'{ws}/edits/e{i - 7:05d}.bin')
for j in range(per):
    k = (i * per + j) % big
    f = os.open(f'{ws}/big/d{k % 32:02d}/b{k:05d}.bin', os.O_WRONLY)
    size = os.fstat(f).st_size
    os.pwrite(f, os.urandom(4096), ((i * 7919 + j * 104729) * 16384) % (size - 4096))
    os.close(f)
`;

/** Each mounted delta's block records and its manifest's bytes, oldest layer first. */
const RECORDS = `
import json, os, sys
layers = sys.argv[1]
out = []
for name in sorted(os.listdir(layers), key=int, reverse=True):
    path = f'{layers}/{name}/.devbox-delta/manifest.json'
    if os.path.exists(path):
        out.append({'records': len(json.load(open(path))['files']), 'bytes': os.path.getsize(path)})
print(json.dumps(out))
`;

/** The first reads a resumed agent makes: the workspace's top, then 4 KiB of the large file the last save wrote. */
const FIRST_READ = `
import os, sys, time
ws, k = sys.argv[1], int(sys.argv[2])
at = time.monotonic()
os.listdir(ws)
f = os.open(f'{ws}/big/d{k % 32:02d}/b{k:05d}.bin', os.O_RDONLY)
os.pread(f, 4096, 0)
os.close(f)
print(round((time.monotonic() - at) * 1000))
`;

function median(values: readonly number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
}

export async function recoveryAcceptance(asked: RecoveryAcceptance, input: DiskContractInput): Promise<RecoveryMeasurement> {
  const { sh, readState, save, attach, reset } = diskHarness(input, KEY);
  const py = (script: string, ...args: readonly (string | number)[]) => sh(`python3 -c '${script.replaceAll("'", "'\\''")}' ${args.join(' ')}`);
  const saved = () => readState()?.deltas.reduce((sum, delta) => sum + delta.saves, 0) ?? 0;

  switch (asked.phase) {
    case 'fill': {
      await reset();
      input.kv.delete(KEY);
      input.kv.delete(DIGEST);
      const bytes = Number(await py(FILL, WD, asked.smallFiles, asked.bigFiles, asked.bigBytes));
      const at = Date.now();
      const base = await save();

      if (base.kind !== 'committed') throw new Error(`the base was not saved: ${base.reason ?? base.kind}`);

      return { phase: 'fill', bytes, baseMs: Date.now() - at, baseBytes: base.movedBytes };
    }

    case 'saves': {
      const ms: number[] = [];
      let moved = 0;

      for (let at = asked.from; at < asked.from + asked.count; at++) {
        await py(EDIT, WD, at, asked.smallFiles, asked.bigFiles, asked.bigPerSave);
        const started = Date.now();
        const outcome = await save();

        if (outcome.kind !== 'committed') throw new Error(`save ${String(at)} was not committed: ${outcome.reason ?? outcome.kind}`);
        ms.push(Date.now() - started);
        moved += outcome.movedBytes ?? 0;
      }

      const deltaSaves = readState()?.deltas.map(delta => delta.saves) ?? [];

      return { phase: 'saves', saves: saved(), layers: deltaSaves.length + 1, deltaSaves, medianMs: median(ms), maxMs: Math.max(...ms), moved };
    }

    case 'seal': {
      input.kv.put(DIGEST, await sh(`{ ${TREE}; } | sha256sum | cut -d' ' -f1`));

      return { phase: 'seal', saves: saved() };
    }

    case 'recover': {
      const expected = input.kv.get(DIGEST);
      const saves = saved();

      // What a fresh container's own start mounted is not this chain's: the recovery starts from an empty disk. A mount
      // something on the box still holds is detached lazily: left mounted, the recovery would not mount over it.
      await sh(`for m in ${WD} ${RT}/disk-lowers ${RT}/disk-blk $(ls -d ${RT}/disk-layers/* 2>/dev/null); do `
        + 'mountpoint -q "$m" && { fusermount3 -u "$m" || fusermount3 -uz "$m"; }; done; true');
      await reset();
      const held = await sh(`grep -E ' (${WD}|${RT}/disk-[^ ]*) ' /proc/self/mounts || true`);

      if (held !== '') throw new Error(`the fresh container still holds mounts the recovery would land on:\n${held}`);
      const at = Date.now();
      const attached = await attach();
      const attachMs = Date.now() - at;
      const firstReadMs = Number(await py(FIRST_READ, WD, ((saves + 1) * asked.bigPerSave - 1) % asked.bigFiles));
      const records = v.parse(LayerRecordsSchema, JSON.parse(await py(RECORDS, `${RT}/disk-layers`)));
      const blockLower = v.parse(BlockLowerStatsSchema, JSON.parse(await sh(`cat ${RT}/disk-blk.json 2>/dev/null || echo null`)));
      const treeAt = Date.now();
      const tree = await sh(`{ ${TREE}; } | sha256sum | cut -d' ' -f1`);

      if (tree !== expected) throw new Error(`the recovered tree is not the one saved: ${tree} where ${String(expected)} was sealed`);

      return {
        phase: 'recover', saves, layers: (readState()?.deltas.length ?? 0) + 1, bound: Math.floor(Math.log2(Math.max(1, saves))) + 2, attachMs, detail: attached.detail,
        firstReadMs, records, blockLower, treeMs: Date.now() - treeAt,
      };
    }
  }
}
