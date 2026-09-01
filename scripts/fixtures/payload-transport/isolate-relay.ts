/**
 * THE ISOLATE RELAY THIS INSTRUMENT PRICES: pull a container file out through
 * the owning Durable Object and upload it from there.
 *
 * IT LIVES HERE BECAUSE THE PRODUCT NO LONGER HAS IT. This was
 * `packages/devbox/src/object-store.ts`'s `putStream`, and the `do-base64` arm
 * called it so the number would be devbox's own rather than a copy's. The
 * instrument answered on 2026-09-01: 3.34 MiB/s at 64 MiB and 3.64 at 256 MiB
 * through the isolate, against 23.22 and 39.00 MiB/s for the same bytes moved
 * by the container itself. The snapshot chain now writes its archive through a
 * store mount, the isolate-side upload is deleted from the product, and the arm
 * keeps this shape as the baseline that removal is measured against. So the
 * shape moved to the arm that still measures it.
 *
 * NOTHING IN THE PRODUCT MAY IMPORT THIS. A devbox that carries payload through
 * its own isolate is the defect the mount path removed; this file is a fixture,
 * and `scripts/payload-transport.test.ts` holds it to that.
 *
 * WHAT IS UNCHANGED FROM THE PRODUCT COPY: the routing boundary, the part
 * geometry, and the digest taken over the bytes as they pass. Only the two
 * pass-through parameters no caller here supplies — R2 put options and the
 * multipart registry hook — are gone, because a dead parameter is a dead
 * declaration.
 */

import { createHash } from 'node:crypto';

import { describeThrown } from '../../../packages/devbox/src/lifecycle';

/** Largest object moved through the isolate in one PUT before multipart takes
 *  over, and the smallest tier this instrument measures (`arms.ts`). Not a
 *  platform number: one buffered copy of that size fits well under the isolate
 *  ceiling (`worker.isolate.memory` in the platform catalog). */
const SMALL_PUT_BYTES = 8 * 1024 * 1024;
/** The size of every non-final part of a multipart upload. R2 rejects a
 *  `complete()` whose parts are not uniform except for the last, so every part
 *  but the final short one is exactly this many bytes. */
const MULTIPART_PART_BYTES = 8 * 1024 * 1024;

/**
 * What an upload landed.
 *
 * THREE FACTS, AND NONE IS DERIVABLE FROM ANOTHER.
 *
 * `bytes` is what the store now holds, which a caller's own size hint has been
 * wrong about in production.
 *
 * `digest` is the SHA-256 of exactly those bytes, taken as they went past. The
 * driver compares it against the container's own `sha256sum`, so a transport
 * that corrupts is a `corrupt` cell rather than a fast one.
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
interface LandedObject {
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
        multipart = await bucket.createMultipartUpload(key);
        slicer = new PartSlicer(multipart);
        for (const chunk of buffered) await slicer.push(chunk);
      }
      await slicer.push(value);
    }
    if (slicer !== undefined) {
      const landed = await slicer.finish();
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
    const stored = await bucket.put(key, buffer, { sha256: hex });
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
          `[payload-bench] the abandoned multipart upload for ${key} was not aborted: `
          + describeThrown({ cause: abortFailure }),
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
