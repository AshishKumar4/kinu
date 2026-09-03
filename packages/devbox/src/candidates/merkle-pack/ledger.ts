/**
 * The pack ledger: liveness, retirement, compaction and deletion, in one
 * place, because a wrong answer in any of them deletes bytes a head reaches.
 *
 * WHY A LEDGER AND NOT A CLOSURE. A v1 generation published the full closure
 * of its head and verified it object by object, at every publish and again at
 * every attach — O(#objects) remote operations for a fact that never changes.
 * The ledger is the other shape of the same knowledge: one row per LIVE pack,
 * O(#packs) rather than O(#objects), written once per publish and read only by
 * compaction and GC. Nothing on the read or attach path touches it.
 *
 * WHY LIVENESS IS INCREMENTAL. When a seal replaces an extent, the pack that
 * held the old chunk loses those bytes; that is O(k) bookkeeping the build
 * already has in hand. It is deliberately PESSIMISTIC — a chunk still reached
 * through another file may be counted dead — because the error direction only
 * ever delays a compaction, and the audit mark re-derives the counts from the
 * node records it walks. The opposite error would delete live bytes.
 *
 * WHY RETIRE-THEN-DELETE. A container that was told an object exists may still
 * be reading it, so a pack leaves the ledger first and is deleted only after a
 * grace window. Deletion is always by ledger, never by listing a prefix.
 */

import * as v from 'valibot';

import { sha256Hex } from '../../cas/hash';
import { PackLedgerSchema } from '../../durability/contracts';
import type { ImmutableObjectRef, PackLedger, PackLedgerRow } from '../../durability/contracts';

import { MerklePackError } from './errors';

const utf8 = new TextEncoder();

/** A ledger is an ordinary immutable object, addressed by its own digest. */
export function ledgerKeyV2(digest: string): string {
  return `v2/merkle-pack/ledger/${digest}`;
}

/** Canonical ledger bytes: stable JSON plus a newline, as envelopes are. */
export function packLedgerBytes(ledger: PackLedger): Uint8Array {
  return utf8.encode(`${JSON.stringify(v.parse(PackLedgerSchema, ledger))}\n`);
}

export interface PackLedgerRef {
  readonly ref: ImmutableObjectRef;
  readonly bytes: Uint8Array;
}

export function packLedgerRef(ledger: PackLedger): PackLedgerRef {
  const bytes = packLedgerBytes(ledger);
  const digest = sha256Hex(bytes);
  return {
    ref: { key: ledgerKeyV2(digest), byteLength: String(bytes.byteLength), sha256: digest },
    bytes,
  };
}

/** Read a ledger back. A non-canonical body is refused even when it parses. */
export function parsePackLedger(bytes: Uint8Array): PackLedger {
  let ledger: PackLedger;
  try {
    ledger = v.parse(PackLedgerSchema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MerklePackError('invalid-parameter', `pack ledger did not decode: ${detail}`, { cause: error });
  }
  const canonical = packLedgerBytes(ledger);
  if (canonical.byteLength !== bytes.byteLength || !canonical.every((byte, at) => byte === bytes[at])) {
    throw new MerklePackError('invalid-parameter', 'pack ledger body is not canonical');
  }
  return ledger;
}

export interface NextLedgerInput {
  readonly parent: PackLedger | null;
  readonly format: PackLedger['format'];
  readonly boxId: string;
  readonly generation: string;
  /** The packs this generation PUT, in packing order. */
  readonly added: readonly ImmutableObjectRef[];
  /** Bytes this generation stopped reaching, by the pack that holds them. */
  readonly deadBytes: ReadonlyMap<string, number>;
  /** Packs a compaction rewrote, which are retired whatever their live count. */
  readonly compacted?: readonly string[];
}

export interface NextLedger {
  readonly ledger: PackLedger;
  /** Pack keys this generation stops needing, sorted, ready for the envelope. */
  readonly retired: readonly string[];
}

/**
 * The ledger after one publish: every parent row minus the bytes this
 * generation killed, without the packs that reached zero live bytes or were
 * compacted away, plus one row per pack it added.
 */
export function nextPackLedger(input: NextLedgerInput): NextLedger {
  const compacted = new Set(input.compacted ?? []);
  const rows: PackLedgerRow[] = [];
  const retired: string[] = [];
  for (const row of input.parent?.packs ?? []) {
    const dead = input.deadBytes.get(row.key) ?? 0;
    const live = Math.max(0, Number(row.liveBytes) - dead);
    if (live === 0 || compacted.has(row.key)) {
      retired.push(row.key);
      continue;
    }
    rows.push({ ...row, liveBytes: String(live) });
  }
  for (const ref of input.added) {
    rows.push({
      key: ref.key,
      byteLength: ref.byteLength,
      sha256: ref.sha256,
      liveBytes: ref.byteLength,
      addedInGeneration: input.generation,
    });
  }
  const ledger = v.parse(PackLedgerSchema, {
    version: 1,
    format: input.format,
    boxId: input.boxId,
    generation: input.generation,
    packs: rows,
  });
  return { ledger, retired: [...retired].sort() };
}

/**
 * A pack is compacted only when more than half its bytes are dead, or when it
 * is small and old enough that the seal cadence left it behind. That is what
 * bounds rewrite amplification: a byte is only ever moved when the pack around
 * it is more than half waste, so the total bytes a workload rewrites stay a
 * constant multiple of the bytes it wrote.
 */
export const COMPACTION_DEAD_FRACTION = 0.5;
export const COMPACTION_SMALL_PACK_BYTES = 1024 * 1024;
export const COMPACTION_SMALL_PACK_GENERATIONS = 64n;

export function compactionCandidates(ledger: PackLedger, generation: string): readonly PackLedgerRow[] {
  const now = BigInt(generation);
  return ledger.packs.filter((row) => {
    const size = Number(row.byteLength);
    const live = Number(row.liveBytes);
    if (size === 0) return false;
    if (live < size * COMPACTION_DEAD_FRACTION) return true;
    return size < COMPACTION_SMALL_PACK_BYTES
      && now - BigInt(row.addedInGeneration) > COMPACTION_SMALL_PACK_GENERATIONS;
  });
}

/** One pack that left the ledger, and when it did. */
export interface RetiredPack {
  readonly key: string;
  readonly generation: string;
  readonly retiredAtMs: number;
}

/**
 * Which retired packs may be deleted now: those whose grace window has
 * elapsed. The window is twice the attach budget, so a container that was
 * told an object exists has already finished attaching before it goes.
 */
export function deletableRetiredPacks(
  retired: readonly RetiredPack[],
  nowMs: number,
  graceMs: number,
): readonly string[] {
  return retired.filter((pack) => nowMs - pack.retiredAtMs >= graceMs).map((pack) => pack.key);
}
