/**
 * Content-defined chunking over a file's LOGICAL bytes.
 *
 * Sparse holes never enter the rolling hash: they carry no entropy, so boundary
 * search there is meaningless. A hole is cut at target alignment instead, which
 * makes every interior hole chunk the SAME shared zero digest (one index entry,
 * one packed extent, one range fetch for the whole span) and costs O(runs) work
 * rather than O(logical bytes). Dense runs run a buzhash CDC whose window state
 * restarts at each segment start and at every cut, so boundaries depend on local
 * content only.
 */

import { sha256Hex } from '../../cas/hash';
import type { AuditedCapture, FileContent, NodeEntry } from '../../capture/model';
import { readCaptureRange } from '../../capture/model';

import { MerklePackError } from './errors';

/** Content-defined chunking bounds. Defaults sit far below the 512 KiB blob
 *  scale of cas/hash so ordinary workspace files split into reusable chunks. */
export interface ChunkParams {
  readonly minBytes: number;
  /** Rounded to the nearest power of two for the boundary mask. */
  readonly targetBytes: number;
  readonly maxBytes: number;
}

export const DEFAULT_CHUNK_PARAMS: ChunkParams = {
  minBytes: 2048,
  targetBytes: 4096,
  maxBytes: 16384,
};

/**
 * The chunker's masks and rotations live in 32-bit arithmetic; bounds beyond
 * this would silently wrap and produce garbage boundary patterns.
 */
const MAX_CHUNK_BOUND = 0x40000000;

export function validateChunkParams(params: ChunkParams): void {
  const { minBytes, targetBytes, maxBytes } = params;
  const inDomain = (value: number): boolean =>
    Number.isSafeInteger(value) && value >= 1 && value <= MAX_CHUNK_BOUND;
  if (!inDomain(minBytes) || !inDomain(targetBytes) || !inDomain(maxBytes)) {
    throw new MerklePackError(
      'invalid-parameter',
      `chunk bounds must be integers in [1, ${MAX_CHUNK_BOUND}], got ${minBytes}/${targetBytes}/${maxBytes}`,
    );
  }
  if (minBytes > targetBytes || targetBytes > maxBytes) {
    throw new MerklePackError(
      'invalid-parameter',
      `chunk bounds must satisfy min <= target <= max, got ${minBytes}/${targetBytes}/${maxBytes}`,
    );
  }
}

function maskBits(params: ChunkParams): number {
  return Math.max(1, Math.round(Math.log2(params.targetBytes)));
}

// ── logical layout ────────────────────────────────────────────────────────────

interface Segment {
  readonly zeros: boolean;
  /** Absolute start offset in the logical file. */
  readonly start: number;
  readonly end: number;
  readonly view?: Uint8Array;
}

/** A file's logical bytes as an ordered segment list, plus the logical size. */
export interface LogicalLayout {
  readonly segments: Segment[];
  readonly size: number;
}

interface Claim {
  readonly start: number;
  readonly end: number;
  readonly view: Uint8Array;
}

function subtract(pieces: Array<[number, number]>, start: number, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [from, to] of pieces) {
    if (to <= start || from >= end) {
      out.push([from, to]);
      continue;
    }
    if (from < start) out.push([from, start]);
    if (end < to) out.push([end, to]);
  }
  return out;
}

/**
 * Canonical segment layout of a sparse file. Runs are applied LAST-WRITER-WINS
 * in array order — exactly the semantics of `out.set(run.bytes, run.offset)` —
 * so the painted result matches expandContent byte for byte even when runs
 * overlap or arrive unsorted. Unpainted gaps become explicit zero segments,
 * which is what keeps hole handling O(runs).
 */
export function paintedSegments(content: FileContent): LogicalLayout {
  if (content.kind === 'dense') {
    return {
      segments: [{ zeros: false, start: 0, end: content.bytes.byteLength, view: content.bytes }],
      size: content.bytes.byteLength,
    };
  }
  if (content.kind === 'sealed') {
    throw new MerklePackError('invalid-parameter', 'sealed capture content requires async chunking');
  }

  // Paint from the last run backwards so earlier runs only fill unclaimed
  // ranges; whatever a later run covered already stays later-run-owned.
  const claims: Claim[] = [];
  for (let i = content.runs.length - 1; i >= 0; i--) {
    const run = content.runs[i];
    const start = Math.min(Math.max(run.offset, 0), content.size);
    const end = Math.min(run.offset + run.bytes.byteLength, content.size);
    if (end <= start) continue;
    let pieces: Array<[number, number]> = [[start, end]];
    for (const claim of claims) pieces = subtract(pieces, claim.start, claim.end);
    for (const [from, to] of pieces) {
      claims.push({ start: from, end: to, view: run.bytes.subarray(from - run.offset, to - run.offset) });
    }
  }
  claims.sort((a, b) => a.start - b.start);

  const segments: Segment[] = [];
  let cursor = 0;
  for (const claim of claims) {
    if (claim.start > cursor) segments.push({ zeros: true, start: cursor, end: claim.start });
    segments.push({ zeros: false, start: claim.start, end: claim.end, view: claim.view });
    cursor = claim.end;
  }
  if (cursor < content.size) segments.push({ zeros: true, start: cursor, end: content.size });
  return { segments, size: content.size };
}

// ── the chunker ───────────────────────────────────────────────────────────────

export interface EmittedChunk {
  readonly digest: string;
  /** Backing bytes; zero-cache entries are SHARED and must be treated read-only. */
  readonly bytes: Uint8Array;
}

/**
 * Buzhash table from a fixed xorshift32 sequence: deterministic across runs and
 * machines without shipping 256 magic constants.
 */
const BUZ_TABLE = (() => {
  const table = new Uint32Array(256);
  let s = 0x9e3779b9 | 0;
  for (let i = 0; i < 256; i++) {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    table[i] = s >>> 0;
  }
  return table;
})();

function rotl(x: number, bits: number): number {
  const k = bits % 32;
  return k === 0 ? x | 0 : ((x << k) | (x >>> (32 - k))) | 0;
}

const MAX_ZERO_CACHE_ENTRIES = 512;

function zeroChunk(length: number, cache: Map<number, EmittedChunk>): EmittedChunk {
  let cached = cache.get(length);
  if (cached === undefined) {
    const zeros = new Uint8Array(length);
    cached = { digest: sha256Hex(zeros), bytes: zeros };
    // Distinct lengths stay few (two hole edges per run); bound anyway so no
    // adversarial pattern turns the cache into unbounded memory.
    if (cache.size < MAX_ZERO_CACHE_ENTRIES) cache.set(length, cached);
  }
  return cached;
}

/**
 * Chunk the laid-out bytes. Cuts inside data fire where `(hash & mask) === 0`
 * past the minimum or forced at maxBytes. A hole emits arithmetic repetitions
 * of one target-sized zero chunk plus at most one tail; it never walks its
 * apparent byte length. Returns the logical size.
 */
export function chunkLogical(
  layout: LogicalLayout,
  params: ChunkParams,
  zeroCache: Map<number, EmittedChunk>,
  emit: (offset: number, chunk: EmittedChunk, count: number) => void,
): number {
  validateChunkParams(params);
  const bits = maskBits(params);
  const mask = (1 << bits) - 1;
  const W = params.minBytes;
  const removeTable = new Uint32Array(256);
  for (let b = 0; b < 256; b++) removeTable[b] = rotl(BUZ_TABLE[b], W - 1);

  for (const seg of layout.segments) {
    if (seg.zeros) {
      const span = seg.end - seg.start;
      const wholeChunks = Math.floor(span / params.targetBytes);
      if (wholeChunks > 0) {
        emit(seg.start, zeroChunk(params.targetBytes, zeroCache), wholeChunks);
      }
      const tail = span % params.targetBytes;
      if (tail > 0) {
        emit(seg.start + wholeChunks * params.targetBytes, zeroChunk(tail, zeroCache), 1);
      }
      continue;
    }

    const view = seg.view!;
    let h = 0;
    let filled = 0;
    let head = 0;
    const win = new Uint8Array(W);
    let pos = seg.start;
    let chunkStart = seg.start;

    const cutData = (): void => {
      // A data segment is one contiguous view, so the chunk is a plain slice.
      const piece = view.subarray(chunkStart - seg.start, pos - seg.start);
      emit(chunkStart, { digest: sha256Hex(piece), bytes: piece }, 1);
      h = 0;
      filled = 0;
      head = 0;
      chunkStart = pos;
    };

    while (pos < seg.end) {
      const byte = view[pos - seg.start];
      if (filled < W) {
        h = (rotl(h, 1) ^ BUZ_TABLE[byte]) | 0;
        filled++;
      } else {
        h = (rotl(h ^ removeTable[win[head]], 1) ^ BUZ_TABLE[byte]) | 0;
      }
      win[head] = byte;
      head = head + 1 === W ? 0 : head + 1;
      pos++;
      if (pos - chunkStart >= params.maxBytes || (filled === W && (h & mask) === 0)) cutData();
    }
    if (seg.end > chunkStart) cutData();
  }
  return layout.size;
}

/**
 * Incremental data CDC. A sealed extent arrives through bounded capture reads,
 * not as one resident buffer, so state spans adjacent reads and extents. A
 * sparse hole ends the data run; every regular CDC cut starts the next run.
 */
class StreamingDataChunker {
  readonly #params: ChunkParams;
  readonly #emit: (offset: number, chunk: EmittedChunk, count: number) => void;
  readonly #bits: number;
  readonly #mask: number;
  readonly #window: Uint8Array;
  readonly #removeTable: Uint32Array;
  #hash = 0;
  #filled = 0;
  #head = 0;
  #chunk = new Uint8Array(0);
  #chunkLength = 0;
  #chunkStart = 0;
  #nextOffset: number | undefined;

  constructor(
    params: ChunkParams,
    emit: (offset: number, chunk: EmittedChunk, count: number) => void,
  ) {
    this.#params = params;
    this.#emit = emit;
    this.#bits = maskBits(this.#params);
    this.#mask = (1 << this.#bits) - 1;
    this.#window = new Uint8Array(this.#params.minBytes);
    this.#removeTable = new Uint32Array(256);
    for (let byte = 0; byte < 256; byte++) {
      this.#removeTable[byte] = rotl(BUZ_TABLE[byte], this.#params.minBytes - 1);
    }
  }

  #ensureChunkCapacity(required: number): void {
    if (this.#chunk.byteLength >= required) return;
    const capacity = Math.min(this.#params.maxBytes, Math.max(required, this.#chunk.byteLength * 2));
    const next = new Uint8Array(capacity);
    next.set(this.#chunk.subarray(0, this.#chunkLength));
    this.#chunk = next;
  }

  #cut(nextStart: number): void {
    this.#emit(
      this.#chunkStart,
      { digest: sha256Hex(this.#chunk.subarray(0, this.#chunkLength)), bytes: this.#chunk.subarray(0, this.#chunkLength) },
      1,
    );
    this.#hash = 0;
    this.#filled = 0;
    this.#head = 0;
    this.#chunk = new Uint8Array(0);
    this.#chunkLength = 0;
    this.#chunkStart = nextStart;
  }

  push(offset: number, bytes: Uint8Array): void {
    if (this.#nextOffset !== undefined && this.#nextOffset !== offset) {
      throw new MerklePackError('invalid-parameter', 'sealed data CDC input is not contiguous');
    }
    if (this.#nextOffset === undefined) this.#chunkStart = offset;
    for (let index = 0; index < bytes.byteLength; index++) {
      if (this.#chunkLength === this.#chunk.byteLength) {
        this.#ensureChunkCapacity(Math.min(this.#params.maxBytes, this.#chunkLength + bytes.byteLength - index));
      }
      const byte = bytes[index];
      this.#chunk[this.#chunkLength++] = byte;
      if (this.#filled < this.#params.minBytes) {
        this.#hash = (rotl(this.#hash, 1) ^ BUZ_TABLE[byte]) | 0;
        this.#filled++;
      } else {
        this.#hash = (rotl(this.#hash ^ this.#removeTable[this.#window[this.#head]], 1) ^ BUZ_TABLE[byte]) | 0;
      }
      this.#window[this.#head] = byte;
      this.#head = this.#head + 1 === this.#params.minBytes ? 0 : this.#head + 1;
      const next = offset + index + 1;
      if (
        this.#chunkLength >= this.#params.maxBytes ||
        (this.#filled === this.#params.minBytes && (this.#hash & this.#mask) === 0)
      ) {
        this.#cut(next);
      }
    }
    this.#nextOffset = offset + bytes.byteLength;
  }

  finish(): void {
    if (this.#chunkLength > 0) this.#cut(this.#chunkStart + this.#chunkLength);
    this.#nextOffset = undefined;
  }
}

/**
 * Chunk one audited capture entry. Dense and sparse payloads retain the local
 * synchronous algorithm; sealed payloads read only bounded staged ranges via
 * the capture authority — never expandContent and never an eager fallback.
 */
export async function chunkCaptureContent(
  capture: AuditedCapture,
  entry: NodeEntry,
  params: ChunkParams,
  zeroCache: Map<number, EmittedChunk>,
  emit: (offset: number, chunk: EmittedChunk, count: number) => void,
): Promise<number> {
  if (entry.kind !== 'file' || entry.content === undefined) {
    throw new MerklePackError('invalid-parameter', 'chunking requires a file entry with content');
  }
  if (entry.content.kind !== 'sealed') {
    return chunkLogical(paintedSegments(entry.content), params, zeroCache, emit);
  }

  validateChunkParams(params);
  const emitHole = (offset: number, length: number): void => {
    const whole = Math.floor(length / params.targetBytes);
    if (whole > 0) emit(offset, zeroChunk(params.targetBytes, zeroCache), whole);
    const tail = length % params.targetBytes;
    if (tail > 0) emit(offset + whole * params.targetBytes, zeroChunk(tail, zeroCache), 1);
  };

  const data = new StreamingDataChunker(params, emit);
  let cursor = 0;
  for (const extent of entry.content.extents) {
    if (extent.offset < cursor || extent.offset + extent.length > entry.content.size) {
      throw new MerklePackError('invalid-parameter', `sealed extents for ${entry.path} overlap or exceed file bounds`);
    }
    // A sparse hole has no entropy. It terminates the prior data run, then
    // preserves the O(runs) zero representation without a staged payload read.
    if (extent.offset > cursor) {
      data.finish();
      emitHole(cursor, extent.offset - cursor);
    }

    for (let offset = extent.offset; offset < extent.offset + extent.length;) {
      const length = Math.min(params.maxBytes, extent.offset + extent.length - offset);
      data.push(offset, await readCaptureRange(capture, entry, offset, length));
      offset += length;
    }
    cursor = extent.offset + extent.length;
  }
  data.finish();
  if (cursor < entry.content.size) emitHole(cursor, entry.content.size - cursor);
  return entry.content.size;
}
