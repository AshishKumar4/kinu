import { createHash } from 'node:crypto';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Seeded } from './seeded';

export const C3_WORKLOAD = {
  path: 'vol/dense.bin', baselineBytes: 64 * 1024 * 1024, overwriteBytes: 64 * 1024,
  offset: 8 * 1024 * 1024, baselineSeed: 61, overwriteSeed: 62,
} as const;

export const C3_BYTES_BOUND = 196_608;

export const C3_BASELINE_SHA256 = '936bd9856c5ba7b6d1a40f11b8be8ff3d296ce952447a6cf8c9973197adf1a2c';

export const C3_OVERWRITE_SHA256 = '6adec5191fbd1aab70959259fdd85c2ea8195168a90dd2c98341360640aaaecb';

export type FileEvidence =
  | { readonly kind: 'file'; readonly size: number; readonly sha256: string }
  | { readonly kind: 'missing' };

async function openWitness(path: string): Promise<FileHandle | null> {
  try {
    return await open(path, 'r');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function readFileEvidence(path: string): Promise<FileEvidence> {
  const file = await openWitness(path);

  if (file === null) return { kind: 'missing' };

  try {
    const stat = await file.stat();
    const hash = createHash('sha256');

    for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes);

    return { kind: 'file', size: stat.size, sha256: hash.digest('hex') };
  } finally {
    await file.close();
  }
}

export async function writeC3File(root: string, phase: 'baseline' | 'overwrite'): Promise<void> {
  const path = join(root, C3_WORKLOAD.path);
  await mkdir(dirname(path), { recursive: true });
  const baseline = phase === 'baseline';

  const bytes = new Seeded(baseline ? C3_WORKLOAD.baselineSeed : C3_WORKLOAD.overwriteSeed)
    .fill(new Uint8Array(baseline ? C3_WORKLOAD.baselineBytes : C3_WORKLOAD.overwriteBytes));

  const file = await open(path, baseline ? 'w' : 'r+');

  try {
    let written = 0;
    const offset = baseline ? 0 : C3_WORKLOAD.offset;

    while (written < bytes.byteLength) {
      const result = await file.write(bytes, written, bytes.byteLength - written, offset + written);

      if (result.bytesWritten === 0) throw new Error('the C3 write made no progress');
      written += result.bytesWritten;
    }

    await file.sync();
  } finally {
    await file.close();
  }
}

if (import.meta.main) {
  const [action, path] = Bun.argv.slice(2);

  if (path === undefined) throw new Error('expected read <path> or baseline/overwrite <root>');

  if (action === 'read') process.stdout.write(`${JSON.stringify(await readFileEvidence(path))}\n`);
  else if (action === 'baseline' || action === 'overwrite') {
    await writeC3File(path, action);
    process.stdout.write(`${JSON.stringify({ prepared: action, path: join(path, C3_WORKLOAD.path) })}\n`);
  } else throw new Error(`unknown witness-file action: ${action}`);
}
