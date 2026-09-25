// XXH64 in BigInt: workerd has no native one.
const P1 = 0x9e3779b185ebca87n;

const P2 = 0xc2b2ae3d27d4eb4fn;

const P3 = 0x165667b19e3779f9n;

const P4 = 0x85ebca77c2b2ae63n;

const P5 = 0x27d4eb2f165667c5n;

const MASK = 0xffffffffffffffffn;

function rotl(x: bigint, r: bigint): bigint {
  return ((x << r) | (x >> (64n - r))) & MASK;
}

function round(acc: bigint, lane: bigint): bigint {
  return (rotl((acc + lane * P2) & MASK, 31n) * P1) & MASK;
}

function merge(acc: bigint, lane: bigint): bigint {
  return (((acc ^ round(0n, lane)) * P1) + P4) & MASK;
}

function stripes(view: DataView, seed: bigint) {
  const lanes = [(seed + P1 + P2) & MASK, (seed + P2) & MASK, seed, (seed - P1) & MASK];
  let offset = 0;

  for (; offset + 32 <= view.byteLength; offset += 32) {
    for (let lane = 0; lane < 4; lane++) lanes[lane] = round(lanes[lane] ?? 0n, view.getBigUint64(offset + lane * 8, true));
  }

  const [v1 = 0n, v2 = 0n, v3 = 0n, v4 = 0n] = lanes;
  const joined = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & MASK;

  return { hash: lanes.reduce(merge, joined), consumed: offset };
}

export function xxHash64(bytes: Uint8Array, seed: bigint): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = bytes.byteLength >= 32 ? stripes(view, seed) : { hash: (seed + P5) & MASK, consumed: 0 };
  let hash = (head.hash + BigInt(bytes.byteLength)) & MASK;
  let offset = head.consumed;

  for (; offset + 8 <= bytes.byteLength; offset += 8) {
    hash = ((rotl(hash ^ round(0n, view.getBigUint64(offset, true)), 27n) * P1) + P4) & MASK;
  }

  if (offset + 4 <= bytes.byteLength) {
    hash = ((rotl(hash ^ ((BigInt(view.getUint32(offset, true)) * P1) & MASK), 23n) * P2) + P3) & MASK;
    offset += 4;
  }

  for (; offset < bytes.byteLength; offset++) {
    hash = (rotl(hash ^ ((BigInt(bytes[offset] ?? 0) * P5) & MASK), 11n) * P1) & MASK;
  }

  hash = ((hash ^ (hash >> 33n)) * P2) & MASK;
  hash = ((hash ^ (hash >> 29n)) * P3) & MASK;

  return hash ^ (hash >> 32n);
}
