/**
 * Moving bytes in and out of an object store, from inside a Durable Object.
 *
 * Two functions, no state, no `this`. They were methods and a file-scope helper
 * on the Devbox class, which owns a container's lifecycle and had no business
 * also owning multipart bookkeeping; here they sit beside the storage seam they
 * serve, and each strategy's adapter is one line long again.
 *
 * The property both of them exist to preserve is the snapshot chain's crash
 * ordering: a visible object is complete or it is absent, never a mixture. A
 * reader that finds a delta object finds a whole delta.
 */

import { createHash } from 'node:crypto';

import { describeThrown } from './lifecycle';

/** Largest object moved through memory in one PUT before multipart takes over.
 *  This package's own budget, not a platform number: one buffered copy of that
 *  size fits well under the isolate ceiling (`worker.isolate.memory` in the
 *  platform catalog). */
export const SMALL_PUT_BYTES = 8 * 1024 * 1024;
/** The size of every non-final part of a multipart upload. R2 rejects a
 *  `complete()` whose parts are not uniform except for the last, so every part
 *  but the final short one is exactly this many bytes. */
export const MULTIPART_PART_BYTES = 8 * 1024 * 1024;

/**
 * Move staged bytes into the store.
 *
 * A small object is one atomic PUT. A larger one streams through multipart
 * parts of exactly {@link MULTIPART_PART_BYTES}, except the final short one.
 *
 * `size` ROUTES, IT DOES NOT BOUND. It is the caller's measurement of a file
 * the caller no longer controls, and it has been wrong in production: a
 * deployed run recorded a delta as 700387328 bytes and landed 702791680. So
 * the small route buffers at most {@link SMALL_PUT_BYTES} and then PROMOTES the
 * buffer into a multipart upload rather than trusting the hint — a stale small
 * hint over a huge stream stays bounded in memory and still lands every byte.
 * What comes back is what a durable record may carry: see
 * {@link LandedObject}.
 */
export interface MultipartLifecycle {
  started(key: string, uploadId: string): Promise<void>;
  finished(key: string, uploadId: string): Promise<void>;
}

/**
 * What an upload landed.
 *
 * THREE FACTS, AND NONE IS DERIVABLE FROM ANOTHER.
 *
 * `bytes` is what the store now holds, which a caller's own size hint has been
 * wrong about in production.
 *
 * `digest` is the SHA-256 of exactly those bytes, taken as they went past. It
 * cannot be recovered afterwards without reading the whole object back, which
 * is why a record that wants to know its archive's identity has to carry it.
 * ONE PASS, NO BUFFER: the hash is updated per chunk on the way through, so it
 * costs one CPU pass over bytes already in hand and holds nothing.
 *
 * `objectVersion` is the store's OWN name for this upload. R2 generates it per
 * upload and hands it back from both `put` and multipart `complete`, and
 * `head` reports it forever after. It is the one identity that survives where
 * the digest cannot be compared: the Workers multipart API carries no checksum,
 * so a large archive replaced by a different archive of identical length — even
 * one whose metadata was written to match — is a DIFFERENT upload and says so
 * through this field.
 */
export interface LandedObject {
  readonly bytes: number;
  /** Lowercase hex SHA-256 over every byte this upload sent. */
  readonly digest: string;
  /** The store's own version for this upload. */
  readonly objectVersion: string;
}

export async function putStream(
  bucket: R2Bucket,
  key: string,
  stream: ReadableStream<Uint8Array>,
  size: number,
  options?: R2PutOptions,
  lifecycle?: MultipartLifecycle,
): Promise<LandedObject> {
  const reader = stream.getReader();
  const digest = createHash('sha256');
  const buffered: Uint8Array[] = [];
  let held = 0;
  let multipart: R2MultipartUpload | undefined;
  let slicer: PartSlicer | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true || value === undefined) break;
      // HASHED ON THE WAY PAST, before anything routes it, so one byte is
      // hashed exactly once whichever route it takes.
      digest.update(value);
      if (slicer === undefined) {
        // The small route holds at most SMALL_PUT_BYTES in memory. `size`
        // ROUTES, IT DOES NOT BOUND: it is a measurement of a file the caller
        // no longer controls, and it has been wrong in production (a deployed
        // run recorded 700387328 bytes and landed 702791680). When the stream
        // crosses the line the buffer PROMOTES into a multipart upload —
        // seeding it with everything already read — so a stale small hint over
        // a huge stream stays bounded and still lands every byte.
        if (size <= SMALL_PUT_BYTES && held + value.byteLength <= SMALL_PUT_BYTES) {
          buffered.push(value);
          held += value.byteLength;
          continue;
        }
        const multipartOptions: R2MultipartOptions = {};
        if (options?.customMetadata !== undefined) {
          multipartOptions.customMetadata = options.customMetadata;
        }
        if (options?.httpMetadata !== undefined) {
          multipartOptions.httpMetadata = options.httpMetadata;
        }
        multipart = await bucket.createMultipartUpload(key, multipartOptions);
        await lifecycle?.started(key, multipart.uploadId);
        slicer = new PartSlicer(multipart);
        for (const chunk of buffered) await slicer.push(chunk);
      }
      await slicer.push(value);
    }
    if (slicer !== undefined) {
      const landed = await slicer.finish();
      if (multipart !== undefined) {
        try {
          await lifecycle?.finished(key, multipart.uploadId);
        } catch (finishFailure) {
          console.error(
            `[devbox] completed multipart registry cleanup failed for ${key}: `
            + describeThrown({ cause: finishFailure }),
          );
        }
      }
      return { ...landed, digest: digest.digest('hex') };
    }
    const buffer = new Uint8Array(held);
    let at = 0;
    for (const chunk of buffered) {
      buffer.set(chunk, at);
      at += chunk.byteLength;
    }
    // THE STORE VERIFIES THIS ROUTE ITSELF. A single PUT may carry the digest,
    // so R2 checks the bytes it received against it and refuses the object
    // rather than storing something else under this key — and it then REPORTS
    // that checksum on every later `head`, which is the only way a reader can
    // ask the store what it holds without reading the whole object back.
    // Multipart has no equivalent: neither `R2MultipartOptions` nor
    // `R2UploadPartOptions` carries a checksum. What BOTH routes have is the
    // stored object's `version`, which R2 mints per upload, so that is what
    // travels for a large archive.
    const hex = digest.digest('hex');
    const stored = await bucket.put(key, buffer, { ...options, sha256: hex });
    return { bytes: held, digest: hex, objectVersion: stored.version };
  } catch (error) {
    // THE ORIGINAL ERROR IS THE ONE THAT MATTERS. Abandoning the upload is
    // best-effort cleanup: if the abort itself fails, saying so must not
    // replace the reason the upload failed, which is what an unguarded
    // `await multipart.abort()` here did.
    if (multipart !== undefined) {
      try {
        await multipart.abort();
      } catch (abortFailure) {
        console.error(
          `[devbox] the abandoned multipart upload for ${key} was not aborted: `
          + describeThrown({ cause: abortFailure }),
        );
      }
      try {
        await lifecycle?.finished(key, multipart.uploadId);
      } catch (finishFailure) {
        console.error(
          `[devbox] abandoned multipart registry cleanup failed for ${key}: `
          + describeThrown({ cause: finishFailure }),
        );
      }
    }
    throw error;
  }
}

/** One multipart upload fed by a part slicer that never emits an oversized or
 *  non-uniform non-final part. R2 refuses a `complete()` whose parts disagree,
 *  so one read spanning several part sizes must come out as SEVERAL exact
 *  parts, never as one big one. */
class PartSlicer {
  readonly #parts: R2UploadedPart[] = [];
  #carry: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  #partNumber = 1;
  #landed = 0;

  constructor(private readonly upload: R2MultipartUpload) {}

  /** Feed one chunk; uploads every whole {@link MULTIPART_PART_BYTES} window
   *  it completes, keeping only the tail in memory. */
  async push(value: Uint8Array): Promise<void> {
    let merged = value;
    if (this.#carry.byteLength > 0) {
      merged = new Uint8Array(this.#carry.byteLength + value.byteLength);
      merged.set(this.#carry);
      merged.set(value, this.#carry.byteLength);
    }
    while (merged.byteLength >= MULTIPART_PART_BYTES) {
      const part = merged.subarray(0, MULTIPART_PART_BYTES);
      this.#parts.push(await this.upload.uploadPart(this.#partNumber, part));
      this.#landed += MULTIPART_PART_BYTES;
      this.#partNumber += 1;
      merged = merged.slice(MULTIPART_PART_BYTES);
    }
    this.#carry = merged;
  }

  /** Complete the upload, and answer both what landed and WHICH UPLOAD it was:
   *  `complete()` hands back the stored object, whose `version` R2 generates
   *  fresh for this upload and for no other. */
  async finish(): Promise<{ bytes: number; objectVersion: string }> {
    if (this.#carry.byteLength > 0) {
      this.#parts.push(await this.upload.uploadPart(this.#partNumber, this.#carry));
      this.#landed += this.#carry.byteLength;
      this.#carry = new Uint8Array(0);
    }
    const stored = await this.upload.complete(this.#parts);
    return { bytes: this.#landed, objectVersion: stored.version };
  }
}

/** Delete every object under a prefix, and say how many. Pages until the
 *  listing is empty, because a single list call is bounded and a partial delete
 *  would leave a box's bytes behind while reporting them gone. */
export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let deleted = 0;
  for (;;) {
    const page = await bucket.list({ prefix });
    const keys = page.objects.map(object => object.key);
    if (keys.length === 0) return deleted;
    await bucket.delete(keys);
    deleted += keys.length;
  }
}

/** How many objects a prefix holds and how many bytes they are. Pages for the
 *  same reason {@link deletePrefix} does: one list call is bounded, and a
 *  partial count reported as a total is how a box under-reports what it is
 *  storing. */
export async function prefixInventory(
  bucket: R2Bucket,
  prefix: string,
): Promise<{ objects: number; bytes: number }> {
  let objects = 0;
  let bytes = 0;
  let cursor: string | undefined;
  do {
    const options: R2ListOptions = { prefix };
    if (cursor !== undefined) options.cursor = cursor;
    const page = await bucket.list(options);
    for (const object of page.objects) {
      objects += 1;
      bytes += object.size;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return { objects, bytes };
}
