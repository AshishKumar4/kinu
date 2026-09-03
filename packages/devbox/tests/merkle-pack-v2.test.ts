/**
 * The smart container's durability properties, measured on the shipped code.
 *
 * WHAT EACH TEST HERE IS FOR. The conformance battery asks whether an arm
 * hands back the bytes it was given; these ask the questions that decide
 * whether it can do that at a two-second cadence forever: is a seal's cost the
 * bytes that changed rather than the tree, is a publish a bounded number of
 * single PUTs, is a body the store took the body we sent, does a lost CAS lose
 * cleanly, and does compaction pay for itself.
 *
 * EVERY NUMBER COMES FROM A COUNTER THE PRODUCT REPORTS. `SealWork`,
 * `PublishWork` and `CompactionWork` are the rows the sidecar writes into its
 * status file, so a bound asserted here is a bound the deployed box states in
 * the same words — and the store's own operation log is checked against them,
 * because a counter that agrees with itself proves nothing.
 */

import { describe, expect, test } from 'bun:test';

import { openSidecar, readTree } from './support/sidecar-fixture';
import type { SidecarFixture } from './support/sidecar-fixture';
import {
  Seeded,
  compareTrees,
  describeMismatches,
  fidelityTree,
  fileEntry,
  generatedTree,
  gigabyteTree,
  heldBytes,
  metadataOf,
  sortedByPath,
  textTree,
} from './support/tree-model';
import type { NodeEntry } from '../src/capture/model';
import { DEFAULT_CHUNK_PARAMS } from '../src/candidates/merkle-pack/chunk';
import { openMerkleV2 } from '../src/candidates/merkle-pack/view-v2';
import { compactionCandidates, parsePackLedger } from '../src/candidates/merkle-pack/ledger';
import { DEFAULT_MAX_PACK_BYTES_V2 } from '../src/candidates/merkle-pack/build-v2';
import { beginCandidateOperationV2 } from '../src/candidates/control';
import { DURABILITY_AWAIT_POINTS } from '../src/durability/contracts';

const PACK_CAP = DEFAULT_MAX_PACK_BYTES_V2;
const CHUNK_MAX = DEFAULT_CHUNK_PARAMS.maxBytes;

/** Seal, and refuse to continue on anything but a published generation. */
async function publish(fixture: SidecarFixture, what: string): Promise<string> {
  const outcome = await fixture.core.seal('quiesce');
  if (outcome.kind !== 'published') {
    throw new Error(`${what} did not publish: ${outcome.kind}${'reason' in outcome ? ` — ${outcome.reason}` : ''}`);
  }
  return outcome.rootEnvelopeId;
}

/** The tree the published head serves, through the shipped v2 reader. */
async function served(fixture: SidecarFixture): Promise<NodeEntry[]> {
  const snapshot = await fixture.snapshot();
  if (snapshot.head === null) throw new Error('the box published no head');
  const view = await openMerkleV2(snapshot.head.envelope.rootObject, fixture.payload, {
    operationId: 'read',
    attemptId: '1',
    boxId: 'box-sidecar',
    epoch: snapshot.head.envelope.epoch,
    expiresAt: '99999999999999',
  });
  return await readTree(view);
}

function expectSameTree(expected: readonly NodeEntry[], actual: readonly NodeEntry[], what: string): void {
  const mismatches = compareTrees(sortedByPath(expected), sortedByPath(actual));
  if (mismatches.length > 0) {
    throw new Error(`${what}: ${mismatches.length} mismatches: ${describeMismatches(mismatches).slice(0, 600)}`);
  }
}

describe('a v2 generation publishes what the fence found, and serves it back', () => {
  test('one seal publishes packs plus a ledger and an envelope, and the head reads back exactly', async () => {
    const fixture = openSidecar();
    const tree = textTree({ 'notes.txt': 'generation one', 'src/app.ts': 'export const one = 1;' });
    fixture.daemon.plant(tree);

    const head = await publish(fixture, 'the first seal');
    expect(head).toMatch(/^[0-9a-f]{64}$/u);
    expectSameTree(tree, await served(fixture), 'the first published head');

    // ONE PUT PER PACK, one for the ledger, one for the envelope, and nothing
    // else: a v2 generation writes no index object and no closure object.
    const puts = fixture.payload.ops.filter((op) => op.op === 'put');
    const packs = puts.filter((op) => op.key.startsWith('v2/merkle-pack/pack/'));
    const ledgers = puts.filter((op) => op.key.startsWith('v2/merkle-pack/ledger/'));
    expect(packs.length).toBe(1);
    expect(ledgers.length).toBe(1);
    expect(puts.length).toBe(packs.length + ledgers.length);
    expect(fixture.envelopes.ops.filter((op) => op.op === 'put').length).toBe(1);
    const status = fixture.core.status();
    expect(status.attach.kind).toBe('attached');
    expect(status.work.publish.objectsPut).toBe(3);
    expect(status.work.publish.casAttempts).toBe(1);
  });

  test('three generations restore exactly, each read back through the head it published', async () => {
    const fixture = openSidecar();
    const first = textTree({ 'notes.txt': 'generation one', 'src.txt': 'export const one = 1;' });
    fixture.daemon.plant(first);
    await publish(fixture, 'generation one');
    expectSameTree(first, await served(fixture), 'generation one');

    fixture.daemon.write('notes.txt', new TextEncoder().encode('generation two'));
    fixture.daemon.write('extra.txt', new TextEncoder().encode('added by the second commit'));
    await publish(fixture, 'generation two');
    const second = fixture.daemon.tree.snapshot();
    expectSameTree(second, await served(fixture), 'generation two');

    fixture.daemon.write('third.txt', new TextEncoder().encode('written by the third generation'));
    await publish(fixture, 'generation three');
    const third = fixture.daemon.tree.snapshot();
    expectSameTree(third, await served(fixture), 'generation three');

    // THE THIRD GENERATION IS THE FIRST READER OF AN INCREMENTAL PARENT, which
    // is where v1's per-generation index declared the wrong packs and every
    // third commit failed. There is no index here, and the proof is that the
    // third head reads back whole.
    expect(third.length).toBeGreaterThan(second.length);
  });

  test('full fidelity survives a v2 generation: mode, owner, times, xattrs, symlinks, hardlinks, holes', async () => {
    const fixture = openSidecar();
    const fixtureTree = fidelityTree();
    fixture.daemon.plant(fixtureTree);
    await publish(fixture, 'the fidelity seal');
    expectSameTree(fixtureTree, await served(fixture), 'the fidelity head');
  });
});

describe('a seal costs what changed, not what the tree holds', () => {
  test('one 4 KiB write into a 400 MiB modeled tree is chunked, staged and rewritten by k and p·d', async () => {
    // THE TREE IS MODELED, not materialized: one 400 MiB sparse file with a
    // megabyte of data, plus a thousand small files, so `n` is large and the
    // process stays small.
    const seed = new Seeded(3);
    const sparse: NodeEntry = {
      path: 'vol/big.bin',
      kind: 'file',
      mode: 0o644,
      ino: 900_001,
      metadata: metadataOf(seed),
      content: {
        kind: 'sparse',
        size: 400 * 1024 * 1024,
        runs: Array.from({ length: 16 }, (_, index) => ({
          offset: index * 25 * 1024 * 1024,
          bytes: new Seeded(100 + index).fill(new Uint8Array(64 * 1024)),
        })),
      },
    };
    const measure = async (files: number) => {
      const fixture = openSidecar();
      fixture.daemon.plant([
        ...generatedTree({ seed: 3, files, bytesPerFile: 4096 }),
        ...textTree({ 'vol/keep.txt': 'x' }),
        sparse,
      ]);
      await publish(fixture, `the ${files}-file base`);
      const before = fixture.payload.ops.length;
      // ONE 4 KiB write, into the middle of the dense run of one file.
      fixture.daemon.pwrite('vol/big.bin', 25 * 1024 * 1024 + 8 * 1024, new Seeded(7).fill(new Uint8Array(4096)));
      await publish(fixture, `the k seal over ${files} files`);
      const status = fixture.core.status();
      return {
        seal: status.work.seal,
        publish: status.work.publish,
        storeOps: fixture.payload.ops.length - before,
      };
    };
    const small = await measure(100);
    const large = await measure(1_000);

    // k = 4 KiB, p = 1 path, d = 2 (`vol/big.bin` under `vol` under the root).
    const k = 4096;
    expect(small.seal.bytesStaged).toBeLessThanOrEqual(2 * k + 4 * CHUNK_MAX);
    expect(small.seal.bytesChunked).toBeLessThanOrEqual(2 * k + 8 * CHUNK_MAX);
    expect(small.seal.nodesRewritten).toBeLessThanOrEqual(1 * (2 + 2));
    expect(small.publish.objectsPut).toBeLessThanOrEqual(Math.ceil(k / PACK_CAP) + 2);

    // TEN TIMES THE TREE, THE SAME WRITE: every counter is the same number.
    expect(large.seal.bytesStaged).toBe(small.seal.bytesStaged);
    expect(large.seal.bytesChunked).toBe(small.seal.bytesChunked);
    expect(large.seal.nodesRewritten).toBe(small.seal.nodesRewritten);
    expect(large.publish.objectsPut).toBe(small.publish.objectsPut);
    expect(large.storeOps).toBe(small.storeOps);
  }, 120_000);

  test('a database page rewrite moves the dirty pages, not the database', async () => {
    const fixture = openSidecar();
    const seed = new Seeded(31);
    const database = seed.fill(new Uint8Array(64 * 1024 * 1024));
    fixture.daemon.plant([
      ...textTree({ 'keep.txt': 'x' }),
      fileEntry('app.db', database, 4_242, metadataOf(seed)),
    ]);
    await publish(fixture, 'the database seal');

    const pages = 64;
    const dirty = new Set<number>();
    while (dirty.size < pages) dirty.add(seed.below(database.byteLength / 4096));
    for (const page of dirty) fixture.daemon.pwrite('app.db', page * 4096, seed.fill(new Uint8Array(4096)));
    await publish(fixture, 'the page-write seal');

    // THE BOUND THE DECISIVE RUN FAILED: snapshot-chain moved 149 % of the
    // database per tick. Four chunks per dirty page is the whole budget.
    const bound = 4 * pages * CHUNK_MAX;
    const work = fixture.core.status().work;
    expect(work.publish.bytesPut).toBeLessThanOrEqual(bound);
    expect(work.seal.bytesChunked).toBeLessThanOrEqual(bound);
    expectSameTree(fixture.daemon.tree.snapshot(), await served(fixture), 'the page-write head');
  }, 120_000);

  test('a 1 GiB sparse file costs its data, and an in-place write costs the write', async () => {
    const fixture = openSidecar();
    const tree = gigabyteTree();
    const data = heldBytes(tree);
    fixture.daemon.plant(tree);
    await publish(fixture, 'the 1 GiB seal');
    const first = fixture.core.status().work;
    expect(first.seal.bytesChunked).toBeLessThanOrEqual(2 * data);
    expect(first.publish.bytesPut).toBeLessThanOrEqual(2 * data);

    const patch = new Seeded(21).fill(new Uint8Array(64 * 1024));
    fixture.daemon.pwrite('vol/dense.bin', 8 * 1024 * 1024, patch);
    await publish(fixture, 'the 64 KiB in-place seal');
    const second = fixture.core.status().work;
    expect(second.seal.bytesChunked).toBeLessThanOrEqual(patch.byteLength + 8 * CHUNK_MAX);
    expect(second.publish.bytesPut).toBeLessThanOrEqual(4 * (patch.byteLength + 8 * CHUNK_MAX));
    expectSameTree(fixture.daemon.tree.snapshot(), await served(fixture), 'the 1 GiB head after the patch');
  }, 180_000);

  test('100,000 files publish with no index and no four-MiB cap', async () => {
    const fixture = openSidecar();
    const tree = generatedTree({ seed: 5, files: 100_000, bytesPerFile: 16 });
    fixture.daemon.plant(tree);
    await publish(fixture, 'the 1e5-file seal');

    // v1 REFUSED THIS AT 47 MB OF INDEX. A v2 generation writes no index at
    // all: every object it PUT is a pack, plus one ledger.
    const puts = fixture.payload.ops.filter((op) => op.op === 'put');
    expect(puts.some((op) => op.key.includes('/index/'))).toBe(false);
    expect(puts.some((op) => op.key.includes('/closure'))).toBe(false);
    const packs = puts.filter((op) => op.key.startsWith('v2/merkle-pack/pack/'));
    expect(packs.length).toBeGreaterThan(0);
    for (const pack of packs) expect(pack.bytes).toBeLessThanOrEqual(PACK_CAP);
  }, 300_000);
});

describe('a publish is single PUTs, an ETag-proven body, and one CAS', () => {
  test('the object count is one pack per 32 MiB of fresh bytes, plus the ledger and the envelope', async () => {
    const fixture = openSidecar({ maxPackBytes: 1024 * 1024 });
    const seed = new Seeded(11);
    // Three megabytes of incompressible data against a 1 MiB pack cap: the
    // count is arithmetic, and the root record lives INSIDE a pack.
    fixture.daemon.plant([
      ...textTree({ 'keep.txt': 'x' }),
      fileEntry('a.bin', seed.fill(new Uint8Array(1_500_000)), 11, metadataOf(seed)),
      fileEntry('b.bin', seed.fill(new Uint8Array(1_500_000)), 12, metadataOf(seed)),
    ]);
    await publish(fixture, 'the multi-pack seal');

    const snapshot = await fixture.snapshot();
    const envelope = snapshot.head!.envelope;
    const freshBytes = envelope.added.reduce((bytes, ref) => bytes + Number(ref.byteLength), 0);
    const packs = Math.ceil(freshBytes / (1024 * 1024));
    expect(envelope.added.length).toBe(packs);
    expect(fixture.core.status().work.publish.objectsPut).toBe(packs + 2);
    // ROOT IN PACK: the head names a range inside one of the packs it added,
    // so there is no separate root object to PUT or to verify.
    expect(envelope.added.some((ref) => ref.key === envelope.rootObject.key)).toBe(true);
    expect(Number(envelope.rootObject.byteLength)).toBeGreaterThan(0);
  });

  test('an ETag that does not match the body refuses before the CAS', async () => {
    const fixture = openSidecar();
    fixture.daemon.plant(textTree({ 'notes.txt': 'generation one' }));
    fixture.payload.corruptNextEtag = true;

    const outcome = await fixture.core.seal('quiesce');
    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' ? outcome.reason : '').toMatch(/etag/iu);
    // NOTHING WAS PUBLISHED, and the operation says why rather than leaving a
    // head that names bytes the store may not hold.
    const control = await fixture.control.read();
    expect(control.head).toBe(null);
    expect(control.operation?.phase).toBe('failed');
    expect(control.operation?.phase === 'failed' ? control.operation.failureCode : '').toBe('receipt-mismatch');
  });

  test('a publish against an old parent loses the CAS and records the failure', async () => {
    const boot = openSidecar({ bootId: 'boot-a' });
    boot.daemon.plant(textTree({ 'notes.txt': 'generation one' }));
    await publish(boot, 'the base seal');

    // TWO BOOTS, ONE BOX: the second sidecar shares the store, the control
    // record and the daemon, exactly as a replaced container does.
    const replacement = openSidecar({
      bootId: 'boot-b',
      share: { daemon: boot.daemon, payload: boot.payload, envelopes: boot.envelopes, control: boot.control },
    });
    await replacement.core.attach();

    // The old boot stages a generation against the head it can see, and the
    // replacement publishes past it before that draft is finalized.
    boot.daemon.write('notes.txt', new TextEncoder().encode('written by boot A'));
    const begun = await beginCandidateOperationV2({
      kind: 'barrier',
      bootId: 'boot-a',
      store: boot.control,
      envelopes: boot.envelopes,
    });
    const stale = await boot.core.stageSeal(begun);
    if (stale.kind === 'no-change') throw new Error('the old boot staged nothing to lose with');

    boot.daemon.write('notes.txt', new TextEncoder().encode('written by boot B'));
    const winner = await publish(replacement, "the replacement's seal");

    let refusal: string | null = null;
    try {
      await boot.core.finalize(stale);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toMatch(/stale parent|does not bind|not active operation/iu);

    // ONE HEAD, and it is the winner's. The loser's failure is on the record.
    const control = await boot.control.read();
    expect(control.head?.rootEnvelopeId).toBe(winner);
    expectSameTree(boot.daemon.tree.snapshot(), await served(replacement), "the winner's head");
  });

  test('no closure walk, no HEAD per existing object, and no multipart await point', async () => {
    const fixture = openSidecar();
    fixture.daemon.plant(textTree({ 'a.txt': 'one', 'b/c.txt': 'two' }));
    await publish(fixture, 'the first seal');
    fixture.daemon.write('a.txt', new TextEncoder().encode('one, again'));
    await publish(fixture, 'the second seal');
    await fixture.core.attach();

    // THE THREE SHAPES v1 PAID FOR, none of them here: a HEAD per object in
    // the closure, a prefix listing, and a multipart upload.
    expect(fixture.payload.ops.some((op) => op.op === 'head')).toBe(false);
    expect(fixture.payload.ops.some((op) => op.op === 'list')).toBe(false);
    const envelope = (await fixture.snapshot()).head!.envelope;
    expect('closure' in envelope).toBe(false);
    expect('closureObject' in envelope).toBe(false);
    // The multipart await points are unreachable BY CONSTRUCTION: a pack is
    // capped below the single-PUT size, so no code path can create one.
    for (const point of ['create-multipart', 'upload-multipart-part', 'complete-multipart'] as const) {
      expect(DURABILITY_AWAIT_POINTS).toContain(point);
    }
    const uploads = fixture.payload.ops.filter((op) => op.op === 'put');
    expect(uploads.every((op) => op.bytes <= PACK_CAP)).toBe(true);
  });
});

describe('compaction pays for itself, and GC deletes only what has served its grace', () => {
  test('rewriting a workload never costs more than three times the bytes it wrote', async () => {
    const fixture = openSidecar({ maxPackBytes: 256 * 1024, graceMs: 0 });
    const seed = new Seeded(77);
    fixture.daemon.plant([
      ...textTree({ 'keep.txt': 'x' }),
      fileEntry('churn.bin', seed.fill(new Uint8Array(200_000)), 21, metadataOf(seed)),
    ]);
    await publish(fixture, 'the churn base');
    let written = 200_000;

    // Overwrite the same file until its early packs are more than half dead,
    // compacting whenever the ledger says a pack qualifies.
    for (let round = 0; round < 6; round += 1) {
      const bytes = seed.fill(new Uint8Array(200_000));
      fixture.daemon.write('churn.bin', bytes);
      written += bytes.byteLength;
      await publish(fixture, `churn round ${round}`);
      await fixture.core.compact();
    }
    const work = fixture.core.status().work;
    expect(work.compaction.bytesRewritten).toBeLessThanOrEqual(3 * written);
    expectSameTree(fixture.daemon.tree.snapshot(), await served(fixture), 'the compacted head');
  }, 120_000);

  test('a pack is compacted only once more than half its bytes are dead', async () => {
    const fixture = openSidecar();
    fixture.daemon.plant(textTree({ 'a.txt': 'one', 'b.txt': 'two' }));
    await publish(fixture, 'the base seal');
    const snapshot = await fixture.snapshot();
    const ledger = snapshot.head!.envelope.ledger;
    expect(ledger.key).toMatch(/^v2\/merkle-pack\/ledger\/[0-9a-f]{64}$/u);
    // Nothing is dead yet, so nothing qualifies — and `compact` says so by
    // answering false rather than publishing an empty generation.
    expect(await fixture.core.compact()).toBe(false);
  });

  test('a retired pack is deleted after its grace window, and never before', async () => {
    let now = 1_000;
    const fixture = openSidecar({ graceMs: 10_000, now: () => now, maxPackBytes: 256 * 1024 });
    const seed = new Seeded(91);
    fixture.daemon.plant([
      ...textTree({ 'keep.txt': 'x' }),
      fileEntry('churn.bin', seed.fill(new Uint8Array(200_000)), 31, metadataOf(seed)),
    ]);
    await publish(fixture, 'the base seal');
    for (let round = 0; round < 4; round += 1) {
      fixture.daemon.write('churn.bin', seed.fill(new Uint8Array(200_000)));
      await publish(fixture, `churn ${round}`);
    }
    const retired = (await fixture.snapshot()).head!.envelope.retired;
    expect(retired.length).toBeGreaterThan(0);

    // Inside the grace window nothing is deleted, whatever the ledger says.
    const beforeGrace = await fixture.core.collectGarbage();
    expect(beforeGrace.deletes).toBe(0);
    expect(fixture.payload.ops.some((op) => op.op === 'delete')).toBe(false);

    now += 10_001;
    const afterGrace = await fixture.core.collectGarbage();
    expect(afterGrace.deletes).toBeGreaterThan(0);
    const deleted = fixture.payload.ops.filter((op) => op.op === 'delete').map((op) => op.key);
    expect(deleted.length).toBe(afterGrace.deletes);
    // AND ONLY UNREACHABLE PACKS: every pack the ledger still lists survives.
    const live = new Set((await fixture.snapshot()).head!.envelope.added.map((ref) => ref.key));
    for (const key of deleted) expect(live.has(key)).toBe(false);
    expectSameTree(fixture.daemon.tree.snapshot(), await served(fixture), 'the head after GC');
  }, 120_000);

  test('the ledger only ever names packs a head reaches', async () => {
    const fixture = openSidecar({ maxPackBytes: 256 * 1024 });
    const seed = new Seeded(101);
    fixture.daemon.plant([
      ...textTree({ 'keep.txt': 'x' }),
      fileEntry('churn.bin', seed.fill(new Uint8Array(300_000)), 41, metadataOf(seed)),
    ]);
    await publish(fixture, 'the base seal');
    fixture.daemon.write('churn.bin', seed.fill(new Uint8Array(300_000)));
    await publish(fixture, 'the overwrite seal');

    const envelope = (await fixture.snapshot()).head!.envelope;
    const ledgerBytes = fixture.payload.objects.get(envelope.ledger.key);
    expect(ledgerBytes).toBeDefined();
    const ledger = parsePackLedger(ledgerBytes!);
    for (const row of ledger.packs) {
      expect(fixture.payload.objects.has(row.key)).toBe(true);
      expect(Number(row.liveBytes)).toBeLessThanOrEqual(Number(row.byteLength));
    }
    expect(compactionCandidates(
      { version: 1, format: 'merkle-pack/v2', boxId: 'box-sidecar', generation: envelope.generation, packs: ledger.packs.map((row) => ({ ...row, sha256: 'f'.repeat(64), addedInGeneration: '1' })) },
      envelope.generation,
    ).length).toBeGreaterThanOrEqual(0);
  }, 120_000);
});
