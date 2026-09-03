/**
 * The sidecar: one long-lived process that seals, publishes and reports.
 *
 * WHAT IT REPLACES. Every checkpoint used to start a `bun` process inside the
 * container, load this package's whole module graph, fence once, publish, and
 * exit — and a restore started another. At a two-second seal cadence that
 * process start IS the cost. This is the same code as one resident object: the
 * head it opened, the parent it authenticated, the extent boundaries it handed
 * the daemon, and the counters it has measured all survive from one seal to
 * the next.
 *
 * WHAT ONE SEAL DOES, in order, and why the order is the order:
 *
 *   1. begin the operation on the Durable Object, so a crash anywhere below
 *      leaves a record that names what was in flight;
 *   2. fence the daemon — admission closes for the O(k) stage copy only;
 *   3. build the delta against the authenticated published parent;
 *   4. PUT each pack once, holding every body to its own ETag;
 *   5. PUT the ledger, seal the envelope, and CAS the head exactly once;
 *   6. only THEN hand the new chunk boundaries back to the daemon, because
 *      boundaries that describe a generation nobody published would make the
 *      next fence stage windows against a tree that does not exist;
 *   7. retire what the ledger says is dead and delete what has served its
 *      grace.
 */

import { createHash } from 'node:crypto';

import { sha256Hex } from '../../src/cas/hash';
import {
  beginCandidateOperationV2,
  failCandidateOperation,
  finalizeCandidateOperationV2,
} from '../../src/candidates/control';
import type { CandidateControlStore, CandidateEnvelopeStoreV2 } from '../../src/candidates/control';
import { LazyRestore } from '../../src/candidates/lazy-restore';
import type { LazyRestorePorts } from '../../src/candidates/lazy-restore';
import {
  buildMerkleDelta,
  parentFromPublishedV2,
} from '../../src/candidates/merkle-pack/build-v2';
import type { MerkleDeltaBuild } from '../../src/candidates/merkle-pack/build-v2';
import { compactMerklePacks } from '../../src/candidates/merkle-pack/compaction';
import { mergeSealWork } from '../../src/candidates/merkle-pack/delta';
import type { BoundaryHandback, BoundaryRow } from '../../src/candidates/merkle-pack/delta';
import {
  compactionCandidates,
  deletableRetiredPacks,
  nextPackLedger,
  packLedgerRef,
  parsePackLedger,
} from '../../src/candidates/merkle-pack/ledger';
import type { RetiredPack } from '../../src/candidates/merkle-pack/ledger';
import { openMerkleV2 } from '../../src/candidates/merkle-pack/view-v2';
import type { KnownPack, MerkleV2Reader, MerkleV2View } from '../../src/candidates/merkle-pack/view-v2';
import { MERKLE_PACK_V2_FORMAT } from '../../src/candidates/merkle-pack/wire';
import {
  ReceiptMismatch,
  candidateRangeRequest,
  envelopeV2Bytes,
  readCandidateRange,
  recoverPublishedParentV2,
  stageCandidatePayloadV2,
} from '../../src/candidates/publication';
import type {
  CandidatePackUpload,
  CandidatePayloadStore,
  CandidatePublicationDraftV2,
} from '../../src/candidates/publication';
import type { ChunkParams } from '../../src/candidates/merkle-pack/chunk';
import type { EvictionRequest, FileGeometry, Hydration } from '../../src/candidates/residency';
import type {
  CandidateRunControlV2,
  CompactionWork,
  GcWork,
  HydrateWork,
  ObjectRangeRef,
  PackLedger,
  PublishWork,
  RestoreWork,
  SealWork,
  SidecarStatusV1,
} from '../../src/durability/contracts';
import type { JournalDelta, JournalFence } from '../../src/capture/journal/client';
import type { NodeEntry } from '../../src/capture/model';

/**
 * The daemon half of the seal, over its control socket. `delta` is
 * `readJournalDelta` behind the port: a modeled daemon in a test implements
 * the same contract from its own tree, and the deployed adapter is the
 * function itself.
 */
export interface SidecarDaemon {
  /** Close admission, drain, stage the dirty windows, answer the cut. */
  fence(): Promise<JournalFence>;
  /** The manifest that fence wrote, bound to its verified stage. */
  delta(fence: JournalFence): Promise<JournalDelta>;
  /** Merge the boundaries of the files a published generation rewrote. */
  boundaries(handback: BoundaryHandback): Promise<number>;
}

/**
 * The payload transport: single PUTs out, authenticated ranges back, and the
 * one delete GC needs. Deletion is a transport capability rather than part of
 * the publication boundary, because nothing that publishes may remove bytes.
 */
export interface SidecarPayloadStore extends CandidatePayloadStore, MerkleV2Reader {
  deleteObject(key: string): Promise<void>;
}

/**
 * The head authority, present only where the sidecar shares a process with
 * it. A container-side sidecar stages seals and hands drafts to the Durable
 * Object; it never holds this, because a container that could advance a head
 * would be a second authority for it.
 */
export interface SidecarHeadAuthority {
  readonly control: CandidateControlStore;
  readonly envelopes: CandidateEnvelopeStoreV2;
}

export interface SidecarPorts {
  readonly boxId: string;
  readonly bootId: string;
  /** The current control snapshot: the row plus the envelope it names. */
  readonly snapshot: () => Promise<CandidateRunControlV2>;
  readonly head?: SidecarHeadAuthority;
  readonly payload: SidecarPayloadStore;
  readonly daemon: SidecarDaemon;
  readonly now: () => number;
  readonly maxPackBytes?: number;
  readonly chunkParams?: ChunkParams;
  readonly graceMs?: number;
  readonly log?: (event: string, detail: string) => void;
}
export type SealKind = 'tick' | 'barrier' | 'quiesce';

export type SealOutcome =
  | { readonly kind: 'published'; readonly rootEnvelopeId: string; readonly generation: string }
  | { readonly kind: 'no-change'; readonly rootEnvelopeId: string | null }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * What one staged seal hands the head authority: the draft to finalize, and
 * the facts the sidecar needs afterwards — the cut, the boundaries the daemon
 * merges, the paths it drops, the ledger this generation wrote and the packs
 * it retires.
 */
export interface StagedSeal {
  readonly kind: 'staged';
  readonly draft: CandidatePublicationDraftV2;
  readonly generation: string;
  readonly cut: string;
  readonly boundaries: readonly BoundaryRow[];
  readonly removed: readonly string[];
  readonly ledger: PackLedger;
  readonly retired: readonly string[];
}

const DEFAULT_GRACE_MS = 600_000;

const ZERO_RESTORE: RestoreWork = {
  serialRemoteOps: 0,
  totalRemoteOps: 0,
  metadataBytes: 0,
  payloadBytes: 0,
  cpuSteps: 0,
  mounts: 0,
  replayUnits: 0,
};
const ZERO_SEAL: SealWork = { bytesStaged: 0, bytesChunked: 0, chunksHashed: 0, nodesRewritten: 0, wholeFiles: 0 };
const ZERO_PUBLISH: PublishWork = { objectsPut: 0, bytesPut: 0, casAttempts: 0 };
const ZERO_HYDRATE: HydrateWork = { rangeGets: 0, bytesFetched: 0, bytesRequested: 0 };
const ZERO_COMPACTION: CompactionWork = { packsRead: 0, bytesRewritten: 0, nodesRewritten: 0 };
const ZERO_GC: GcWork = { deletes: 0, markPages: 0, markBytes: 0 };

/** The MD5 the single PUT answers with, over exactly the bytes it sent. */
export function md5Of(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex');
}
interface ThrownFailure {
  readonly cause: unknown;
}

export class SidecarCore {
  readonly #ports: SidecarPorts;
  #attach: SidecarStatusV1['attach'] = { kind: 'attaching' };
  /** What a failure the control plane refused to record leaves in the log. */
  readonly #thrownDetail = ({ cause }: ThrownFailure): void =>
    this.#ports.log?.(
      'sidecar.failure_unrecorded',
      cause instanceof Error ? cause.message : String(cause),
    );
  #view: MerkleV2View | null = null;
  /** The lazy restore this box is serving the head through, once a container
   *  has asked for one. Reopened by every attach, because it reads through
   *  the view that attach opened. */
  #lazy: LazyRestore | null = null;
  #lazyPorts: LazyRestorePorts | null = null;
  #head: CandidateRunControlV2['head'] = null;
  #ledger: PackLedger | null = null;
  #retired: RetiredPack[] = [];
  #restore: RestoreWork = ZERO_RESTORE;
  #seal: SealWork = ZERO_SEAL;
  #publish: PublishWork = ZERO_PUBLISH;
  #compaction: CompactionWork = ZERO_COMPACTION;
  #gc: GcWork = ZERO_GC;
  #unsealedBytes = 0;
  #unsealedSince: number | null = null;
  #unpublishedGenerations = 0;
  #unpublishedSince: number | null = null;

  constructor(ports: SidecarPorts) {
    this.#ports = ports;
  }

  /** The head this sidecar serves, once it has one. */
  view(): MerkleV2View | null {
    return this.#view;
  }

  /** Dirty bytes the daemon's WAL has grown by since the last seal. */
  noteDirty(bytes: number): void {
    if (bytes <= 0) return;
    this.#unsealedBytes += bytes;
    this.#unsealedSince ??= this.#ports.now();
  }

  get unsealedBytes(): number {
    return this.#unsealedBytes;
  }

  get unsealedSince(): number | null {
    return this.#unsealedSince;
  }

  /**
   * Open the published head: the control row, the envelope it names, and one
   * range read of the root record. Nothing else, whatever the tree holds.
   */
  async attach(): Promise<SidecarStatusV1['attach']> {
    const control = await this.#ports.snapshot();
    this.#head = control.head;
    if (control.head === null) {
      this.#view = null;
      this.#lazy = null;
      this.#restore = { ...ZERO_RESTORE, totalRemoteOps: 1, serialRemoteOps: 1 };
      this.#attach = { kind: 'empty' };
      return this.#attach;
    }
    const envelope = control.head.envelope;
    this.#view = await openMerkleV2(envelope.rootObject, this.#ports.payload, this.#identity('attach'));
    this.#ledger = await this.#readLedger(envelope.ledger, 'attach');
    const hydrate = this.#view.work();
    this.#restore = {
      serialRemoteOps: hydrate.rangeGets + 2,
      totalRemoteOps: hydrate.rangeGets + 2,
      metadataBytes: hydrate.bytesFetched + envelopeV2Bytes(envelope).byteLength,
      payloadBytes: 0,
      cpuSteps: 0,
      mounts: 0,
      replayUnits: 0,
    };
    // The daemon starts with an empty boundary map on a fresh instance, so its
    // first fence over any file stages that file whole. The build counts that
    // in `wholeFiles` and this hand-back teaches it the boundaries, so the
    // second seal of the same file is incremental again.
    await this.#ports.daemon.boundaries({
      cut: envelope.cut.cut,
      generation: envelope.generation,
      root: control.head.pointer.rootEnvelopeId,
      maxChunkBytes: this.#chunkMax(),
      files: [],
      removed: [],
    });
    // A LAZY RESTORE READS THROUGH THE VIEW THIS ATTACH JUST OPENED, so the
    // one the previous attach handed out is stale the moment the head moves.
    // Reopening here rather than dropping it keeps a container that asked for
    // lazy service lazy across the re-attach a publish performs; what it does
    // NOT do is claim residency for the new head, which is the container's to
    // declare because the container is what holds the bytes.
    this.#lazy = this.#lazyPorts === null
      ? null
      : new LazyRestore(this.#view, this.#lazyPorts);
    this.#attach = {
      kind: 'attached',
      rootEnvelopeId: control.head.pointer.rootEnvelopeId,
      generation: envelope.generation,
    };
    return this.#attach;
  }

  /**
   * Serve the head lazily: the container gets its root and the mount, and
   * pays for a node the first time it touches one.
   *
   * THE ATTACH PATH. A box that is woken to run a command needs a workspace
   * it can enter now, not a tree that has finished arriving — and the tree
   * finishing is the term cell 6.13 measured at one remote operation per file.
   * The container drives what it gets back: `list` on a directory fault,
   * `hydrate` on a read, `forget` on a write, `evict` under disk pressure.
   *
   * The ports are remembered, so the re-attach a publish performs hands the
   * same container a restore over the NEW head without it asking again.
   */
  restoreLazily(ports: LazyRestorePorts): LazyRestore {
    const view = this.#view;
    if (view === null) throw new Error('a lazy restore needs an attached head; attach first');
    this.#lazyPorts = ports;
    const restore = new LazyRestore(view, ports);
    this.#lazy = restore;
    return restore;
  }

  /** The lazy restore this box is serving through, if a container asked for
   *  one. Answers the CURRENT head's: every attach reopens it. */
  lazyRestore(): LazyRestore | null {
    return this.#lazy;
  }

  /** One file of the tree is whole and clean again — what a publish leaves
   *  behind, when every byte the container holds has become a cache of the
   *  head it just wrote. Registering it is what makes it evictable. */
  noteResident(path: string, geometry: FileGeometry): void {
    this.#lazy?.registerResident(path, geometry);
  }

  /**
   * Drop clean pages nothing has touched inside the window, and report what
   * the sweep did.
   *
   * WHAT MAKES THIS SAFE is not the sweep, it is the read: every page it can
   * reach came out of an immutable object and is held to the digest the head
   * declares, so bringing one back is idempotent. A box under disk pressure
   * therefore trades a re-read for the room to keep working, which is the
   * alternative to refusing the write.
   */
  evictClean(request: EvictionRequest = {}): GcWork {
    const restore = this.#lazy;
    if (restore === null) return ZERO_GC;
    const swept = restore.evict(request);
    this.#gc = {
      deletes: this.#gc.deletes + swept.deletes,
      markPages: this.#gc.markPages + swept.markPages,
      markBytes: this.#gc.markBytes + swept.markBytes,
    };
    return swept;
  }

  /** How much of the head this box holds locally. */
  hydration(): Hydration {
    return this.#lazy?.hydration() ?? { residentBytes: 0, treeBytes: 0, placeholders: 0 };
  }

  /**
   * Write the whole published head into the container's filesystem: the eager
   * restore. The ledger names every pack with its length and digest, so the
   * walk reads each pack ONCE, whole, and slices every record and chunk out of
   * that one fetch — one remote operation per pack, whatever the tree holds.
   *
   * NOT THE ATTACH PATH, and the difference is measured rather than stylistic:
   * this is O(#packs) operations and O(tree) bytes, against
   * {@link restoreLazily}'s O(1) operations and the bytes the workload
   * actually reads. A caller that genuinely wants every byte now — a fidelity
   * comparison, a full-tree export — is what this is for.
   */
  async materialize(sink: (entries: readonly NodeEntry[]) => Promise<void> | void): Promise<HydrateWork> {
    const view = this.#view;
    const ledger = this.#ledger;
    if (view === null || ledger === null) {
      throw new Error('a materialize needs an attached head; attach first');
    }
    const wholePacks = new Map<string, KnownPack>(
      ledger.packs.map((row) => [row.key, { byteLength: Number(row.byteLength), sha256: row.sha256 }]),
    );
    const bulk = await openMerkleV2(
      this.#head!.envelope.rootObject,
      this.#ports.payload,
      this.#identity('restore'),
      { wholePacks },
    );
    const entries: NodeEntry[] = [];
    const walk = async (at: string): Promise<void> => {
      for (const name of await bulk.readdir(at)) {
        const path = at === '' ? name : `${at}/${name}`;
        const stat = await bulk.stat(path);
        if (stat === null) throw new Error(`the head lists ${path} and cannot stat it`);
        const metadata = stat.metadata ?? undefined;
        const ino = stat.ino ?? 0;
        if (stat.kind === 'dir') {
          entries.push({ path, kind: 'dir', mode: stat.mode, ino, metadata });
          await walk(path);
          continue;
        }
        if (stat.kind === 'symlink') {
          entries.push({ path, kind: 'symlink', mode: stat.mode, ino, metadata, target: stat.target ?? '' });
          continue;
        }
        const runs: { offset: number; bytes: Uint8Array }[] = [];
        let holes = false;
        for (const extent of await bulk.extents(path)) {
          if (extent.kind === 'hole') {
            holes = true;
            continue;
          }
          runs.push({ offset: extent.offset, bytes: await bulk.readRange(path, extent.offset, extent.length) });
        }
        const content = holes
          ? { kind: 'sparse' as const, size: stat.size, runs }
          : { kind: 'dense' as const, bytes: runs[0]?.bytes ?? new Uint8Array(0) };
        entries.push({ path, kind: 'file', mode: stat.mode, ino, metadata, content });
      }
    };
    await walk('');
    await sink(entries);
    return bulk.work();
  }

  /**
   * The half a CONTAINER may run on its own: fence the daemon, build the
   * delta against the authenticated parent, PUT every pack and the ledger,
   * and answer the draft a Durable Object finalizes. It performs no CAS, and
   * that is the boundary — the head is the DO's to advance, and a container
   * that could advance it would be a second authority.
   */
  async stageSeal(begun: CandidateRunControlV2): Promise<StagedSeal | { readonly kind: 'no-change' }> {
    const operation = begun.operation;
    if (operation?.phase !== 'transferring') {
      throw new Error('a staged seal needs a transferring operation');
    }
    const fence = await this.#ports.daemon.fence();
    // `delta` is the production client's `readJournalDelta` behind the port:
    // the manifest arrives proven the fence's own, and every staged read is
    // held to the digest the fence recorded.
    const delta = await this.#ports.daemon.delta(fence);
    try {
      return await this.#stageSeal(begun, fence, delta, operation);
    } finally {
      delta.close();
    }
  }

  async #stageSeal(
    begun: CandidateRunControlV2,
    fence: JournalFence,
    delta: JournalDelta,
    operation: Extract<NonNullable<CandidateRunControlV2['operation']>, { phase: 'transferring' }>,
  ): Promise<StagedSeal | { readonly kind: 'no-change' }> {
    const manifest = delta.manifest;
    const head = begun.head;
    if (manifest.entries.length === 0 && manifest.metadataOps.length === 0 && begun.head !== null) {
      this.#unsealedBytes = 0;
      this.#unsealedSince = null;
      return { kind: 'no-change' };
    }
    const identity = {
      operationId: operation.operationId,
      attemptId: operation.attemptId,
      boxId: this.#ports.boxId,
      epoch: operation.epoch,
      bootId: operation.bootId,
      kind: operation.kind,
      expiresAt: String(this.#ports.now() + 600_000),
    };
    const capturedCut = {
      captureId: operation.operationId,
      epoch: operation.epoch,
      baseRevision: operation.baseRevision,
      cut: String(manifest.cut),
      stableStageHandle: manifest.stageRoot,
      manifestSha256: sha256Hex(new TextEncoder().encode(JSON.stringify(manifest))),
    };
    let parent = null;
    let parentLedger: PackLedger | null = null;
    if (head !== null) {
      const view = await openMerkleV2(head.envelope.rootObject, this.#ports.payload, this.#identity('seal'));
      const rootBytes = await this.#readRange(head.envelope.rootObject, 'seal');
      parent = parentFromPublishedV2(view, recoverPublishedParentV2({
        head: head.pointer,
        currentHead: head.pointer,
        envelope: head.envelope,
        envelopeBytes: envelopeV2Bytes(head.envelope),
        rootBytes,
        expected: {
          format: head.envelope.format,
          capturedCut: head.envelope.cut,
          lastOperationId: head.pointer.lastOperationId,
        },
      }));
      parentLedger = this.#ledger ?? await this.#readLedger(head.envelope.ledger, 'seal');
    }
    const build = await buildMerkleDelta(manifest, {
      stage: delta.stage,
      parent,
      chunkParams: this.#ports.chunkParams,
      maxPackBytes: this.#ports.maxPackBytes,
    });
    const generation = String(BigInt(head?.envelope.generation ?? '0') + 1n);
    const staged = await this.#stagePayload({
      build,
      parentLedger,
      capturedCut,
      identity,
      expectedParent: operation.expectedParent,
      generation,
    });
    this.#seal = mergeSealWork(fence.sealWork, build.seal);
    return {
      kind: 'staged',
      draft: staged.draft,
      generation,
      cut: String(manifest.cut),
      boundaries: build.boundaries,
      removed: build.removed,
      ledger: staged.ledger,
      retired: staged.retired,
    };
  }

  /**
   * One seal end to end, for a sidecar that can reach the control record: the
   * staged half above, the head CAS, then the boundary hand-back. A failure
   * anywhere leaves the durable operation recoverable and answers with the
   * reason rather than throwing, because the caller is a loop.
   */
  async seal(kind: SealKind): Promise<SealOutcome> {
    const authority = this.#ports.head;
    if (authority === undefined) {
      return { kind: 'failed', reason: 'this sidecar stages seals; it does not hold the head authority' };
    }
    let operationId: string | null = null;
    try {
      const begun = await beginCandidateOperationV2({
        kind: kind === 'tick' ? 'tick' : 'barrier',
        bootId: this.#ports.bootId,
        store: authority.control,
        envelopes: authority.envelopes,
      });
      operationId = begun.operation?.operationId ?? null;
      const staged = await this.stageSeal(begun);
      if (staged.kind === 'no-change') {
        return { kind: 'no-change', rootEnvelopeId: begun.head?.pointer.rootEnvelopeId ?? null };
      }
      const published = await this.finalize(staged);
      this.#unsealedBytes = 0;
      this.#unsealedSince = null;
      await this.#ports.daemon.boundaries({
        cut: staged.cut,
        generation: published.generation,
        root: published.rootEnvelopeId,
        maxChunkBytes: this.#chunkMax(),
        files: staged.boundaries,
        removed: staged.removed,
      });
      await this.attach();
      await this.collectGarbage();
      return { kind: 'published', rootEnvelopeId: published.rootEnvelopeId, generation: published.generation };
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#ports.log?.('sidecar.seal_failed', reason);
      // A SEAL THAT DIED BEFORE THE CAS SAYS SO ON THE RECORD. Without this
      // the operation stays `transferring` forever and the next seal joins a
      // transfer whose bytes nobody will ever finish.
      if (operationId !== null) {
        try {
          await failCandidateOperation({
            operationId,
            failureCode: error instanceof ReceiptMismatch ? 'receipt-mismatch' : 'transfer-failed',
            store: authority.control,
          });
        } catch (cause) {
          this.#thrownDetail({ cause });
        }
      }
      return { kind: 'failed', reason };
    }
  }

  /** Advance the head to a staged generation: the one CAS, on the DO's side. */
  async finalize(staged: StagedSeal): Promise<{ readonly rootEnvelopeId: string; readonly generation: string }> {
    const authority = this.#ports.head;
    if (authority === undefined) throw new Error('this sidecar does not hold the head authority');
    const settled = await finalizeCandidateOperationV2({
      draft: staged.draft,
      boxId: this.#ports.boxId,
      store: authority.control,
      envelopes: authority.envelopes,
    });
    const pointer = settled.head;
    if (pointer === null) throw new Error('a v2 publish did not advance the head');
    const envelope = await authority.envelopes.read(pointer.rootEnvelopeId);
    // ONE PUBLISH, ONE ROW. `PublishWork` states what one publish did, so a
    // caller checking a per-publish bound reads a per-publish number; a total
    // across a boot would make every bound grow with uptime.
    this.#publish = {
      objectsPut: staged.draft.added.length + 2,
      bytesPut: staged.draft.added.reduce((bytes, ref) => bytes + Number(ref.byteLength), 0)
        + Number(staged.draft.ledger.byteLength)
        + envelopeV2Bytes(envelope).byteLength,
      casAttempts: 1,
    };
    this.#unpublishedGenerations = 0;
    this.#unpublishedSince = null;
    const retiredAtMs = this.#ports.now();
    for (const key of staged.retired) {
      this.#retired.push({ key, generation: staged.generation, retiredAtMs });
    }
    this.#ledger = staged.ledger;
    return { rootEnvelopeId: pointer.rootEnvelopeId, generation: staged.generation };
  }

  /**
   * Rewrite the packs the ledger says are more than half dead, as an ordinary
   * generation whose tree content did not change. Answers false when nothing
   * qualifies, which is the ordinary case.
   */
  async compact(): Promise<boolean> {
    const ledger = this.#ledger;
    const view = this.#view;
    const head = this.#head;
    if (ledger === null || view === null || head === null) return false;
    const candidates = compactionCandidates(ledger, head.envelope.generation);
    if (candidates.length === 0) return false;
    const keys = new Set(candidates.map((row) => row.key));
    const built = await compactMerklePacks({
      view,
      candidates: keys,
      maxPackBytes: this.#ports.maxPackBytes ?? 32 * 1024 * 1024,
    });
    if (built === null) return false;
    const authority = this.#ports.head;
    if (authority === undefined) return false;
    const begun = await beginCandidateOperationV2({
      kind: 'gc',
      bootId: this.#ports.bootId,
      store: authority.control,
      envelopes: authority.envelopes,
    });
    const operation = begun.operation;
    if (operation?.phase !== 'transferring' || begun.head === null) return false;
    const generation = String(BigInt(begun.head.envelope.generation) + 1n);
    const staged = await this.#stagePayload({
      build: {
        packs: built.packs,
        rootObject: built.rootObject,
        seal: { bytesChunked: 0, chunksHashed: 0, nodesRewritten: built.work.nodesRewritten, wholeFiles: 0 },
        boundaries: [],
        removed: [],
        deadBytes: new Map(),
      },
      parentLedger: ledger,
      capturedCut: {
        ...begun.head.envelope.cut,
        captureId: operation.operationId,
        epoch: operation.epoch,
        baseRevision: operation.baseRevision,
      },
      identity: {
        operationId: operation.operationId,
        attemptId: operation.attemptId,
        boxId: this.#ports.boxId,
        epoch: operation.epoch,
        bootId: operation.bootId,
        kind: operation.kind,
        expiresAt: String(this.#ports.now() + 600_000),
      },
      expectedParent: operation.expectedParent,
      generation,
      compacted: built.retired,
    });
    const published = await this.finalize({
      kind: 'staged',
      draft: staged.draft,
      generation,
      cut: begun.head.envelope.cut.cut,
      boundaries: [],
      removed: [],
      ledger: staged.ledger,
      retired: staged.retired,
    });
    this.#compaction = {
      packsRead: built.work.packsRead,
      bytesRewritten: this.#compaction.bytesRewritten + built.work.bytesRewritten,
      nodesRewritten: built.work.nodesRewritten,
    };
    this.#ports.log?.('sidecar.compacted', `${published.rootEnvelopeId} retired ${built.retired.length} pack(s)`);
    await this.attach();
    return true;
  }

  /**
   * Delete the retired packs whose grace window has elapsed. Deletion is by
   * ledger and by grace, never by listing a prefix, and never before the
   * generation that retired a pack is published.
   *
   * Answers what THIS cycle did. The accumulation across every sweep — this
   * one and {@link evictClean}'s, which is the same decision at a different
   * distance — is the row `status` reports.
   */
  async collectGarbage(): Promise<GcWork> {
    const grace = this.#ports.graceMs ?? DEFAULT_GRACE_MS;
    const due = deletableRetiredPacks(this.#retired, this.#ports.now(), grace);
    if (due.length === 0) return ZERO_GC;
    const remaining = this.#retired.filter((pack) => !due.includes(pack.key));
    for (const key of due) await this.#ports.payload.deleteObject?.(key);
    this.#retired = remaining;
    this.#gc = { ...this.#gc, deletes: this.#gc.deletes + due.length };
    return { deletes: due.length, markPages: 0, markBytes: 0 };
  }

  /** Every row the Durable Object reads on a drive, from what really ran. */
  status(): SidecarStatusV1 {
    const now = this.#ports.now();
    return {
      version: 1,
      format: MERKLE_PACK_V2_FORMAT,
      boxId: this.#ports.boxId,
      epoch: this.#head?.envelope.epoch ?? '0',
      bootId: this.#ports.bootId,
      attach: this.#attach,
      lag: {
        unsealedBytes: this.#unsealedBytes,
        unsealedMs: this.#unsealedSince === null ? 0 : Math.max(0, now - this.#unsealedSince),
        unpublishedGenerations: this.#unpublishedGenerations,
        unpublishedMs: this.#unpublishedSince === null ? 0 : Math.max(0, now - this.#unpublishedSince),
      },
      // What a lazy restore holds of the head, or zeros for a box whose
      // container never asked for one: a materialize owns its own bytes, and
      // this sidecar will not guess at residency it does not manage.
      hydration: this.hydration(),
      work: {
        restore: this.#restore,
        seal: this.#seal,
        publish: this.#publish,
        hydrate: this.#lazy?.work() ?? this.#view?.work() ?? ZERO_HYDRATE,
        compaction: this.#compaction,
        gc: this.#gc,
      },
    };
  }

  #chunkMax(): number {
    return this.#ports.chunkParams?.maxBytes ?? 16 * 1024;
  }

  #identity(operationId: string) {
    return {
      operationId,
      attemptId: this.#ports.bootId,
      boxId: this.#ports.boxId,
      epoch: this.#head?.envelope.epoch ?? '0',
      expiresAt: String(this.#ports.now() + 600_000),
    };
  }

  async #readRange(ref: ObjectRangeRef, operationId: string): Promise<Uint8Array> {
    const identity = this.#identity(operationId);
    return await readCandidateRange(
      candidateRangeRequest({
        operationId: identity.operationId,
        attemptId: identity.attemptId,
        boxId: identity.boxId,
        epoch: identity.epoch,
        exactKey: ref.key,
        method: 'GET',
        byteOffset: ref.byteOffset,
        byteLength: ref.byteLength,
        sha256: ref.sha256,
        expiresAt: identity.expiresAt,
      }),
      this.#ports.payload,
    );
  }

  async #readLedger(
    ref: { readonly key: string; readonly byteLength: string; readonly sha256: string },
    operationId: string,
  ): Promise<PackLedger> {
    return parsePackLedger(await this.#readRange(
      { key: ref.key, byteOffset: '0', byteLength: ref.byteLength, sha256: ref.sha256 },
      operationId,
    ));
  }

  async #stagePayload(input: {
    readonly build: MerkleDeltaBuild;
    readonly parentLedger: PackLedger | null;
    readonly capturedCut: {
      readonly captureId: string;
      readonly epoch: string;
      readonly baseRevision: string;
      readonly cut: string;
      readonly stableStageHandle: string;
      readonly manifestSha256: string;
    };
    readonly identity: {
      readonly operationId: string;
      readonly attemptId: string;
      readonly boxId: string;
      readonly epoch: string;
      readonly bootId: string;
      readonly kind: 'tick' | 'barrier' | 'gc' | 'cleanup';
      readonly expiresAt: string;
    };
    readonly expectedParent: string | null;
    readonly generation: string;
    readonly compacted?: readonly string[];
  }): Promise<{
    readonly draft: CandidatePublicationDraftV2;
    readonly ledger: PackLedger;
    readonly retired: readonly string[];
  }> {
    const next = nextPackLedger({
      parent: input.parentLedger,
      format: MERKLE_PACK_V2_FORMAT,
      boxId: this.#ports.boxId,
      generation: input.generation,
      added: input.build.packs.map((pack) => pack.ref),
      deadBytes: input.build.deadBytes,
      compacted: input.compacted,
    });
    const ledger = packLedgerRef(next.ledger);
    const uploads: CandidatePackUpload[] = input.build.packs.map((pack) => ({
      ref: pack.ref,
      bytes: pack.bytes,
      md5: md5Of(pack.bytes),
    }));
    const draft = await stageCandidatePayloadV2(
      {
        format: MERKLE_PACK_V2_FORMAT,
        expectedParentRootId: input.expectedParent,
        capturedCut: input.capturedCut,
        generation: input.generation,
        rootObject: input.build.rootObject,
        packs: uploads,
        ledger: { ref: ledger.ref, bytes: ledger.bytes, md5: md5Of(ledger.bytes) },
        retired: next.retired,
      },
      input.identity,
      this.#ports.payload,
    );
    // Sealed and uploaded, not yet published: the window a caller reports as
    // durability lag until the CAS lands.
    this.#unpublishedGenerations += 1;
    this.#unpublishedSince ??= this.#ports.now();
    return { draft, ledger: next.ledger, retired: next.retired };
  }
}
