/** FNV-1a, 64 bits, over UTF-16 code units: fast, non-cryptographic fingerprint shared across the tree. */

export function fnv1a64(text: string): string {
  const hash = new Fnv1a64();

  hash.update(text);

  return hash.digest();
}

/**
 * Streaming form; split points are invisible (one code unit at a time), so digests equal `fnv1a64`.
 * 16-bit limb multiplies instead of BigInt: prime 0x100000001b3 = 2^40 + 0x1b3, so each limb multiplies
 * by 0x1b3 and the 2^40 term shifts limbs 0/1 into limbs 2/3 by 8 bits.
 */
export class Fnv1a64 {
  // Offset basis 0xcbf29ce484222325 split into 16-bit limbs, low → high.
  private v0 = 0x2325;
  private v1 = 0x8422;
  private v2 = 0x9ce4;
  private v3 = 0xcbf2;

  /** Limbs are lifted into locals and stored back once, avoiding per-character property writes. */
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

  /** Does not end the hash; a later `update` continues from here. */
  digest(): string {
    return (
      this.v3.toString(16).padStart(4, '0') +
      this.v2.toString(16).padStart(4, '0') +
      this.v1.toString(16).padStart(4, '0') +
      this.v0.toString(16).padStart(4, '0')
    );
  }
}
