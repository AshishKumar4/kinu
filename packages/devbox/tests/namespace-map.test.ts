import { describe, expect, test } from 'bun:test';
import { sha256Hex } from '../src/cas/hash';
import { NamespacePageMap } from '../src/candidates/merkle-pack/namespace-map';
import type { NamespaceImage } from '../src/candidates/merkle-pack/namespace-map';
import { PackWriter } from '../src/candidates/merkle-pack/pack-layout';
import type { ObjectRangeRef } from '../src/durability/contracts';
import { NAMESPACE_PAGE_BYTES } from '../src/durability/namespace-page';

const PAGE = NAMESPACE_PAGE_BYTES;

class CountedPacks {
  readonly objects = new Map<string, Uint8Array>();
  reads = 0;
  bytes = 0;

  absorb(writer: PackWriter): void {
    writer.finish();
    for (const pack of writer.packs) this.objects.set(pack.ref.key, pack.bytes);
  }

  read = async (ref: ObjectRangeRef): Promise<Uint8Array> => {
    const pack = this.objects.get(ref.key);
    if (pack === undefined) throw new Error(`missing ${ref.key}`);
    this.reads += 1;
    this.bytes += Number(ref.byteLength);
    return pack.slice(Number(ref.byteOffset), Number(ref.byteOffset) + Number(ref.byteLength));
  };
}

function page(number: number, version: number): Uint8Array {
  const bytes = new Uint8Array(PAGE);
  for (let at = 0; at < PAGE; at += 1) bytes[at] = (number * 31 + version * 7 + at) & 0xff;
  return bytes;
}
function image(pageCount: number, changed: readonly number[], version: number): NamespaceImage {
  return {
    byteLength: pageCount * PAGE,
    pages: changed.map((number) => ({ number, sha256: sha256Hex(page(number, version)) })),
    readPage: (number) => page(number, version),
    close: () => {},
  };
}

async function publish(map: NamespacePageMap, packs: CountedPacks, next: NamespaceImage) {
  const writer = new PackWriter(256 * 1024);
  const staged = await map.stage(writer, next);
  packs.absorb(writer);
  return { root: staged.root((slot) => writer.keyOf(slot)), staged };
}

describe('the namespace page map', () => {
  test('one page update at 300,000 pages rewrites one path and one lookup reads one path', async () => {
    const packs = new CountedPacks();
    const pageCount = 300_000;
    const all = Array.from({ length: pageCount }, (_, at) => at + 1);
    const initial = await publish(new NamespacePageMap(null, packs.read), packs, image(pageCount, all, 1));
    const changed = await publish(new NamespacePageMap(initial.root, packs.read), packs, image(pageCount, [123_457], 2));
    expect(changed.staged.pagesWritten).toBe(1);
    expect(changed.staged.nodesWritten).toBe(4);
    const cold = new NamespacePageMap(changed.root, packs.read);
    const before = { reads: packs.reads, bytes: packs.bytes };
    expect(await cold.readPage(123_457)).toEqual(page(123_457, 2));
    const firstRead = { reads: packs.reads - before.reads, bytes: packs.bytes - before.bytes };
    // Four map levels for 300,000 pages, then the page itself.
    expect(firstRead.reads).toBe(5);
    expect(firstRead.bytes).toBe(PAGE + 4 * 5000);
    expect(await cold.readPage(5)).toEqual(page(5, 1));
    // The root and the shared second level are cached; two lower levels plus the page remain.
    expect(packs.reads - before.reads - firstRead.reads).toBe(3);
    expect(await cold.lookup(pageCount + 1)).toBeNull();
  }, 60_000);

  test('a shrunken image drops pages beyond its new length', async () => {
    const packs = new CountedPacks();
    const initial = await publish(new NamespacePageMap(null, packs.read), packs, image(130, Array.from({ length: 130 }, (_, at) => at + 1), 1));
    const shrunk = await publish(new NamespacePageMap(initial.root, packs.read), packs, image(60, [60], 3));
    const map = new NamespacePageMap(shrunk.root, packs.read);
    expect(await map.readPage(60)).toEqual(page(60, 3));
    expect(await map.readPage(59)).toEqual(page(59, 1));
    expect(await map.lookup(61)).toBeNull();
    expect(await map.lookup(130)).toBeNull();
  });

  test('a corrupted page or reference is refused by name', async () => {
    const packs = new CountedPacks();
    const initial = await publish(new NamespacePageMap(null, packs.read), packs, image(3, [1, 2, 3], 1));
    const map = new NamespacePageMap(initial.root, packs.read);
    const pack = packs.objects.get(initial.root.key);
    if (pack === undefined) throw new Error('missing root pack');
    pack[0] ^= 1;
    await expect(map.readPage(1)).rejects.toThrow(/failed verification/u);
  });

  test('relocation copies every page and node held in a candidate pack and keeps the rest by reference', async () => {
    const packs = new CountedPacks();
    const all = Array.from({ length: 5000 }, (_, at) => at + 1);
    const initial = await publish(new NamespacePageMap(null, packs.read), packs, image(5000, all, 1));
    const initialPacks = [...packs.objects.keys()];
    const changed = await publish(new NamespacePageMap(initial.root, packs.read), packs, image(5000, [7, 4999], 2));
    // Retire the first pack of the initial image and the pack its root node
    // lives in: their pages and nodes must move; everything else stays.
    const candidates = new Set([initialPacks[0] ?? '', initial.root.key]);
    const writer = new PackWriter(256 * 1024);
    const moved = await new NamespacePageMap(changed.root, packs.read).relocate(writer, candidates, 5000 * PAGE);
    packs.absorb(writer);
    const root = moved.root((slot) => writer.keyOf(slot));
    for (const key of candidates) packs.objects.delete(key);
    const map = new NamespacePageMap(root, packs.read);
    expect(await map.readPage(7)).toEqual(page(7, 2));
    expect(await map.readPage(4999)).toEqual(page(4999, 2));
    expect(await map.readPage(1)).toEqual(page(1, 1));
    expect(await map.readPage(5000)).toEqual(page(5000, 1));
    expect(moved.pagesWritten).toBeGreaterThan(0);
    expect(moved.pagesWritten).toBeLessThan(5000);
  }, 60_000);
});
