/**
 * Asking an object store about a prefix, from inside a Durable Object.
 *
 * Two functions, no state, no `this`. They were methods and a file-scope helper
 * on the Devbox class, which owns a container's lifecycle and had no business
 * also owning store bookkeeping; here they sit beside the storage seam they
 * serve, and each strategy's adapter is one line long again.
 *
 * NEITHER OF THEM MOVES A PAYLOAD BYTE, and that is now the whole point of the
 * file. There was a third function here — `putStream`, an isolate-side upload
 * with its own multipart part slicer — and it was the last thing in the product
 * that carried an archive through a Durable Object. Every strategy now moves
 * payload container-side through a prefix-scoped store mount, so what is left
 * here is listing and deleting: bounded, paged, metadata-only work that a box
 * really does need its own binding for.
 *
 * The upload itself went to `scripts/fixtures/payload-transport/isolate-relay.ts`,
 * which is the instrument that priced it and the only thing that still runs it.
 * A product file importing that fixture back is a defect its own suite catches.
 */

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
