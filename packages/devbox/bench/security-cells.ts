/**
 * Live G4 security fault cells, worker side.
 *
 * Runs inside the benchmark fixture (packages/devbox/bench/worker.ts
 * `POST /security`) against the REAL product storage boundaries with REAL
 * bucket and Durable Object storage, but strictly inside an isolated
 * per-call namespace: `<boxPrefix>security-cells/<nonce>/`. Nothing here
 * touches a live control record (`devbox:candidate-control:*`,
 * `devbox:storage-state`) or a live payload prefix. The attacks are real —
 * stale epochs, hostile paths/hashes, escape/replay grants, secret scans —
 * and the refusals are the production controls' own.
 *
 * Product controls reused (never reimplemented):
 *   F7  beginCandidateOperation / redriveCandidateOperation /
 *       finalizeCandidateOperation (epoch + attempt binding) for candidates;
 *       ChainRecordAdvanced rev-gated compare for snapshot-chain.
 *   F10 isCanonicalJournalPath (+ MerklePackError hostile-path) for
 *       candidates; isChainId + baseObjectKey refusal and
 *       layerIntegrityFailure for snapshot-chain; envelopeBytes /
 *       envelopeIdOf / parseEnvelopeBytes digest binding and the R2 head
 *       key/size/sha/version rule (devbox.ts verifyObject) for both.
 *   F11 box-prefix key builders (candidateStorePaths / chainStoreRoot +
 *       baseObjectKey / objectKey) for prefix; the worker's constant-time
 *       bearer check for authorization; UploadIntent/ObjectReceipt binding
 *       (operationId/attemptId) + control-plane attempt fence for replay.
 *   F12 scans reply text, non-token env values and isolated store bytes for
 *       the live fixture secret and reports presence only — never the value.
 *
 * Every catch records: an expected refusal lands in the cell's detail or in
 * `cleanupErrors`, and anything outside the production gate returns `unable`
 * rather than a verdict the wrong gate produced. Cleanup failures are G8's,
 * so they are recorded in `cleanupErrors` without changing the verdict.
 *
 * A strategy that cannot offer a primitive reports `unable` with its reason
 * and leaves `completed` false, so the gate refuses rather than passing on
 * zeros. r2fs and overlay-cas own no candidate epoch, envelope, or grant, so
 * every cell but F12 is unable there. The decisive three
 * (snapshot-chain, bounded-layers, merkle-pack) can all complete.
 */

import * as v from 'valibot';

import { isCanonicalJournalPath } from '../src/cas/types';
import { sha256Hex } from '../src/cas/hash';
import { describeThrown } from '../src/lifecycle';
import {
  baseObjectKey,
  deltaObjectKey,
  isChainId,
  chainStoreRoot,
  layerIntegrityFailure,
  ChainRecordAdvanced,
  type ChainLayer,
} from '../src/snapshot-chain';
import {
  beginCandidateOperation,
  finalizeCandidateOperation,
  redriveCandidateOperation,
  CandidateOperationRefused,
  type CandidateControlStore,
  type CandidateEnvelopeStore,
} from '../src/candidates/control';
import {
  CandidatePublicationDraftSchema,
  envelopeBytes,
  envelopeIdOf,
  parseEnvelopeBytes,
  StaleParentRefused,
  type CandidatePublicationDraft,
} from '../src/candidates/publication';
import { objectKey as boundedObjectKey } from '../src/candidates/bounded-layers';
import { candidateStorePaths } from '../src/candidates/container';
import type { CandidateControlStateV1, ImmutableObjectRef, RootEnvelopeV1 } from '../src/durability/contracts';
import { CandidateControlStateV1Schema } from '../src/durability/contracts';

export type SecurityStrategy = 'snapshot-chain' | 'bounded-layers' | 'merkle-pack';
export type SecurityCellId = 'F7' | 'F10' | 'F11' | 'F12';
export type SecurityCellStatus = 'refused' | 'accepted' | 'unable';

export interface SecurityCellResult {
  readonly id: SecurityCellId;
  readonly status: SecurityCellStatus;
  readonly detail: string;
}

export interface SecurityCellsObservation {
  readonly strategy: string;
  readonly completed: boolean;
  readonly cells: readonly SecurityCellResult[];
  readonly staleWriterAccepted: boolean;
  readonly hostileMetadataAccepted: boolean;
  readonly prefixEscapes: number;
  readonly capabilityEscapesOrReplays: number;
  /** Descriptions only — never a secret value. */
  readonly credentialLeaks: readonly string[];
  /** Isolated-namespace cleanup that failed; G8 owns it, so the verdict stands. */
  readonly cleanupErrors: readonly string[];
}

const NONCE = /^[A-Za-z0-9-]{8,64}$/;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function dummySha(seed: string): string {
  return sha256Hex(textEncoder.encode(`security-cell:${seed}`));
}

/** The isolated prefix for one call. The nonce is driver-chosen per call. */
export function securityPrefixFor(boxPrefix: string, nonce: string): string {
  if (!NONCE.test(nonce)) throw new Error('security nonce is not an 8-64 char id');
  const base = boxPrefix.endsWith('/') ? boxPrefix : `${boxPrefix}/`;
  return `${base}security-cells/${nonce}/`;
}

function cell(id: SecurityCellId, status: SecurityCellStatus, detail: string): SecurityCellResult {
  return { id, status, detail: detail.slice(0, 300) };
}

interface IsolatedCandidateSeams {
  readonly store: CandidateControlStore;
  readonly envelopes: CandidateEnvelopeStore;
  readonly verifyObject: (ref: ImmutableObjectRef) => Promise<void>;
  readonly payloadPrefix: string;
  readonly envelopePrefix: string;
  readonly cleanup: () => Promise<void>;
}

function isolatedCandidateSeams(input: {
  storage: DurableObjectStorage;
  bucket: R2Bucket;
  controlKey: string;
  payloadPrefix: string;
  envelopePrefix: string;
}): IsolatedCandidateSeams {
  const { storage, bucket, controlKey, payloadPrefix, envelopePrefix } = input;
  const read = async (): Promise<CandidateControlStateV1> => {
    const stored = await storage.get<unknown>(controlKey);
    if (stored === undefined) return { version: 1, head: null, operation: null };
    return v.parse(CandidateControlStateV1Schema, stored);
  };
  const store: CandidateControlStore = {
    read,
    update: async (apply) => await storage.transaction(async (txn) => {
      const s = await txn.get<unknown>(controlKey);
      const current: CandidateControlStateV1 = s === undefined
        ? { version: 1, head: null, operation: null }
        : v.parse(CandidateControlStateV1Schema, s);
      const update = apply(current);
      if (update.next !== null) {
        await txn.put(controlKey, v.parse(CandidateControlStateV1Schema, update.next));
      }
      return update.result;
    }),
    clear: async () => {
      await storage.delete(controlKey);
    },
  };
  const envelopes: CandidateEnvelopeStore = {
    write: async (envelope, rootEnvelopeId) => {
      const key = `${envelopePrefix}/${rootEnvelopeId}.json`;
      const existing = await bucket.get(key);
      if (existing !== null) {
        parseEnvelopeBytes(new Uint8Array(await existing.arrayBuffer()), rootEnvelopeId);
        return;
      }
      await bucket.put(key, envelopeBytes(envelope));
      const committed = await bucket.get(key);
      if (committed === null) throw new Error(`security envelope write did not verify: ${rootEnvelopeId}`);
      parseEnvelopeBytes(new Uint8Array(await committed.arrayBuffer()), rootEnvelopeId);
    },
    read: async (rootEnvelopeId) => {
      const object = await bucket.get(`${envelopePrefix}/${rootEnvelopeId}.json`);
      if (object === null) throw new Error(`security envelope is absent: ${rootEnvelopeId}`);
      return parseEnvelopeBytes(new Uint8Array(await object.arrayBuffer()), rootEnvelopeId);
    },
  };
  const verifyObject = async (ref: ImmutableObjectRef): Promise<void> => {
    // Same rule as the product verifyObject (devbox.ts): key, size, sha when
    // the store reports one, and a store version must exist.
    const key = `${payloadPrefix}/${ref.key}`;
    const object = await bucket.head(key);
    if (object === null) throw new Error(`security object is absent: ${ref.key}`);
    const sha256 = object.checksums.sha256;
    const checksum = sha256 === undefined
      ? undefined
      : [...new Uint8Array(sha256)].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (
      object.key !== key
      || String(object.size) !== ref.byteLength
      || (checksum !== undefined && checksum !== ref.sha256)
      || object.version.length === 0
    ) {
      throw new Error(`security object metadata does not match immutable ref: ${ref.key}`);
    }
  };
  return {
    store, envelopes, verifyObject, payloadPrefix, envelopePrefix,
    cleanup: async () => {
      await store.clear();
    },
  };
}

async function purgePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  for (;;) {
    const page = await bucket.list({ prefix, limit: 100 });
    const keys = page.objects.map((o) => o.key);
    if (keys.length === 0) return;
    await bucket.delete(keys);
    if (page.truncated !== true) return;
  }
}

async function listKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix, cursor, limit: 100 });
    for (const o of page.objects) keys.push(o.key);
    if (page.truncated !== true || page.cursor === undefined) return keys;
    cursor = page.cursor;
  }
}

/** Minimal draft that binds (or misbinds) an operation; refs are arbitrary. */
function draftForSync(operation: {
  operationId: string;
  attemptId: string;
  epoch: string;
  baseRevision: string;
  expectedParent: string | null;
}, overrides?: {
  epoch?: string;
  attemptId?: string;
  operationId?: string;
  expectedParent?: string | null;
}): CandidatePublicationDraft {
  const sha = dummySha(`${operation.operationId}:${overrides?.epoch ?? operation.epoch}`);
  const ref = (key: string): ImmutableObjectRef => ({ key, byteLength: '1', sha256: sha });
  const captureId = overrides?.operationId ?? operation.operationId;
  return v.parse(CandidatePublicationDraftSchema, {
    operationId: overrides?.operationId ?? operation.operationId,
    attemptId: overrides?.attemptId ?? operation.attemptId,
    format: 'bounded-layers/v1',
    expectedParentRootId: overrides?.expectedParent !== undefined ? overrides.expectedParent : operation.expectedParent,
    capturedCut: {
      captureId,
      epoch: overrides?.epoch ?? operation.epoch,
      baseRevision: operation.baseRevision,
      cut: '1',
      stableStageHandle: 'security-stage',
      manifestSha256: sha,
    },
    generation: '1',
    root: ref('obj/root'),
    rootReceipt: {
      operationId: overrides?.operationId ?? operation.operationId,
      attemptId: overrides?.attemptId ?? operation.attemptId,
      key: 'obj/root', byteLength: '1', sha256: sha, etag: 'security-etag', verified: true,
    },
    closure: [],
    closureObject: ref('obj/closure'),
    closureReceipt: {
      operationId: overrides?.operationId ?? operation.operationId,
      attemptId: overrides?.attemptId ?? operation.attemptId,
      key: 'obj/closure', byteLength: '1', sha256: sha, etag: 'security-etag', verified: true,
    },
    dependencyReceipts: [],
  });
}

async function f7Candidate(input: {
  storage: DurableObjectStorage;
  bucket: R2Bucket;
  boxId: string;
  nonce: string;
  securityPrefix: string;
  cleanupErrors: string[];
}): Promise<SecurityCellResult> {
  const controlKey = `__security:candidate:${input.nonce}`;
  const payloadPrefix = `${input.securityPrefix}payload`;
  const envelopePrefix = `${input.securityPrefix}envelopes`;
  const seams = isolatedCandidateSeams({
    storage: input.storage, bucket: input.bucket, controlKey, payloadPrefix, envelopePrefix,
  });
  const cleanupSeams = async (): Promise<void> => {
    try {
      await seams.cleanup();
    } catch (error) {
      input.cleanupErrors.push(`isolated control cleanup: ${describeThrown({ cause: error })}`);
    }
  };
  try {
    const bootA = `sec-boot-a-${input.nonce}`.slice(0, 64);
    const begun = await beginCandidateOperation({
      kind: 'tick', bootId: bootA, store: seams.store, envelopes: seams.envelopes, verifyObject: seams.verifyObject,
    });
    const active = begun.operation;
    if (active === null || active.phase !== 'transferring') {
      return cell('F7', 'unable', 'candidate begin produced no transferring operation to fence');
    }
    // A new boot fences the old one: the epoch bumps and the attempt rotates.
    const redriven = await redriveCandidateOperation({ active, store: seams.store, envelopes: seams.envelopes });
    const fenced = redriven.operation;
    if (fenced === null || fenced.phase !== 'transferring') {
      return cell('F7', 'unable', 'candidate redrive produced no transferring operation to test against');
    }
    if (fenced.epoch === active.epoch) {
      return cell('F7', 'accepted', 'redrive did not advance the writer epoch, so a stale writer is indistinguishable');
    }
    // Replay the OLD writer's draft against the fenced operation. Production
    // finalize must refuse: the draft's epoch no longer binds the operation.
    const stale = draftForSync({
      operationId: active.operationId,
      attemptId: active.attemptId,
      epoch: active.epoch,
      baseRevision: active.baseRevision,
      expectedParent: active.expectedParent,
    });
    try {
      await finalizeCandidateOperation({
        draft: stale, boxId: input.boxId, store: seams.store, envelopes: seams.envelopes, verifyObject: seams.verifyObject,
      });
    } catch (error) {
      if (error instanceof CandidateOperationRefused || error instanceof StaleParentRefused) {
        return cell('F7', 'refused', `stale epoch ${active.epoch} refused after fence to ${fenced.epoch}: ${describeThrown({ cause: error })}`);
      }
      // Closure/receipt failures also prove the stale draft never published,
      // but they are the wrong gate: report unable rather than claim the epoch
      // fence fired.
      return cell('F7', 'unable', `stale draft failed outside the epoch fence: ${describeThrown({ cause: error })}`);
    }
    return cell('F7', 'accepted', `stale epoch ${active.epoch} was accepted after fence to ${fenced.epoch}`);
  } finally {
    await cleanupSeams();
  }
}

async function f7Chain(input: {
  storage: DurableObjectStorage;
  nonce: string;
  cleanupErrors: string[];
}): Promise<SecurityCellResult> {
  // An isolated rev-gated record with the production compare: read, compare,
  // put in one transaction, throwing ChainRecordAdvanced on a stale rev —
  // the same rule SnapshotChainPorts.writeState enforces on the live row.
  const key = `__security:chain:${input.nonce}`;
  const read = async (): Promise<{ rev: number } | null> =>
    (await input.storage.get<{ rev: number }>(key)) ?? null;
  const deleteIsolatedKey = async (): Promise<void> => {
    try {
      await input.storage.delete(key);
    } catch (error) {
      input.cleanupErrors.push(`isolated chain record cleanup: ${describeThrown({ cause: error })}`);
    }
  };
  await input.storage.put(key, { rev: 7 });
  const observed = await read();
  if (observed === null) {
    await deleteIsolatedKey();
    return cell('F7', 'unable', 'isolated chain record did not persist');
  }
  // A concurrent writer advances the record first.
  await input.storage.put(key, { rev: observed.rev + 1 });
  try {
    await input.storage.transaction(async (txn) => {
      const stored = ((await txn.get<{ rev: number }>(key))?.rev) ?? null;
      if (stored !== observed.rev) throw new ChainRecordAdvanced(observed.rev, stored);
      await txn.put(key, { rev: observed.rev + 1 });
    });
  } catch (error) {
    if (error instanceof ChainRecordAdvanced) {
      const current = await read();
      await deleteIsolatedKey();
      if (current?.rev !== observed.rev + 1) {
        return cell('F7', 'unable', 'stale chain write refused but the record did not hold the winner');
      }
      return cell('F7', 'refused', `stale rev ${observed.rev} refused after advance to ${current?.rev}: ${describeThrown({ cause: error })}`);
    }
    await deleteIsolatedKey();
    return cell('F7', 'unable', `stale chain write failed outside the rev fence: ${describeThrown({ cause: error })}`);
  }
  await deleteIsolatedKey();
  return cell('F7', 'accepted', `stale rev ${observed.rev} overwrote the advanced record`);
}

const HOSTILE_PATHS = ['../escape', '/absolute', 'a//b', 'a/./b', '', 'trailing/', 'a\x00b', 'a/../b'];

async function f10Candidate(input: {
  bucket: R2Bucket;
  securityPrefix: string;
}): Promise<SecurityCellResult> {
  // 1. Hostile paths: the exact predicate every candidate builder gates on.
  const acceptedPaths = HOSTILE_PATHS.filter((p) => isCanonicalJournalPath(p));
  if (acceptedPaths.length > 0) {
    return cell('F10', 'accepted', `${acceptedPaths.length} hostile path(s) passed the canonical gate`);
  }
  // The throwing surface (hostile-path in every candidate builder) gates on
  // this same predicate, so a hostile passing here is a vulnerability.
  if (isCanonicalJournalPath('../escape')) {
    return cell('F10', 'accepted', 'hostile path passed the canonical gate');
  }
  // 2. Envelope hash binding: a tampered body must not parse at its old id.
  const sha = dummySha('f10-envelope');
  const envelope: RootEnvelopeV1 = {
    version: 1,
    format: 'bounded-layers/v1',
    boxId: 'security-box',
    epoch: '3',
    generation: '1',
    parentRootId: null,
    cut: {
      captureId: 'security-cut', epoch: '3', baseRevision: '0', cut: '1',
      stableStageHandle: 'security-stage', manifestSha256: sha,
    },
    rootObject: { key: 'obj/root', byteLength: '1', sha256: sha },
    closure: [],
    closureObject: { key: 'obj/closure', byteLength: '1', sha256: sha },
  };
  const id = envelopeIdOf(envelope);
  const bytes = envelopeBytes(envelope);
  const tampered = new Uint8Array(bytes);
  tampered[tampered.length - 2] = tampered[tampered.length - 2] === 0x31 ? 0x32 : 0x31;
  try {
    parseEnvelopeBytes(tampered, id);
    return cell('F10', 'accepted', 'tampered envelope bytes parsed at the original digest');
  } catch (error) {
    // Refused — the production binding held; the reason travels in the verdict.
    return await f10CandidateObjects(input, sha, `tampered envelope refused: ${describeThrown({ cause: error })}`);
  }
}

async function f10CandidateObjects(input: {
  bucket: R2Bucket;
  securityPrefix: string;
}, sha: string, envelopeRefusal: string): Promise<SecurityCellResult> {
  // 3. Object metadata binding over the live bucket under the isolated
  // prefix, with the product's own rule (key, size, sha when the store
  // reports one, non-empty version). Absent means UNKNOWN — the comparison
  // is skipped and the size check stands — so a wrong sha with the right
  // size is decisive only when the store reports a checksum; the tampered
  // envelope above already proves digest binding unconditionally.
  const payloadKey = `${input.securityPrefix}payload/${boundedObjectKey(sha)}`;
  await input.bucket.put(payloadKey, new Uint8Array([1, 2, 3]));
  const head = await input.bucket.head(payloadKey);
  if (head === null) return cell('F10', 'unable', 'isolated object did not persist for the hash probe');
  const sha256 = head.checksums.sha256;
  const checksum = sha256 === undefined
    ? undefined
    : [...new Uint8Array(sha256)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const matches = (ref: ImmutableObjectRef): boolean => head.key === `${input.securityPrefix}payload/${ref.key}`
    && String(head.size) === ref.byteLength
    && (checksum === undefined || checksum === ref.sha256)
    && head.version.length > 0;
  const soundRef: ImmutableObjectRef = { key: boundedObjectKey(sha), byteLength: '3', sha256: checksum ?? sha };
  if (!matches(soundRef)) return cell('F10', 'unable', 'sound object failed its own metadata rule');
  const wrongSize: ImmutableObjectRef = { key: boundedObjectKey(sha), byteLength: '999', sha256: soundRef.sha256 };
  if (matches(wrongSize)) return cell('F10', 'accepted', 'object with a mismatched size passed the metadata rule');
  if (checksum !== undefined) {
    const wrongSha: ImmutableObjectRef = { key: boundedObjectKey(sha), byteLength: '3', sha256: dummySha('wrong') };
    if (matches(wrongSha)) return cell('F10', 'accepted', 'object with a mismatched digest passed the metadata rule');
  }
  return cell('F10', 'refused', `hostile paths (${HOSTILE_PATHS.length}) refused; ${envelopeRefusal}; mismatched metadata refused`);
}

async function f10Chain(): Promise<SecurityCellResult> {
  // Hostile chain ids: the predicate rejects them and the key builders
  // refuse before a key exists (both gate on the same UUID rule). Each
  // refusal reason is recorded; the count proves the gate fired per sample.
  const hostileIds = ['../escape', '', 'not-a-uuid', 'a/b', 'x'.repeat(200)];
  const root = 'boxes/unit-test/backups';
  const refusals: string[] = [];
  for (const id of hostileIds) {
    if (isChainId(id)) return cell('F10', 'accepted', 'hostile chain id passed the UUID gate');
    try {
      baseObjectKey(root, id);
      return cell('F10', 'accepted', 'hostile chain id built a storage key');
    } catch (error) {
      refusals.push(describeThrown({ cause: error }));
    }
  }
  // Same-length corruption: the digest/version rule must refuse.
  const declared: ChainLayer = {
    bytes: 1024, digest: dummySha('declared'), objectVersion: 'version-a',
  };
  const sameLengthOtherDigest: ChainLayer = {
    bytes: 1024, digest: dummySha('stored'), objectVersion: 'version-b',
  };
  const failure = layerIntegrityFailure({ declared, stored: sameLengthOtherDigest, label: 'delta' });
  if (failure === null) return cell('F10', 'accepted', 'same-length replacement with a different digest passed integrity');
  // Soundness: an identical layer must NOT refuse (else the gate above is vacuous).
  const sound = layerIntegrityFailure({ declared, stored: { ...declared }, label: 'delta' });
  if (sound !== null) return cell('F10', 'unable', `identical layer refused integrity: ${sound.slice(0, 120)}`);
  return cell('F10', 'refused', `hostile ids (${refusals.length}) refused; same-length digest mismatch refused`);
}

async function f11Candidate(input: {
  bucket: R2Bucket;
  storage: DurableObjectStorage;
  boxId: string;
  boxPrefix: string;
  nonce: string;
  securityPrefix: string;
  cleanupErrors: string[];
}): Promise<{ result: SecurityCellResult; prefixEscapes: number; capabilityEscapesOrReplays: number }> {
  let prefixEscapes = 0;
  let capabilityEscapesOrReplays = 0;
  const prefixRefusals: string[] = [];
  // Prefix: escape attempts through the product key builders must stay inside
  // the box prefix or throw before a key exists.
  const escapeAttempts: Array<() => string> = [
    () => `${input.boxPrefix}${boundedObjectKey(dummySha('escape'))}`,
    () => {
      const paths = candidateStorePaths(input.boxPrefix, 'bounded-layers');
      return `${paths.payloadPrefix}/${boundedObjectKey(dummySha('escape'))}`;
    },
    () => {
      const root = chainStoreRoot(input.boxPrefix);
      return baseObjectKey(root, '123e4567-e89b-12d3-a456-426614174000');
    },
  ];
  for (const attempt of escapeAttempts) {
    try {
      const key = attempt();
      if (!key.startsWith(input.boxPrefix)) prefixEscapes += 1;
    } catch (error) {
      prefixRefusals.push(describeThrown({ cause: error }));
    }
  }
  // A hostile key builder must throw rather than emit an escaping key.
  try {
    baseObjectKey(chainStoreRoot(input.boxPrefix), '../escape');
    prefixEscapes += 1;
  } catch (error) {
    prefixRefusals.push(describeThrown({ cause: error }));
  }
  // Authorization + replay through the real finalize binding on an isolated
  // record: a receipt/draft from another operation must not bind this one, and
  // a superseded attempt must stay fenced after a redrive.
  const controlKey = `__security:capability:${input.nonce}`;
  const payloadPrefix = `${input.securityPrefix}cap-payload`;
  const envelopePrefix = `${input.securityPrefix}cap-envelopes`;
  const seams = isolatedCandidateSeams({
    storage: input.storage, bucket: input.bucket, controlKey, payloadPrefix, envelopePrefix,
  });
  const cleanupSeams = async (): Promise<void> => {
    try {
      await seams.cleanup();
    } catch (error) {
      input.cleanupErrors.push(`isolated capability control cleanup: ${describeThrown({ cause: error })}`);
    }
  };
  try {
    const bootA = `sec-cap-a-${input.nonce}`.slice(0, 64);
    const begun = await beginCandidateOperation({
      kind: 'tick', bootId: bootA, store: seams.store, envelopes: seams.envelopes, verifyObject: seams.verifyObject,
    });
    const active = begun.operation;
    if (active === null || active.phase !== 'transferring') {
      return {
        result: cell('F11', 'unable', 'capability begin produced no transferring operation'),
        prefixEscapes, capabilityEscapesOrReplays,
      };
    }
    // Foreign receipt: same shape, another operation's identity.
    const foreign = draftForSync(
      {
        operationId: active.operationId, attemptId: active.attemptId,
        epoch: active.epoch, baseRevision: active.baseRevision, expectedParent: active.expectedParent,
      },
      { operationId: `foreign-${input.nonce}`.slice(0, 32) },
    );
    try {
      await finalizeCandidateOperation({
        draft: foreign, boxId: input.boxId, store: seams.store, envelopes: seams.envelopes, verifyObject: seams.verifyObject,
      });
      capabilityEscapesOrReplays += 1;
    } catch (error) {
      if (!(error instanceof CandidateOperationRefused) && !(error instanceof StaleParentRefused)) {
        // Wrong-gate failure: do not count as an escape, but do not claim the
        // capability fence fired either.
        return {
          result: cell('F11', 'unable', `foreign draft failed outside the capability fence: ${describeThrown({ cause: error })}`),
          prefixEscapes, capabilityEscapesOrReplays,
        };
      }
    }
    // Replay: fence the first attempt, then replay its draft.
    const redriven = await redriveCandidateOperation({ active, store: seams.store, envelopes: seams.envelopes });
    const fenced = redriven.operation;
    if (fenced !== null && fenced.phase === 'transferring' && fenced.attemptId !== active.attemptId) {
      const replay = draftForSync({
        operationId: active.operationId, attemptId: active.attemptId,
        epoch: active.epoch, baseRevision: active.baseRevision, expectedParent: active.expectedParent,
      });
      try {
        await finalizeCandidateOperation({
          draft: replay, boxId: input.boxId, store: seams.store, envelopes: seams.envelopes, verifyObject: seams.verifyObject,
        });
        capabilityEscapesOrReplays += 1;
      } catch (error) {
        if (!(error instanceof CandidateOperationRefused) && !(error instanceof StaleParentRefused)) {
          return {
            result: cell('F11', 'unable', `replayed draft failed outside the capability fence: ${describeThrown({ cause: error })}`),
            prefixEscapes, capabilityEscapesOrReplays,
          };
        }
      }
    }
  } finally {
    await cleanupSeams();
  }
  // The cell's own writes must all sit under the isolated prefix: anything
  // else is an escape this surface caused.
  const keys = await listKeys(input.bucket, input.securityPrefix);
  for (const key of keys) {
    if (!key.startsWith(input.securityPrefix)) prefixEscapes += 1;
  }
  if (prefixEscapes > 0 || capabilityEscapesOrReplays > 0) {
    return {
      result: cell('F11', 'accepted', `${prefixEscapes} prefix escape(s), ${capabilityEscapesOrReplays} capability escape(s)/replay(s) accepted`),
      prefixEscapes, capabilityEscapesOrReplays,
    };
  }
  return {
    result: cell('F11', 'refused', `prefix builders refused (${prefixRefusals.length}); foreign and replayed drafts refused; ${keys.length} isolated object(s) all inside the namespace`),
    prefixEscapes, capabilityEscapesOrReplays,
  };
}

async function f11Chain(input: {
  storage: DurableObjectStorage;
  bucket: R2Bucket;
  boxPrefix: string;
  nonce: string;
  securityPrefix: string;
  cleanupErrors: string[];
}): Promise<{ result: SecurityCellResult; prefixEscapes: number; capabilityEscapesOrReplays: number }> {
  let prefixEscapes = 0;
  const capabilityEscapesOrReplays = 0;
  const prefixRefusals: string[] = [];
  // Prefix: hostile ids throw before a key exists; sound keys stay inside.
  try {
    baseObjectKey(chainStoreRoot(input.boxPrefix), '../escape');
    prefixEscapes += 1;
  } catch (error) {
    prefixRefusals.push(describeThrown({ cause: error }));
  }
  try {
    deltaObjectKey(chainStoreRoot(input.boxPrefix), '/absolute');
    prefixEscapes += 1;
  } catch (error) {
    prefixRefusals.push(describeThrown({ cause: error }));
  }
  const soundKey = baseObjectKey(chainStoreRoot(input.boxPrefix), '123e4567-e89b-12d3-a456-426614174000');
  if (!soundKey.startsWith(input.boxPrefix)) prefixEscapes += 1;
  // Replay fence: a stale rev write must throw ChainRecordAdvanced. Anything
  // else is not a refusal — it is a probe failure, reported as unable.
  const key = `__security:chain-replay:${input.nonce}`;
  await input.storage.put(key, { rev: 11 });
  const observed = (await input.storage.get<{ rev: number }>(key))?.rev ?? null;
  await input.storage.put(key, { rev: 12 });
  let replayRefused = false;
  let replayOutsideFence: string | null = null;
  try {
    await input.storage.transaction(async (txn) => {
      const stored = ((await txn.get<{ rev: number }>(key))?.rev) ?? null;
      if (stored !== observed) throw new ChainRecordAdvanced(observed, stored);
      await txn.put(key, { rev: 13 });
    });
  } catch (error) {
    if (error instanceof ChainRecordAdvanced) {
      replayRefused = true;
    } else {
      replayOutsideFence = describeThrown({ cause: error });
    }
  } finally {
    try {
      await input.storage.delete(key);
    } catch (error) {
      input.cleanupErrors.push(`isolated replay record cleanup: ${describeThrown({ cause: error })}`);
    }
  }
  if (replayOutsideFence !== null) {
    return {
      result: cell('F11', 'unable', `replay probe failed outside the rev fence: ${replayOutsideFence}`),
      prefixEscapes, capabilityEscapesOrReplays,
    };
  }
  if (!replayRefused) {
    return {
      result: cell('F11', 'accepted', 'stale chain rev replay overwrote the advanced record'),
      prefixEscapes, capabilityEscapesOrReplays: 1,
    };
  }
  const keys = await listKeys(input.bucket, input.securityPrefix);
  for (const k of keys) {
    if (!k.startsWith(input.securityPrefix)) prefixEscapes += 1;
  }
  if (prefixEscapes > 0) {
    return {
      result: cell('F11', 'accepted', `${prefixEscapes} prefix escape(s) accepted`),
      prefixEscapes, capabilityEscapesOrReplays,
    };
  }
  return {
    result: cell('F11', 'refused', `hostile chain ids refused (${prefixRefusals.length}); stale rev replay refused; ${keys.length} isolated object(s) inside the namespace`),
    prefixEscapes, capabilityEscapesOrReplays,
  };
}

export async function runBenchSecurityCells(input: {
  strategy: string;
  boxPrefix: string;
  nonce: string;
  bucket: R2Bucket;
  storage: DurableObjectStorage;
  boxId: string;
  /** Live fixture secret, held transiently for the F12 scan and never echoed. */
  fixtureSecret: string;
  /** Non-token env values to scan for leaks (name + value pairs). */
  envValues: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}): Promise<SecurityCellsObservation> {
  const strategy = input.strategy;
  const securityPrefix = securityPrefixFor(input.boxPrefix, input.nonce);
  const cleanupErrors: string[] = [];

  if (strategy !== 'snapshot-chain' && strategy !== 'bounded-layers' && strategy !== 'merkle-pack') {
    const reason = `${strategy} publishes no epoch, envelope, or grant to attack: F7/F10/F11 are unable rather than passing on zeros`;
    const f12early = await runF12({
      bucket: input.bucket, securityPrefix,
      fixtureSecret: input.fixtureSecret, envValues: input.envValues, probeText: reason,
    });
    return {
      strategy, completed: false,
      cells: [
        cell('F7', 'unable', reason),
        cell('F10', 'unable', reason),
        cell('F11', 'unable', reason),
        f12early,
      ],
      staleWriterAccepted: false, hostileMetadataAccepted: false,
      prefixEscapes: 0, capabilityEscapesOrReplays: 0,
      credentialLeaks: f12early.status === 'accepted' ? ['F12: live fixture secret present in a scanned surface'] : [],
      cleanupErrors,
    };
  }

  const isCandidate = strategy === 'bounded-layers' || strategy === 'merkle-pack';

  const f7 = isCandidate
    ? await f7Candidate({
      storage: input.storage, bucket: input.bucket, boxId: input.boxId,
      nonce: input.nonce, securityPrefix, cleanupErrors,
    })
    : await f7Chain({ storage: input.storage, nonce: input.nonce, cleanupErrors });

  const f10 = isCandidate
    ? await f10Candidate({ bucket: input.bucket, securityPrefix })
    : await f10Chain();

  const f11 = isCandidate
    ? await f11Candidate({
      bucket: input.bucket, storage: input.storage, boxId: input.boxId,
      boxPrefix: input.boxPrefix, nonce: input.nonce, securityPrefix, cleanupErrors,
    })
    : await f11Chain({
      storage: input.storage, bucket: input.bucket,
      boxPrefix: input.boxPrefix, nonce: input.nonce, securityPrefix, cleanupErrors,
    });

  const probeText = [f7.detail, f10.detail, f11.result.detail].join('\n');
  const f12 = await runF12({
    bucket: input.bucket, securityPrefix,
    fixtureSecret: input.fixtureSecret, envValues: input.envValues, probeText,
  });

  const cells = [f7, f10, f11.result, f12] as const;
  const staleWriterAccepted = f7.status === 'accepted';
  const hostileMetadataAccepted = f10.status === 'accepted';
  const prefixEscapes = f11.prefixEscapes;
  const capabilityEscapesOrReplays = f11.capabilityEscapesOrReplays;
  const credentialLeaks: string[] = [];
  if (f12.status === 'accepted') credentialLeaks.push('F12: live fixture secret present in a scanned surface');
  const completed = cells.every((c) => c.status === 'refused')
    && !staleWriterAccepted && !hostileMetadataAccepted
    && prefixEscapes === 0 && capabilityEscapesOrReplays === 0
    && credentialLeaks.length === 0;
  // `completed` is true only when every cell RAN and REFUSED its attack. An
  // `unable` cell is not a refusal: it leaves completed false so G4 refuses
  // rather than admitting on untested zeros.

  try {
    await purgePrefix(input.bucket, securityPrefix);
  } catch (error) {
    cleanupErrors.push(`isolated prefix purge: ${describeThrown({ cause: error })}`);
  }

  return {
    strategy, completed, cells: [...cells],
    staleWriterAccepted, hostileMetadataAccepted,
    prefixEscapes, capabilityEscapesOrReplays, credentialLeaks, cleanupErrors,
  };
}

async function runF12(input: {
  bucket: R2Bucket;
  securityPrefix: string;
  fixtureSecret: string;
  envValues: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  probeText: string;
}): Promise<SecurityCellResult> {
  const { fixtureSecret } = input;
  if (fixtureSecret.length === 0) {
    return cell('F12', 'unable', 'no live fixture secret was supplied to scan for');
  }
  // Surfaces: the cells' own detail text, every non-token env value, and the
  // isolated store bytes written above. Each hit reports its surface only.
  const hits: string[] = [];
  if (input.probeText.length > 0 && input.probeText.includes(fixtureSecret)) {
    hits.push('security cell details');
  }
  for (const env of input.envValues) {
    if (env.value.length > 0 && env.value.includes(fixtureSecret)) hits.push(`env ${env.name}`);
  }
  try {
    const keys = await listKeys(input.bucket, input.securityPrefix);
    for (const key of keys.slice(0, 20)) {
      const object = await input.bucket.get(key);
      if (object === null) continue;
      const text = textDecoder.decode(new Uint8Array(await object.arrayBuffer()).slice(0, 4096));
      if (text.includes(fixtureSecret)) {
        hits.push('isolated store object');
        break;
      }
    }
    if (input.securityPrefix.includes(fixtureSecret)) hits.push('isolated key prefix');
  } catch (error) {
    return cell('F12', 'unable', `isolated store scan failed: ${describeThrown({ cause: error })}`);
  }
  if (hits.length > 0) return cell('F12', 'accepted', `live fixture secret present in ${hits.length} scanned surface(s)`);
  return cell('F12', 'refused', 'live fixture secret absent from details, env and isolated store bytes');
}

export const SecurityCellsObservationSchema = v.looseObject({
  strategy: v.string(),
  completed: v.boolean(),
  cells: v.array(v.looseObject({
    id: v.picklist(['F7', 'F10', 'F11', 'F12']),
    status: v.picklist(['refused', 'accepted', 'unable']),
    detail: v.string(),
  })),
  staleWriterAccepted: v.boolean(),
  hostileMetadataAccepted: v.boolean(),
  prefixEscapes: v.number(),
  capabilityEscapesOrReplays: v.number(),
  credentialLeaks: v.array(v.string()),
  cleanupErrors: v.array(v.string()),
});
