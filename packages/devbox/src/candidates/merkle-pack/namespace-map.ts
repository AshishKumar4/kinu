import { NAMESPACE_PAGE_BYTES } from '../../durability/namespace-page';
import type { ObjectRangeRef } from '../../durability/contracts';
import { sha256Hex } from '../../cas/hash';
import { MerklePackError } from './errors';
import type { PackWriter, ResolvePack, Slot } from './pack-layout';
import { SELF_PACK } from './wire';


/** The immutable page set a fence exported: this seam names no journal file. */
export interface NamespaceImage {
  readonly byteLength: number;
  readonly pages: readonly { readonly number: number; readonly sha256: string }[];
  readPage(number: number): Uint8Array;
  close(): void;
}

/** A published namespace a daemon attaches to: page by page, on demand. */
export interface NamespaceSource {
  readonly byteLength: number;
  readPage(number: number): Promise<Uint8Array>;
}

const FANOUT = 64;
const HEADER_BYTES = 8;
const ENTRY_BYTES = 78;
/** Every node is written at its full size. One update then costs the same
 *  bytes at any fill, and a change of cost marks a change of depth. */
const NODE_BYTES = HEADER_BYTES + FANOUT * ENTRY_BYTES;
const PAGE_BYTES = NAMESPACE_PAGE_BYTES;
const MAX_PAGES = 0xffff_ffff;
const MAGIC = [78, 80, 77, 1];
const HEX = /^[0-9a-f]{64}$/u;

type ReadPacked = (ref: ObjectRangeRef) => Promise<Uint8Array>;
interface DecodedNode {
  readonly level: number;
  readonly entries: ReadonlyMap<number, ObjectRangeRef>;
}
type Entry =
  | { readonly kind: 'retained'; readonly ref: ObjectRangeRef }
  | { readonly kind: 'placed'; readonly slot: Slot }
  | { readonly kind: 'node'; readonly node: MutableNode };
interface MutableNode {
  readonly level: number;
  readonly origin: ObjectRangeRef | null;
  readonly entries: Map<number, Entry>;
  dirty: boolean;
}
/** A map staged for a new generation: its root, and what it wrote. */
export interface StagedNamespaceMap {
  root(resolve: ResolvePack): ObjectRangeRef;
  readonly byteLength: number;
  readonly pagesWritten: number;
  readonly nodesWritten: number;
  /** Pages and nodes of the parent map this staging superseded: a compaction
   *  hint. A dropped branch counts its own node, not the pages beneath it. */
  readonly replaced: readonly ObjectRangeRef[];
}

function invalid(message: string): never {
  throw new MerklePackError('malformed-node', message);
}
function prefixOf(key: string): string {
  const at = key.lastIndexOf('/') + 1;
  if (at === 0 || !HEX.test(key.slice(at))) return invalid('namespace map needs content-addressed packs');
  return key.slice(0, at);
}
function location(slot: Slot, resolve: ResolvePack): ObjectRangeRef {
  return { key: resolve(slot), byteOffset: String(slot.offset), byteLength: String(slot.length), sha256: slot.sha256 };
}
/** The staged map a build hands back: its root resolves once the packs seal. */
function staged(result: Entry, work: Omit<StagedNamespaceMap, 'root'>): StagedNamespaceMap {
  return { ...work, root(resolve) {
    if (result.kind === 'node') return invalid('namespace root was not placed');
    return result.kind === 'retained' ? result.ref : location(result.slot, resolve);
  } };
}
function levelFor(count: number): number {
  let level = 0;
  while (count > FANOUT ** (level + 1)) level += 1;
  return level;
}
function decode(bytes: Uint8Array, home: ObjectRangeRef): DecodedNode {
  if (bytes.byteLength < HEADER_BYTES || !MAGIC.every((value, at) => bytes[at] === value)) return invalid('invalid namespace map header');
  const level = bytes[4];
  const count = bytes[5];
  if (level > 5 || count === 0 || count > FANOUT || bytes[6] !== 0 || bytes[7] !== 0
    || bytes.byteLength !== NODE_BYTES) return invalid('invalid namespace map geometry');
  if (bytes.subarray(HEADER_BYTES + count * ENTRY_BYTES).some((byte) => byte !== 0)) return invalid('namespace map padding is not zero');
  const prefix = prefixOf(home.key);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map<number, ObjectRangeRef>();
  let previous = -1;
  for (let at = 0; at < count; at += 1) {
    const offset = HEADER_BYTES + at * ENTRY_BYTES;
    const slot = bytes[offset];
    const external = bytes[offset + 1];
    if (slot <= previous || slot >= FANOUT || external > 1) return invalid('namespace map slots are not canonical');
    previous = slot;
    const digest = bytes.subarray(offset + 2, offset + 34);
    if (external === 0 && digest.some((byte) => byte !== 0)) return invalid('same-pack namespace reference carries a key');
    const key = external === 0 ? home.key : prefix + Buffer.from(digest).toString('hex');
    const byteOffset = view.getFloat64(offset + 34, true);
    const byteLength = view.getUint32(offset + 42, true);
    if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || Object.is(byteOffset, -0) || byteLength === 0) return invalid('invalid namespace map reference');
    if (level === 0 && byteLength !== PAGE_BYTES) return invalid('namespace leaf does not name one SQLite page');
    if (level > 0 && byteLength !== NODE_BYTES) return invalid('namespace branch reference is not one node');
    entries.set(slot, { key, byteOffset: String(byteOffset), byteLength: String(byteLength),
      sha256: Buffer.from(bytes.subarray(offset + 46, offset + ENTRY_BYTES)).toString('hex') });
  }
  return { level, entries };
}
function encode(level: number, entries: readonly (readonly [number, ObjectRangeRef])[]): Uint8Array {
  if (entries.length === 0 || entries.length > FANOUT) return invalid('namespace node has no pages or exceeds its fanout');
  const bytes = new Uint8Array(NODE_BYTES);
  bytes.set(MAGIC);
  bytes[4] = level;
  bytes[5] = entries.length;
  const view = new DataView(bytes.buffer);
  for (const [at, [slot, ref]] of entries.entries()) {
    const offset = HEADER_BYTES + at * ENTRY_BYTES;
    bytes[offset] = slot;
    if (ref.key !== SELF_PACK) {
      prefixOf(ref.key);
      bytes[offset + 1] = 1;
      bytes.set(Buffer.from(ref.key.slice(ref.key.lastIndexOf('/') + 1), 'hex'), offset + 2);
    }
    view.setFloat64(offset + 34, Number(ref.byteOffset), true);
    view.setUint32(offset + 42, Number(ref.byteLength), true);
    if (!HEX.test(ref.sha256)) return invalid('namespace reference digest is invalid');
    bytes.set(Buffer.from(ref.sha256, 'hex'), offset + 46);
  }
  return bytes;
}

/** A fixed-radix address map. SQLite page numbers need at most six levels;
 * lookup and a delta update load only their paths, never the complete map. */
export class NamespacePageMap {
  readonly #cache = new Map<string, Promise<DecodedNode>>();
  readonly #root: ObjectRangeRef | null;

  constructor(root: ObjectRangeRef | null, private readonly read: ReadPacked) {
    this.#root = root === null ? null : Object.freeze({ ...root });
  }

  async #bytes(ref: ObjectRangeRef): Promise<Uint8Array> {
    const bytes = await this.read(ref);
    if (bytes.byteLength !== Number(ref.byteLength) || sha256Hex(bytes) !== ref.sha256) {
      throw new MerklePackError('chunk-digest-mismatch', 'namespace map or page failed verification');
    }
    return bytes;
  }

  #load(ref: ObjectRangeRef): Promise<DecodedNode> {
    const key = `${ref.key}@${ref.byteOffset}+${ref.byteLength}:${ref.sha256}`;
    const held = this.#cache.get(key);
    if (held !== undefined) return held;
    const evict = (failure: Error): never => {
      this.#cache.delete(key);
      throw failure;
    };
    const loading = this.#bytes(ref).then((bytes) => decode(bytes, ref)).catch(evict);
    this.#cache.set(key, loading);
    return loading;
  }

  async lookup(number: number): Promise<ObjectRangeRef | null> {
    if (!Number.isSafeInteger(number) || number < 1 || number > MAX_PAGES) return invalid('invalid SQLite page number');
    if (this.#root === null) return null;
    const index = number - 1;
    let node = await this.#load(this.#root);
    if (index >= FANOUT ** (node.level + 1)) return null;
    for (;;) {
      const slot = Math.floor(index / FANOUT ** node.level) % FANOUT;
      const ref = node.entries.get(slot);
      if (ref === undefined) return null;
      if (node.level === 0) return ref;
      const child = await this.#load(ref);
      if (child.level !== node.level - 1) return invalid('namespace map child level changed');
      node = child;
    }
  }

  async readPage(number: number): Promise<Uint8Array> {
    const ref = await this.lookup(number);
    if (ref === null) throw new MerklePackError('no-entry', `namespace has no page ${number}`);
    return await this.#bytes(ref);
  }

  /** Copy every page and node held in a candidate pack, keeping the rest by
   *  reference: what a compaction owes the namespace. */
  async relocate(writer: PackWriter, candidates: ReadonlySet<string>, byteLength: number): Promise<StagedNamespaceMap> {
    if (this.#root === null) return invalid('a compaction cannot relocate an absent namespace');
    let pagesWritten = 0;
    let nodesWritten = 0;
    const replaced: ObjectRangeRef[] = [];
    const movePage = async (ref: ObjectRangeRef): Promise<Entry> => {
      if (!candidates.has(ref.key)) return { kind: 'retained', ref };
      pagesWritten += 1;
      replaced.push(ref);
      return { kind: 'placed', slot: writer.place(await this.#bytes(ref)) };
    };
    // `ref` names a node of `level`; a level-0 node's entries are pages.
    const move = async (ref: ObjectRangeRef, level: number): Promise<Entry> => {
      const node = await this.#load(ref);
      if (node.level !== level) return invalid('namespace map child level changed');
      const entries: (readonly [number, Entry])[] = [];
      let moved = candidates.has(ref.key);
      for (const [slot, child] of [...node.entries].sort(([a], [b]) => a - b)) {
        const entry = level === 0 ? await movePage(child) : await move(child, level - 1);
        if (entry.kind !== 'retained') moved = true;
        entries.push([slot, entry]);
      }
      if (!moved) return { kind: 'retained', ref };
      nodesWritten += 1;
      replaced.push(ref);
      return { kind: 'placed', slot: writer.placeRecord((resolve) => encode(level, entries.map(([slot, entry]) => {
        if (entry.kind === 'node') return invalid('namespace branch was not placed');
        return [slot, entry.kind === 'retained' ? entry.ref : location(entry.slot, resolve)] as const;
      }))) };
    };
    const rootLevel = (await this.#load(this.#root)).level;
    const result = await move(this.#root, rootLevel);
    return staged(result, { pagesWritten, nodesWritten, replaced, byteLength });
  }

  async stage(writer: PackWriter, image: NamespaceImage): Promise<StagedNamespaceMap> {
    const pageCount = image.byteLength / PAGE_BYTES;
    if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGES) return invalid('invalid namespace image size');
    if (this.#root === null && (image.pages.length !== pageCount
      || image.pages.some((page, at) => page.number !== at + 1))) return invalid('initial namespace image is incomplete');
    let pagesWritten = 0;
    let nodesWritten = 0;
    const replaced: ObjectRangeRef[] = [];
    const supersede = (entry: Entry | undefined): void => {
      if (entry?.kind === 'retained') replaced.push(entry.ref);
      else if (entry?.kind === 'node' && entry.node.origin !== null) replaced.push(entry.node.origin);
    };
    const mutable = async (entry: Entry | undefined, level: number): Promise<MutableNode> => {
      if (entry === undefined) return { level, origin: null, entries: new Map(), dirty: true };
      if (entry.kind === 'node') return entry.node;
      if (entry.kind === 'placed') return invalid('namespace data page used as a branch');
      const node = await this.#load(entry.ref);
      if (node.level !== level) return invalid('namespace map child level changed');
      return { level, origin: entry.ref,
        entries: new Map([...node.entries].map(([slot, ref]): [number, Entry] => [slot, { kind: 'retained', ref }])), dirty: false };
    };
    const desired = levelFor(pageCount);
    let root = this.#root === null
      ? await mutable(undefined, desired)
      : await mutable({ kind: 'retained', ref: this.#root }, (await this.#load(this.#root)).level);
    while (root.level < desired) {
      root = { level: root.level + 1, origin: null, entries: new Map([[0, { kind: 'node', node: root }]]), dirty: true };
    }
    const trim = async (node: MutableNode, start: number): Promise<void> => {
      for (const [slot, entry] of node.entries) {
        const first = start + slot * FANOUT ** node.level;
        if (first >= pageCount) { supersede(entry); node.entries.delete(slot); node.dirty = true; continue; }
        if (node.level > 0 && first + FANOUT ** node.level > pageCount) {
          const child = await mutable(entry, node.level - 1);
          await trim(child, first);
          if (child.dirty) { node.entries.set(slot, { kind: 'node', node: child }); node.dirty = true; }
        }
      }
    };
    await trim(root, 0);
    while (root.level > desired) {
      if (root.origin !== null) replaced.push(root.origin);
      root = await mutable(root.entries.get(0), root.level - 1);
    }
    const update = async (node: MutableNode, number: number, sha256: string): Promise<boolean> => {
      const index = number - 1;
      const slot = Math.floor(index / FANOUT ** node.level) % FANOUT;
      const held = node.entries.get(slot);
      if (node.level === 0) {
        if (held?.kind === 'retained' && held.ref.sha256 === sha256) return false;
        supersede(held);
        const bytes = image.readPage(number);
        if (bytes.byteLength !== PAGE_BYTES || sha256Hex(bytes) !== sha256) return invalid('staged namespace page failed verification');
        node.entries.set(slot, { kind: 'placed', slot: writer.place(bytes) });
        pagesWritten += 1;
      } else {
        const child = await mutable(held, node.level - 1);
        if (!await update(child, number, sha256)) return false;
        node.entries.set(slot, { kind: 'node', node: child });
      }
      node.dirty = true;
      return true;
    };
    for (const page of image.pages) {
      if (page.number < 1 || page.number > pageCount) return invalid('namespace delta page is outside its image');
      await update(root, page.number, page.sha256);
    }
    const write = (node: MutableNode): Entry => {
      if (!node.dirty && node.origin !== null) return { kind: 'retained', ref: node.origin };
      const entries = [...node.entries].sort(([a], [b]) => a - b).map(([slot, entry]): [number, Entry] =>
        [slot, entry.kind === 'node' ? write(entry.node) : entry]);
      const placed = writer.placeRecord((resolve) => encode(node.level, entries.map(([slot, entry]): [number, ObjectRangeRef] => {
        if (entry.kind === 'node') return invalid('namespace branch was not placed');
        return [slot, entry.kind === 'retained' ? entry.ref : location(entry.slot, resolve)];
      })));
      nodesWritten += 1;
      if (node.origin !== null) replaced.push(node.origin);
      return { kind: 'placed', slot: placed };
    };
    const result = write(root);
    return staged(result, { pagesWritten, nodesWritten, replaced, byteLength: image.byteLength });
  }
}
