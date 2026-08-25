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

/** Largest object moved through memory in one PUT before multipart takes over,
 *  and the part size above that threshold. Both 8 MiB — this package's own
 *  budget, not a platform number: one buffered copy of that size fits well
 *  under the isolate ceiling (`worker.isolate.memory` in the platform
 *  catalog), and a part that size keeps the part count low for an archive of
 *  any realistic workspace. */
const SINGLE_PUT_MAX_BYTES = 8 * 1024 * 1024;
const MULTIPART_PART_BYTES = 8 * 1024 * 1024;

/**
 * Move staged bytes into the store.
 *
 * A small object is one atomic PUT. A larger one streams through bounded-memory
 * multipart parts.
 *
 * ANSWERS WHAT LANDED, which is not always what the caller expected. `size` is
 * the caller's measurement taken before the read, and a file still settling on
 * disk yields MORE than it claimed: a deployed run recorded a delta as
 * 700387328 bytes and landed 702791680, after which every wake refused because
 * the integrity probe compares the record against the object. The count
 * returned here is the one a durable record may carry.
 */
export async function putStream(
  bucket: R2Bucket,
  key: string,
  stream: ReadableStream<Uint8Array>,
  size: number,
): Promise<number> {
  if (size <= SINGLE_PUT_MAX_BYTES) {
    // `size` ROUTES, IT DOES NOT BOUND. It is the caller's measurement of a file
    // the caller no longer controls, and a short one must not truncate the
    // upload or overflow the buffer — `Uint8Array.set` past the end throws, so
    // trusting it for capacity turns a stale number into a failed checkpoint.
    // The chunks decide the length; the hint only picks the lane.
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    let offset = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true || value === undefined) break;
      chunks.push(value);
      offset += value.byteLength;
    }
    const buffer = new Uint8Array(offset);
    let at = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, at);
      at += chunk.byteLength;
    }
    await bucket.put(key, buffer);
    return offset;
  }
  const multipart = await bucket.createMultipartUpload(key);
  try {
    const reader = stream.getReader();
    const parts: R2UploadedPart[] = [];
    let carry = new Uint8Array(0);
    let partNumber = 1;
    let landed = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true || value === undefined) break;
      const merged = new Uint8Array(carry.byteLength + value.byteLength);
      merged.set(carry);
      merged.set(value, carry.byteLength);
      if (merged.byteLength < MULTIPART_PART_BYTES) {
        carry = merged;
        continue;
      }
      const whole = Math.floor(merged.byteLength / MULTIPART_PART_BYTES) * MULTIPART_PART_BYTES;
      parts.push(await multipart.uploadPart(partNumber, merged.subarray(0, whole)));
      landed += whole;
      partNumber += 1;
      carry = merged.slice(whole);
    }
    if (carry.byteLength > 0) {
      parts.push(await multipart.uploadPart(partNumber, carry));
      landed += carry.byteLength;
    }
    await multipart.complete(parts);
    return landed;
  } catch (error) {
    // THE ORIGINAL ERROR IS THE ONE THAT MATTERS. Abandoning the upload is
    // best-effort cleanup: if the abort itself fails, saying so must not
    // replace the reason the upload failed, which is what an unguarded
    // `await multipart.abort()` here did.
    try {
      await multipart.abort();
    } catch (abortFailure) {
      console.error(
        `[devbox] the abandoned multipart upload for ${key} was not aborted: `
        + `${abortFailure instanceof Error ? abortFailure.message : String(abortFailure)}`,
      );
    }
    throw error;
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
