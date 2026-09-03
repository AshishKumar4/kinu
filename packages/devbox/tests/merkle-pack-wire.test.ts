import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

import { sha256Hex } from '../src/cas/hash';
import { MerklePackError } from '../src/candidates/merkle-pack';
import type { DirEntryV2, ExtentPageRefV2, ExtentV2, NodeV2, RecordRefV2 } from '../src/candidates/merkle-pack/wire';
import {
  EXTENTS_PER_PAGE,
  EXTENT_PAGE_SPAN_BYTES,
  MERKLE_PACK_V2_FORMAT,
  NodeV2Schema,
  SELF_PACK,
  decodeNodeV2,
  encodeNodeV2,
  extentPagesV2,
  hashNodeBytes,
  hashNodeV2Bytes,
  packKey,
  serializeNode,
} from '../src/candidates/merkle-pack/wire';

// ── fixtures ──────────────────────────────────────────────────────────────────
//
// Digests and pack keys are shaped, never computed: the wire authenticates
// nothing itself, it states where bytes are and what they must hash to. Only
// the paged-file case hashes real page bytes, because a page ref names the
// page record's own digest and length.

/** A distinct, well-formed digest per seed. */
function digest(seed: number): string {
  return seed.toString(16).padStart(64, '0');
}

const PACK_A = packKey(digest(0xa));
const PACK_B = packKey(digest(0xb));

function extent(seed: number, pack: string, offset: number, length = 4096, count = 1): ExtentV2 {
  return { digest: digest(seed), length, count, pack, offset };
}

function ref(seed: number, pack: string, offset: number, length: number): RecordRefV2 {
  return { id: digest(seed), sha256: digest(seed + 1000), pack, offset, length };
}

function entry(name: string, kind: DirEntryV2['kind'], seed: number, pack = PACK_A): DirEntryV2 {
  return { name, kind, ref: ref(seed, pack, seed * 100, 50) };
}

const metadata = {
  uid: 1000,
  gid: 1000,
  atimeNs: '1',
  mtimeNs: '2',
  ctimeNs: '3',
  xattrs: { 'user.a': 'YQ==', 'user.b': 'Yg==' },
};

const inlineFile: NodeV2 = {
  kind: 'file',
  mode: 0o644,
  ino: 7,
  size: 3 * 4096 + 8192,
  extents: {
    kind: 'inline',
    extents: [
      extent(1, PACK_B, 0),
      extent(2, PACK_B, 4096),
      extent(3, SELF_PACK, 0, 8192),
      extent(4, PACK_A, 100),
    ],
  },
  holes: [{ o: 4096, l: 4096 }],
  metadata,
};

const dir: NodeV2 = {
  kind: 'dir',
  mode: 0o755,
  ino: 1,
  entries: [entry('a.txt', 'file', 1), entry('b', 'dir', 2, PACK_B), entry('link', 'symlink', 3, SELF_PACK)],
};

const symlink: NodeV2 = { kind: 'symlink', mode: 0o777, ino: 9, target: '../a.txt', metadata };

/** A file's worth of extents, `count` of them, each in one of two packs. */
function extents(count: number): ExtentV2[] {
  const out: ExtentV2[] = [];
  for (let i = 0; i < count; i += 1) out.push(extent(i + 1, i % 2 === 0 ? PACK_A : SELF_PACK, i * 4096));
  return out;
}

/** Encode each page and describe it the way a builder would after placing the
 * pages back to back in the record's own pack. */
interface PlacedPages {
  readonly refs: ExtentPageRefV2[];
  readonly bytes: Uint8Array[];
}

function placedPages(pages: readonly (readonly ExtentV2[])[]): PlacedPages {
  const refs: ExtentPageRefV2[] = [];
  const bytes: Uint8Array[] = [];
  let offset = 0;
  let fileOffset = 0;
  for (const page of pages) {
    const encoded = encodeNodeV2({ kind: 'page', extents: page });
    const span = page.reduce((sum, item) => sum + item.length * item.count, 0);
    refs.push({
      id: hashNodeV2Bytes(encoded),
      sha256: sha256Hex(encoded),
      fileOffset,
      pack: SELF_PACK,
      offset,
      length: encoded.byteLength,
      extents: page.length,
      bytes: span,
    });
    bytes.push(encoded);
    offset += encoded.byteLength;
    fileOffset += span;
  }
  return { refs, bytes };
}

function expectRefused(work: () => void, reason: MerklePackError['reason'], detail: RegExp): void {
  try {
    work();
  } catch (error) {
    if (!(error instanceof MerklePackError)) {
      throw new Error(`expected a MerklePackError, got ${String(error)}`, { cause: error });
    }
    expect(error.reason).toBe(reason);
    expect(error.message).toMatch(detail);
    return;
  }
  throw new Error(`expected a MerklePackError with reason ${reason}, got a return`);
}

// ── the record vocabulary ─────────────────────────────────────────────────────

describe('merkle-pack/v2 wire', () => {
  test('the format is the one the durability contracts reserve', () => {
    expect(MERKLE_PACK_V2_FORMAT).toBe('merkle-pack/v2');
  });

  test('every record kind round-trips through its canonical bytes', () => {
    const page: NodeV2 = { kind: 'page', extents: extents(3) };
    for (const node of [inlineFile, dir, symlink, page]) {
      expect(decodeNodeV2(encodeNodeV2(node))).toEqual(node);
    }
  });

  test('a file extent carries its pack location, and a record names its own pack as SELF_PACK', () => {
    const decoded = decodeNodeV2(encodeNodeV2(inlineFile));
    if (decoded.kind !== 'file' || decoded.extents.kind !== 'inline') throw new Error('file did not round-trip');
    expect(decoded.extents.extents.map((item) => [item.pack, item.offset])).toEqual([
      [PACK_B, 0],
      [PACK_B, 4096],
      [SELF_PACK, 0],
      [PACK_A, 100],
    ]);
    // The pack table is in first-use order over the extents, and nothing else.
    const wire = JSON.parse(new TextDecoder().decode(encodeNodeV2(inlineFile)));
    expect(wire.P).toEqual([PACK_B, SELF_PACK, PACK_A]);
    expect(wire.c.map((item: { p: number }) => item.p)).toEqual([0, 0, 1, 2]);
  });

  test('a directory entry carries the child record location a reader needs, with no index', () => {
    const wire = JSON.parse(new TextDecoder().decode(encodeNodeV2(dir)));
    expect(Object.keys(wire)).toEqual(['v', 't', 'm', 'i', 'P', 'e']);
    expect(Object.keys(wire.e[0])).toEqual(['n', 'k', 'r', 's', 'p', 'o', 'l']);
    expect(wire.e.map((item: { n: string }) => item.n)).toEqual(['a.txt', 'b', 'link']);
  });

  test('v2 records hash under their own domain tag, so a v2 id never equals a v1 id of the same bytes', () => {
    const bytes = encodeNodeV2(symlink);
    expect(hashNodeV2Bytes(bytes)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashNodeV2Bytes(bytes)).not.toBe(hashNodeBytes(bytes));
    expect(hashNodeV2Bytes(bytes)).not.toBe(sha256Hex(bytes));
  });
});

// ── canonical form ────────────────────────────────────────────────────────────

describe('merkle-pack/v2 canonical form', () => {
  test('directory entries and xattr names encode identically under any input order', () => {
    const forward = encodeNodeV2({ ...dir, metadata });
    const shuffled: NodeV2 = {
      ...dir,
      entries: [dir.entries[2], dir.entries[0], dir.entries[1]],
      metadata: { ...metadata, xattrs: { 'user.b': 'Yg==', 'user.a': 'YQ==' } },
    };
    // The canonical DIGEST is pinned as a literal, not recomputed: this is
    // what a parent record references and what a reader authenticates, so a
    // change to the canonical order is a wire break, not a refactor. Drift
    // fails this test by name, which is the point.
    expect(hashNodeV2Bytes(encodeNodeV2(shuffled))).toBe(hashNodeV2Bytes(forward));
    const other = encodeNodeV2({ ...dir, metadata, entries: [...dir.entries].reverse() });
    expect(hashNodeV2Bytes(other)).toBe(hashNodeV2Bytes(forward));
    // A DIFFERENT record hashes differently, so the equality above is not
    // vacuous: the sorter orders, it does not erase.
    expect(hashNodeV2Bytes(encodeNodeV2(symlink))).not.toBe(hashNodeV2Bytes(forward));
  });

  test('a record the encoder writes decodes to itself and re-encodes byte for byte', () => {
    for (const node of [inlineFile, dir, symlink]) {
      const bytes = encodeNodeV2(node);
      expect(Buffer.from(encodeNodeV2(decodeNodeV2(bytes)))).toEqual(Buffer.from(bytes));
    }
  });

  test('bytes that spell a valid record in another key order are refused by name', () => {
    const canonical = JSON.parse(new TextDecoder().decode(encodeNodeV2(symlink)));
    const reordered = new TextEncoder().encode(JSON.stringify({ t: 'l', v: 2, ...canonical }));
    expect(v.safeParse(NodeV2Schema, JSON.parse(new TextDecoder().decode(reordered))).success).toBe(true);
    expectRefused(() => decodeNodeV2(reordered), 'malformed-node', /canonical spelling/u);
  });

  test('a repeated or unsorted directory name is refused, at encode and at decode', () => {
    expectRefused(
      () => encodeNodeV2({ ...dir, entries: [dir.entries[0], entry('a.txt', 'dir', 5)] }),
      'invalid-parameter',
      /"a\.txt" repeats/u,
    );
    const wire = JSON.parse(new TextDecoder().decode(encodeNodeV2(dir)));
    wire.e.reverse();
    const bytes = new TextEncoder().encode(JSON.stringify(wire));
    expectRefused(() => decodeNodeV2(bytes), 'malformed-node', /not sorted at "b"/u);
    expectRefused(
      () => encodeNodeV2({ ...dir, entries: [entry('..', 'dir', 5)] }),
      'invalid-parameter',
      /name "\.\." is not canonical/u,
    );
  });

  test('the pack table must be in first-use order, complete, and referenced', () => {
    const wire = JSON.parse(new TextDecoder().decode(encodeNodeV2(inlineFile)));
    const spell = (edit: (copy: { P: string[]; c: { p: number }[] }) => void): Uint8Array => {
      const copy = structuredClone(wire);
      edit(copy);
      return new TextEncoder().encode(JSON.stringify(copy));
    };
    expectRefused(() => decodeNodeV2(spell((copy) => { copy.P.push(packKey(digest(0xc))); })), 'malformed-node', /nothing references/u);
    expectRefused(() => decodeNodeV2(spell((copy) => { copy.c[0].p = 2; copy.c[3].p = 0; })), 'malformed-node', /first-use order/u);
    expectRefused(() => decodeNodeV2(spell((copy) => { copy.c[3].p = 3; })), 'malformed-node', /outside a table of 3/u);
    expectRefused(() => decodeNodeV2(spell((copy) => { copy.P[2] = copy.P[0]; })), 'malformed-node', /repeats a pack/u);
    expectRefused(() => decodeNodeV2(spell((copy) => { copy.P[0] = 'v1/merkle-pack/index/' + digest(1); })), 'malformed-node', /content-addressed pack key/u);
  });

  test('file geometry, holes and the inline-or-paged choice are validated before a byte is written', () => {
    const base = inlineFile.extents.kind === 'inline' ? inlineFile.extents.extents : [];
    expectRefused(
      () => encodeNodeV2({ ...inlineFile, size: inlineFile.size + 1 }),
      'invalid-parameter',
      /declares \d+ bytes but its extents resolve to/u,
    );
    expectRefused(
      () => encodeNodeV2({ ...inlineFile, holes: [{ o: 0, l: 4096 }, { o: 4000, l: 96 }] }),
      'invalid-parameter',
      /hole geometry/u,
    );
    expectRefused(
      () => encodeNodeV2({ ...inlineFile, extents: { kind: 'inline', extents: [...base, extent(5, PACK_A, 0, 0)] } }),
      'invalid-parameter',
      /Invalid value/u,
    );
    const wire = JSON.parse(new TextDecoder().decode(encodeNodeV2(inlineFile)));
    const both = new TextEncoder().encode(JSON.stringify({ ...wire, x: [] }));
    expectRefused(() => decodeNodeV2(both), 'malformed-node', /exactly one of the two/u);
    const neither = structuredClone(wire);
    delete neither.c;
    expectRefused(() => decodeNodeV2(new TextEncoder().encode(JSON.stringify(neither))), 'malformed-node', /exactly one of the two/u);
  });

  test('a v1 node, a versionless record and an unknown key are all refused', () => {
    const v1 = serializeNode({ t: 'l', m: 0o777, i: 9, g: '../a.txt' });
    expectRefused(() => decodeNodeV2(v1), 'malformed-node', /did not decode/u);
    const unknownKey = new TextEncoder().encode(JSON.stringify({ v: 2, t: 'l', m: 0o777, i: 9, g: 'x', extra: 1 }));
    expectRefused(() => decodeNodeV2(unknownKey), 'malformed-node', /extra/u);
    const wrongVersion = new TextEncoder().encode(JSON.stringify({ v: 3, t: 'l', m: 0o777, i: 9, g: 'x' }));
    expectRefused(() => decodeNodeV2(wrongVersion), 'malformed-node', /did not decode/u);
  });
});

// ── extent pages ──────────────────────────────────────────────────────────────

describe('merkle-pack/v2 extent pages', () => {
  test('up to one page of extents stays inline', () => {
    expect(extentPagesV2(extents(EXTENTS_PER_PAGE))).toEqual([]);
    const node: NodeV2 = {
      kind: 'file',
      mode: 0o644,
      ino: 3,
      size: EXTENTS_PER_PAGE * 4096,
      extents: { kind: 'inline', extents: extents(EXTENTS_PER_PAGE) },
      holes: [],
    };
    expect(decodeNodeV2(encodeNodeV2(node))).toEqual(node);
  });

  test('extents past the inline limit split where the file crosses a page span', () => {
    // ONE PAGE PER SPAN OF FILE, ending after the extent that carries the file
    // across it. 4 KiB extents and a 2 MiB span put 512 of them in a page.
    const perPage = EXTENT_PAGE_SPAN_BYTES / 4096;
    const list = extents(EXTENTS_PER_PAGE + 1);
    const pages = extentPagesV2(list);
    expect(pages.map((page) => page.length)).toEqual([perPage, perPage, 1]);
    expect(pages.flat()).toEqual(list);

    const placed = placedPages(pages);
    for (const [index, bytes] of placed.bytes.entries()) {
      expect(decodeNodeV2(bytes)).toEqual({ kind: 'page', extents: pages[index] });
    }
    const node: NodeV2 = {
      kind: 'file',
      mode: 0o644,
      ino: 3,
      size: list.length * 4096,
      extents: { kind: 'paged', pages: placed.refs },
      holes: [],
    };
    const decoded = decodeNodeV2(encodeNodeV2(node));
    expect(decoded).toEqual(node);
    if (decoded.kind !== 'file' || decoded.extents.kind !== 'paged') throw new Error('file did not stay paged');
    expect(decoded.extents.pages.map((page) => [page.fileOffset, page.extents, page.bytes])).toEqual([
      [0, perPage, EXTENT_PAGE_SPAN_BYTES],
      [EXTENT_PAGE_SPAN_BYTES, perPage, EXTENT_PAGE_SPAN_BYTES],
      [2 * EXTENT_PAGE_SPAN_BYTES, 1, 4096],
    ]);
    // Only the page refs' packs enter the file node's table; the extents' packs stay in the pages.
    const wire = JSON.parse(new TextDecoder().decode(encodeNodeV2(node)));
    expect(wire.P).toEqual([SELF_PACK]);
    expect(wire.c).toBeUndefined();
    expect(wire.x).toHaveLength(3);
  });

  test('a change inside one page leaves every other page byte-identical', () => {
    // THE REASON PAGES ARE ANCHORED TO FILE OFFSETS. An index-aligned split
    // shifts every later page as soon as the extent COUNT changes, so a 64 KiB
    // write inside a 64 MiB file rewrote ten of its eleven extent pages —
    // 1.1 MB for a 64 KiB write, measured on this tree on 2026-09-02. Anchored
    // to offsets, the pages a write did not touch stay the parent's records.
    const list = extents(EXTENTS_PER_PAGE + 1);
    const before = extentPagesV2(list);
    const split = [...list];
    // One 4 KiB extent in the first page becomes two of 2 KiB: the count
    // changes, the file's bytes do not.
    split.splice(3, 1, { ...list[3], length: 2048 }, { ...list[3], length: 2048 });
    const after = extentPagesV2(split);
    expect(after.length).toBe(before.length);
    expect(after[0]).not.toEqual(before[0]);
    for (let index = 1; index < before.length; index += 1) {
      expect(after[index]).toEqual(before[index]);
    }
  });

  test('a page that stops before its span and is not full is refused', () => {
    const perPage = EXTENT_PAGE_SPAN_BYTES / 4096;
    const list = extents(EXTENTS_PER_PAGE + 1);
    // A split one extent short of the span boundary: neither reason a page may
    // end holds, so no reader can recompute this split.
    const uneven = placedPages([list.slice(0, perPage - 1), list.slice(perPage - 1)]);
    type FileNodeV2 = Extract<NodeV2, { readonly kind: 'file' }>;
    const file = (pages: ExtentPageRefV2[]): FileNodeV2 => ({
      kind: 'file',
      mode: 0o644,
      ino: 3,
      size: list.length * 4096,
      extents: { kind: 'paged', pages },
      holes: [],
    });
    expectRefused(
      () => encodeNodeV2(file(uneven.refs)),
      'invalid-parameter',
      /extent page 0 covers 2093056 bytes from 0 and holds 511 extents/u,
    );
    const misplaced = placedPages(extentPagesV2(list));
    misplaced.refs[1] = { ...misplaced.refs[1], fileOffset: misplaced.refs[1].fileOffset + 1 };
    expectRefused(() => encodeNodeV2(file(misplaced.refs)), 'invalid-parameter', /canonical file offset/u);
    const single = placedPages([list.slice(0, EXTENTS_PER_PAGE)]);
    expectRefused(() => encodeNodeV2(file(single.refs)), 'invalid-parameter', /at least two pages|only above one page/u);
    expectRefused(
      () => encodeNodeV2({ ...file([]), extents: { kind: 'inline', extents: list } }),
      'invalid-parameter',
      /1025 inline extents exceed 1024/u,
    );
    expectRefused(
      () => encodeNodeV2({ kind: 'page', extents: extents(EXTENTS_PER_PAGE + 1) }),
      'invalid-parameter',
      /holds 1 to 1024 extents, not 1025/u,
    );
    expectRefused(() => encodeNodeV2({ kind: 'page', extents: [] }), 'invalid-parameter', /not 0/u);
  });

  test('page spans must add up to the file', () => {
    const list = extents(EXTENTS_PER_PAGE + 1);
    const placed = placedPages(extentPagesV2(list));
    expectRefused(
      () => encodeNodeV2({
        kind: 'file',
        mode: 0o644,
        ino: 3,
        size: list.length * 4096 - 1,
        extents: { kind: 'paged', pages: placed.refs },
        holes: [],
      }),
      'invalid-parameter',
      /pages span/u,
    );
  });
});
