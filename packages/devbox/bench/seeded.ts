/** The deterministic byte generator shared by the conformance and live workloads. */
export class Seeded {
  #state: number;

  constructor(seed: number) {
    this.#state = (seed >>> 0) || 0x9e3779b9;
  }

  next(): number {
    let x = this.#state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.#state = x >>> 0;

    return this.#state;
  }

  below(bound: number): number {
    return this.next() % bound;
  }

  fill(bytes: Uint8Array): Uint8Array {
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2);

    for (let at = 0; at < words.length; at++) words[at] = this.next();

    for (let at = words.length << 2; at < bytes.byteLength; at++) bytes[at] = this.next() & 0xff;

    return bytes;
  }
}
