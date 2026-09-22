import { createHash } from 'node:crypto';
import * as v from 'valibot';

export const DELTA_BLOCK_BYTES = 16 * 1024;

export const DELTA_INDEX_PAGE_BYTES = 128;

const EMPTY_DIGEST = createHash('sha256').digest('hex');

const NULL_CHILD = '0'.repeat(64);

const Count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

const Hex64 = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));

export const DeltaIndexRefSchema = v.object({ index: Hex64, root: Hex64, count: Count });

export type DeltaIndexRef = v.InferOutput<typeof DeltaIndexRefSchema>;

export type DeltaOverride = { readonly o: number; readonly src: 'hole' }
  | { readonly o: number; readonly src: 'chunk'; readonly d: string };

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function validOffset(offset: number, size: number, previous: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % DELTA_BLOCK_BYTES !== 0
    || offset >= size || offset <= previous) throw new Error('invalid delta index offset');
}

/** Pages occupy sorted ranks; subtree [lo, hi) roots at floor((lo+hi)/2), so no pointer
 *  can redirect a read or inflate its depth. */
export function buildDeltaIndex(entries: readonly DeltaOverride[], size: number) {
  const bytes = Buffer.alloc(entries.length * DELTA_INDEX_PAGE_BYTES);
  let previous = -1;

  for (const entry of entries) {
    validOffset(entry.o, size, previous);
    previous = entry.o;
  }

  const build = (lo: number, hi: number): string => {
    if (lo === hi) return NULL_CHILD;
    const mid = Math.floor((lo + hi) / 2);
    const entry = entries[mid];

    if (entry === undefined) throw new Error('missing delta index entry');
    const page = bytes.subarray(mid * DELTA_INDEX_PAGE_BYTES, (mid + 1) * DELTA_INDEX_PAGE_BYTES);
    page.writeBigUInt64LE(BigInt(entry.o));
    page[8] = entry.src === 'chunk' ? 1 : 2;

    if (entry.src === 'chunk') Buffer.from(v.parse(Hex64, entry.d), 'hex').copy(page, 16);
    Buffer.from(build(lo, mid), 'hex').copy(page, 48);
    Buffer.from(build(mid + 1, hi), 'hex').copy(page, 80);

    return digest(page);
  };

  const root = entries.length === 0 ? EMPTY_DIGEST : build(0, entries.length);

  return { ref: { index: digest(bytes), root, count: entries.length }, bytes };
}

/** Only the visited search path is read and authenticated. An invalid page
 * throws; it never means absent. Off-path corruption is detected on demand. */
export function lookupDeltaIndex(ref: DeltaIndexRef, size: number, offset: number,
  read: (offset: number, length: number) => Uint8Array): DeltaOverride | null {
  v.parse(DeltaIndexRefSchema, ref);

  if (ref.count > Math.ceil(size / DELTA_BLOCK_BYTES)) throw new Error('delta index count exceeds file');

  if (ref.count === 0) {
    if (ref.root !== EMPTY_DIGEST || ref.index !== EMPTY_DIGEST) throw new Error('invalid empty delta index');

    return null;
  }

  let lo = 0;
  let hi = ref.count;
  let lower = -1;
  let upper = size;
  let expected = ref.root;

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const raw = read(mid * DELTA_INDEX_PAGE_BYTES, DELTA_INDEX_PAGE_BYTES);

    if (raw.byteLength !== DELTA_INDEX_PAGE_BYTES || digest(raw) !== expected) throw new Error('corrupt delta index page');
    const page = Buffer.from(raw);
    const at = Number(page.readBigUInt64LE());
    validOffset(at, upper, lower);
    const src = page[8];
    const d = page.subarray(16, 48).toString('hex');
    const left = page.subarray(48, 80).toString('hex');
    const right = page.subarray(80, 112).toString('hex');

    if ((src !== 1 && src !== 2) || page.subarray(9, 16).some(byte => byte !== 0)
      || page.subarray(112).some(byte => byte !== 0) || (src === 2 && d !== NULL_CHILD)
      || (lo === mid) !== (left === NULL_CHILD) || (mid + 1 === hi) !== (right === NULL_CHILD)) {
      throw new Error('invalid delta index page');
    }

    if (offset === at) return src === 1 ? { o: at, src: 'chunk', d } : { o: at, src: 'hole' };

    if (offset < at) { hi = mid; upper = at; expected = left; }
    else { lo = mid + 1; lower = at; expected = right; }
  }

  return null;
}


