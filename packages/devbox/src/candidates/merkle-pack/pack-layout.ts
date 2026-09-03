/**
 * Filling packs: where a record lands, and how it names what it points at.
 *
 * WHY THIS IS ITS OWN MODULE. Two paths write packs — the incremental build
 * and compaction — and they must lay records out the same way or a reader
 * would meet two spellings of one tree. The rule they share lives here:
 * records are appended in placement order under a hard cap, a reference into
 * the pack a record is being written into is spelled `SELF_PACK`, and every
 * other reference names a pack that is already sealed and therefore keyed.
 *
 * WHY `SELF_PACK` EXISTS AT ALL. A pack's key is the digest of its bytes, so
 * it is not known until the pack is complete — and a record inside it cannot
 * wait for that to name its own pack. Placement order therefore puts every
 * referenced record BEFORE the record that names it (fresh chunks in file
 * order, then extent pages, then file nodes, then directories postorder with
 * the root last), which makes an in-pack reference an offset and nothing else.
 */

import { sha256Hex } from '../../cas/hash';
import type { ImmutableObjectRef } from '../../durability/contracts';

import { MerklePackError } from './errors';
import { SELF_PACK, packKeyV2 } from './wire';

/** One pack a generation PUTs: its content address and its bytes. */
export interface BuiltPack {
  readonly ref: ImmutableObjectRef;
  readonly bytes: Uint8Array;
}

/** Where one placed record sits, before its pack has a name. */
export interface Slot {
  readonly pack: number;
  readonly offset: number;
  readonly length: number;
  readonly sha256: string;
}

/** Resolves a placed record to the pack name the record being written uses. */
export type ResolvePack = (slot: Slot) => string;

export class PackWriter {
  readonly #cap: number;
  readonly #packs: BuiltPack[] = [];
  readonly #keys: string[] = [];
  #current: Uint8Array[] = [];
  #length = 0;

  constructor(cap: number) {
    if (!Number.isSafeInteger(cap) || cap < 1024) {
      throw new MerklePackError('invalid-parameter', `a pack cap must be at least 1024 bytes, got ${cap}`);
    }
    this.#cap = cap;
  }

  get packs(): readonly BuiltPack[] {
    return this.#packs;
  }

  #resolver(pack: number): ResolvePack {
    return (slot) => {
      if (slot.pack === pack) return SELF_PACK;
      const key = this.#keys[slot.pack];
      if (key === undefined) {
        throw new MerklePackError('invalid-parameter', `a record references pack ${slot.pack}, which is not sealed`);
      }
      return key;
    };
  }

  #seal(): void {
    if (this.#current.length === 0) return;
    const bytes = new Uint8Array(this.#length);
    let offset = 0;
    for (const part of this.#current) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    const digest = sha256Hex(bytes);
    this.#keys.push(packKeyV2(digest));
    this.#packs.push({
      ref: { key: packKeyV2(digest), byteLength: String(bytes.byteLength), sha256: digest },
      bytes,
    });
    this.#current = [];
    this.#length = 0;
  }

  #push(bytes: Uint8Array): Slot {
    if (bytes.byteLength > this.#cap) {
      throw new MerklePackError(
        'invalid-parameter',
        `a ${bytes.byteLength}-byte record exceeds the ${this.#cap}-byte pack cap; shard the record`,
      );
    }
    const slot: Slot = {
      pack: this.#packs.length,
      offset: this.#length,
      length: bytes.byteLength,
      sha256: sha256Hex(bytes),
    };
    this.#current.push(bytes);
    this.#length += bytes.byteLength;
    return slot;
  }

  /** Place bytes that do not depend on where they land: a chunk. */
  place(bytes: Uint8Array): Slot {
    if (this.#length > 0 && this.#length + bytes.byteLength > this.#cap) this.#seal();
    return this.#push(bytes);
  }

  /**
   * Place a record whose bytes depend on where it lands. The first attempt is
   * serialized against the open pack; if it does not fit, the pack is sealed
   * and the record is serialized again, because its same-pack references have
   * become cross-pack ones and the bytes really do differ.
   */
  placeRecord(build: (resolve: ResolvePack) => Uint8Array): Slot {
    const attempt = build(this.#resolver(this.#packs.length));
    if (this.#length === 0 || this.#length + attempt.byteLength <= this.#cap) return this.#push(attempt);
    this.#seal();
    return this.#push(build(this.#resolver(this.#packs.length)));
  }

  finish(): void {
    this.#seal();
  }

  /** The immutable key of a sealed pack, for a ref that leaves this build. */
  keyOf(slot: Slot): string {
    const key = this.#keys[slot.pack];
    if (key === undefined) throw new MerklePackError('invalid-parameter', 'pack was not sealed before it was named');
    return key;
  }
}
