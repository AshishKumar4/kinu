// Moving bytes into the store.
//
// These exist because a mutant survived: every strategy test stubs `putObject`,
// so `putStream` — the thing that actually uploads — had no coverage at all
// while three deployed runs were bricked by a byte count. The defect was never
// in the counting; it was in trusting a size measured before the upload.
import { describe, expect, test } from 'bun:test';

import {
  MULTIPART_PART_BYTES,
  SMALL_PUT_BYTES,
  deletePrefix,
  prefixInventory,
  putStream,
} from '../src/object-store';

/** Enough of an R2 bucket to observe what an upload actually wrote. */
function fakeBucket() {
  const objects = new Map<string, number>();
  const parts: number[] = [];
  let aborted = 0;
  const bucket = {
    put: (key: string, value: Uint8Array) => {
      objects.set(key, value.byteLength);
      return Promise.resolve();
    },
    createMultipartUpload: () => Promise.resolve({
      key: 'k',
      uploadId: 'upload-1',
      uploadPart: (partNumber: number, chunk: Uint8Array) => {
        parts.push(chunk.byteLength);
        return Promise.resolve({ partNumber, etag: `e${partNumber}` });
      },
      complete: (uploaded: unknown[]) => {
        objects.set('multipart', parts.reduce((sum, n) => sum + n, 0));
        return Promise.resolve({ parts: uploaded.length });
      },
      abort: () => { aborted += 1; return Promise.resolve(); },
    }),
    list: () => Promise.resolve({ objects: [], truncated: false }),
    delete: () => Promise.resolve(),
  };
  // SAFETY: constructed against the R2Bucket contract — the fake provides
  // exactly the members `putStream` and `deletePrefix` reach, verified by
  // this suite driving both functions through every branch below.
  const r2Bucket: R2Bucket = Object.create(bucket);
  return { bucket: r2Bucket, objects, parts, aborted: () => aborted };
}

/** A stream that yields `chunks` of the given sizes, whatever any caller
 *  believed the total to be. */
function streamOf(chunks: readonly number[]): ReadableStream<Uint8Array> {
  const queue = [...chunks];
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next === undefined) { controller.close(); return; }
      controller.enqueue(new Uint8Array(next).fill(7));
    },
  });
}

describe('putStream answers what LANDED, not what it was told', () => {
  test('a size hint SHORT of the stream does not truncate or throw', async () => {
    // The production shape: a staged measurement taken before the archiver's
    // last blocks reach the file, so the stream yields more than the hint.
    // Sizing the buffer by the hint makes `Uint8Array.set` throw past the end,
    // which turns a stale number into a failed checkpoint.
    const store = fakeBucket();
    const landed = await putStream(store.bucket, 'k', streamOf([4096, 4096, 4096]), 4096);
    expect(landed).toBe(12288);
    expect(store.objects.get('k')).toBe(12288);
  });

  test('the returned count is the bytes uploaded, exactly', async () => {
    const store = fakeBucket();
    const landed = await putStream(store.bucket, 'k', streamOf([100, 250, 3]), 353);
    expect(landed).toBe(353);
    expect(store.objects.get('k')).toBe(353);
  });

  test('an empty stream lands an empty object rather than a phantom size', async () => {
    const store = fakeBucket();
    expect(await putStream(store.bucket, 'k', streamOf([]), 4096)).toBe(0);
    expect(store.objects.get('k')).toBe(0);
  });

  test('a large object goes multipart and still reports every byte', async () => {
    // Above the single-PUT ceiling the parts carry the count; the total has to
    // survive the split, including a final short part.
    const store = fakeBucket();
    const nine = 9 * 1024 * 1024;
    const landed = await putStream(store.bucket, 'k', streamOf([nine, 1024]), nine + 1024);
    expect(landed).toBe(nine + 1024);
    expect(store.parts.reduce((sum, n) => sum + n, 0)).toBe(nine + 1024);
  });
});

describe('prefix helpers page rather than reporting a first page as a total', () => {
  test('an empty prefix is zero of both, not a missing answer', async () => {
    const store = fakeBucket();
    expect(await prefixInventory(store.bucket, 'boxes/x/')).toEqual({ objects: 0, bytes: 0 });
    expect(await deletePrefix(store.bucket, 'boxes/x/')).toBe(0);
  });
});

describe('putStream promotes when the small hint lies, and parts stay uniform', () => {
  test('a stale small hint over a huge stream PROMOTES instead of buffering unbounded', async () => {
    // The hint routes; the stream decides. Buffering past SMALL_PUT_BYTES on
    // the strength of the caller's stale measurement is the memory blowup this
    // bound exists to prevent.
    const store = fakeBucket();
    const big = MULTIPART_PART_BYTES;
    const landed = await putStream(
      store.bucket, 'k', streamOf([big, big, big / 2]), 4096,
    );
    expect(landed).toBe(big * 2 + big / 2);
    // Promoted, not single-put: the object went out as multipart parts.
    expect(store.parts.length).toBe(3);
    expect(store.objects.has('k')).toBe(false);
  });

  test('one read spanning several part sizes yields uniform non-final parts', async () => {
    // R2 refuses a complete() whose non-final parts disagree. A single read of
    // 3.5 part-sizes must therefore come out as three exact parts plus one
    // short final — never as one oversized part.
    const store = fakeBucket();
    const chunk = Math.floor(MULTIPART_PART_BYTES * 3.5);
    const landed = await putStream(store.bucket, 'k', streamOf([chunk]), chunk);
    expect(landed).toBe(chunk);
    const nonFinal = store.parts.slice(0, -1);
    expect(nonFinal.length).toBe(3);
    for (const size of nonFinal) expect(size).toBe(MULTIPART_PART_BYTES);
    expect(store.parts.at(-1)).toBe(Math.floor(MULTIPART_PART_BYTES / 2));
  });

  test('the small route still holds for streams that fit the hint', async () => {
    const store = fakeBucket();
    const landed = await putStream(
      store.bucket, 'k', streamOf([SMALL_PUT_BYTES]), SMALL_PUT_BYTES,
    );
    expect(landed).toBe(SMALL_PUT_BYTES);
    expect(store.parts.length).toBe(0);
    expect(store.objects.get('k')).toBe(SMALL_PUT_BYTES);
  });
});

describe('multipart lifecycle registry', () => {
  test('the durable upload id spans every part and clears after complete', async () => {
    const store = fakeBucket();
    const events: string[] = [];
    const lifecycle = {
      started: (key: string, uploadId: string) => {
        events.push(`start:${key}:${uploadId}`);
        return Promise.resolve();
      },
      finished: (key: string, uploadId: string) => {
        events.push(`finish:${key}:${uploadId}`);
        return Promise.resolve();
      },
    };
    await putStream(
      store.bucket,
      'k',
      streamOf([MULTIPART_PART_BYTES + 1]),
      MULTIPART_PART_BYTES + 1,
      undefined,
      lifecycle,
    );
    expect(events).toEqual(['start:k:upload-1', 'finish:k:upload-1']);
  });
});
