/**
 * FNV-1a, 64 bits, over UTF-16 code units — the fingerprint the tree shares.
 *
 * Four consumers, one algorithm: the cache-stability telemetry (system-prompt
 * byte stability, the dynamic_context block's own attribute), the compaction
 * engine's content-hash keys, the layer gate's observation keys, and the file
 * read ledger's record of which content a turn has actually read. It lives at
 * the platform layer because the file plane needs it and may not reach up into
 * prompting for it.
 */

/** One call over text already in hand. The streamed form below is the same
 *  digest for a caller that never holds the whole string at once. */
export function fnv1a64(text: string): string {
  const hash = new Fnv1a64();

  hash.update(text);

  return hash.digest();
}

/**
 * The same hash, fed in pieces — for a caller that must fingerprint a file's
 * WHOLE content without ever holding it, which is what the `file` read does.
 *
 * Split points are invisible by construction: the hash consumes one UTF-16
 * code unit at a time with no lookahead, so a surrogate pair straddling two
 * `update` calls digests exactly as it does in one, and a streamed digest is
 * COMPARABLE with a one-shot `fnv1a64` rather than merely similar to it.
 *
 * Implemented with 16-bit limb multiplies instead of BigInt (~30x faster on
 * megabyte inputs; the compaction plane made per-char BigInt a per-turn tax) —
 * digests are byte-identical to the previous BigInt implementation.
 * The FNV prime 0x100000001b3 = 2^40 + 0x1b3: each limb multiplies by
 * 0x1b3 (435), and the 2^40 term shifts limbs 0/1 into limbs 2/3 by
 * 8 bits. XOR input is the UTF-16 code unit (≤ 0xffff → low limb only).
 */
export class Fnv1a64 {
  // Offset basis 0xcbf29ce484222325 split into 16-bit limbs, low → high.
  private v0 = 0x2325;
  private v1 = 0x8422;
  private v2 = 0x9ce4;
  private v3 = 0xcbf2;

  /** Fold `text` in. Limbs are lifted into locals and stored back once: a
   *  per-character property write is the only difference between this and the
   *  whole-string loop it replaces, on inputs measured in megabytes. */
  update(text: string): void {
    let v0 = this.v0, v1 = this.v1, v2 = this.v2, v3 = this.v3;

    for (let i = 0; i < text.length; i++) {
      v0 ^= text.charCodeAt(i);
      let t0 = v0 * 0x1b3;
      let t1 = v1 * 0x1b3;
      let t2 = v2 * 0x1b3 + ((v0 << 8) & 0xffffff);
      let t3 = v3 * 0x1b3 + ((v1 << 8) & 0xffffff);
      t1 += t0 >>> 16;
      t2 += t1 >>> 16;
      t3 += t2 >>> 16;
      v0 = t0 & 0xffff;
      v1 = t1 & 0xffff;
      v2 = t2 & 0xffff;
      v3 = t3 & 0xffff;
    }

    this.v0 = v0;
    this.v1 = v1;
    this.v2 = v2;
    this.v3 = v3;
  }

  /** The digest of everything fed so far. Reading it does not end the hash —
   *  a later `update` continues from here. */
  digest(): string {
    return (
      this.v3.toString(16).padStart(4, '0') +
      this.v2.toString(16).padStart(4, '0') +
      this.v1.toString(16).padStart(4, '0') +
      this.v0.toString(16).padStart(4, '0')
    );
  }
}
