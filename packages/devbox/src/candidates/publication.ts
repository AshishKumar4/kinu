/**
 * The shared durability boundary every durable-root candidate publishes
 * through. A candidate owns its format's bytes; this module owns everything
 * else the review demanded:
 *
 *   - only an audit-proven capture (an AuditedCapture) can appear in a plan;
 *   - the plan names its expected parent, stages dependencies before the root,
 *     and declares a complete GC closure;
 *   - the publisher writes the operation intent before its first external
 *     await, verifies every receipt against the exact intent, CAS-publishes
 *     the head against the expected parent, and closes with a complete mark;
 *   - a range re-drive request is an already-validated intent carrying its
 *     exact expected digest — payload bodies never travel through a
 *     coordinator.
 *
 * No candidate algorithm lives here: `format` is just a DURABLE_ROOT_FORMATS
 * member and dependency/root bytes are opaque.
 */

import * as v from 'valibot';

import { sha256Hex } from '../cas/hash';
import { requireAuditedCapture } from '../capture/model';
import type { AuditedCapture } from '../capture/model';

import type { Sha256Hex } from '../cas/types';
import {
  CapturedCutSchema,
  DURABLE_ROOT_FORMATS,
  HeadPointerV1Schema,
  ImmutableObjectRefSchema,
  ObjectRangeRefSchema,
  ObjectReceiptSchema,
  OperationRecordSchema,
  RangeReadIntentSchema,
  RootEnvelopeV1Schema,
  RootEnvelopeV2Schema,
  UploadIntentSchema,
} from '../durability/contracts';
import type {
  CapturedCut,
  HeadPointerV1,
  ImmutableObjectRef,
  ObjectRangeRef,
  ObjectReceipt,
  OperationRecord,
  PayloadGrant,
  RangeReadIntent,
  RootEnvelopeV1,
  RootEnvelopeV2,
  UploadIntent,
} from '../durability/contracts';

/** An object key, as the store bounds one. */
const ObjectKeySchema = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));
export type DurableRootFormat = (typeof DURABLE_ROOT_FORMATS)[number];

// ── the plan ─────────────────────────────────────────────────────────────────

const candidateObjectSource: unique symbol = Symbol('candidateObjectSource');

/** A sealed object source; plans retain a stream handle, never generation bytes. */
export interface CandidateObjectSource {
  readonly [candidateObjectSource]: true;
  open(): ReadableStream<Uint8Array>;
}

interface StagedCandidateObjectState {
  readonly ref: ImmutableObjectRef;
  readonly source: CandidateObjectSource;
}

const stagedCandidateObjects = new WeakMap<StagedCandidateObject, StagedCandidateObjectState>();

/** An immutable object accepted by the publication boundary after sink staging. */
export class StagedCandidateObject {
  readonly ref: ImmutableObjectRef;

  private constructor(ref: ImmutableObjectRef, source: CandidateObjectSource) {
    this.ref = snapshotObjectRef(ref);
    stagedCandidateObjects.set(this, Object.freeze({ ref: this.ref, source }));
    Object.freeze(this);
  }

  static create(key: string, bytes: Uint8Array, source: CandidateObjectSource): StagedCandidateObject {
    return new StagedCandidateObject(v.parse(ImmutableObjectRefSchema, {
      key,
      byteLength: String(bytes.byteLength),
      sha256: sha256Hex(bytes),
    }), source);
  }

  static fromRef(ref: ImmutableObjectRef, source: CandidateObjectSource): StagedCandidateObject {
    return new StagedCandidateObject(ref, source);
  }
}

/** Each builder stages its completed objects incrementally through this seam. */
export interface CandidateObjectSink {
  stage(key: string, bytes: Uint8Array): Promise<StagedCandidateObject>;
}

function memorySource(bytes: Uint8Array): CandidateObjectSource {
  return {
    [candidateObjectSource]: true,
    open: () => new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

/** Copied in-memory staging for behavior tests. */
export class MemoryCandidateObjectSink implements CandidateObjectSink {
  async stage(key: string, bytes: Uint8Array): Promise<StagedCandidateObject> {
    const sealed = bytes.slice();
    return StagedCandidateObject.create(key, sealed, memorySource(sealed));
  }
}

/** File-backed staging supplied by the container adapter. */
export class FileCandidateObjectSink implements CandidateObjectSink {
  constructor(private readonly files: {
    write(key: string, sealedBytes: Uint8Array): Promise<void>;
    open(key: string): ReadableStream<Uint8Array>;
  }) {}

  async stage(key: string, bytes: Uint8Array): Promise<StagedCandidateObject> {
    const sealed = bytes.slice();
    const ref = v.parse(ImmutableObjectRefSchema, {
      key,
      byteLength: String(sealed.byteLength),
      sha256: sha256Hex(sealed),
    });
    await this.files.write(key, sealed);
    return StagedCandidateObject.fromRef(ref, {
      [candidateObjectSource]: true,
      open: () => this.files.open(key),
    });
  }
}

function stagedCandidateObjectState(object: StagedCandidateObject): StagedCandidateObjectState {
  const state = stagedCandidateObjects.get(object);
  if (state === undefined) throw new Error('candidate object was not staged by a CandidateObjectSink');
  return state;
}

/** Direct transfer view for a payload adapter. It never materializes a body. */
export function streamStagedCandidateObject(object: StagedCandidateObject): ReadableStream<Uint8Array> {
  return stagedCandidateObjectState(object).source.open();
}

/** Behavior-test helper. Production code transfers the stream directly. */
export async function readStagedCandidateObjectForTest(object: StagedCandidateObject): Promise<Uint8Array> {
  const reader = streamStagedCandidateObject(object).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    size += next.value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

interface PublicationPlanState {
  readonly capturedCut: CapturedCut;
  readonly generation: string;
  readonly dependencies: readonly StagedCandidateObject[];
  readonly root: StagedCandidateObject;
  /** Canonically sorted refs this publication proves present: its fresh
   *  objects and the reused ones the format names. The envelope carries it. */
  readonly closure: readonly ImmutableObjectRef[];
  readonly movedBytes: number;
}

const publicationPlans = new WeakMap<CandidatePublicationPlan, PublicationPlanState>();

export class CandidatePublicationPlan {
  readonly format: DurableRootFormat;
  readonly expectedParentRootId: Sha256Hex | null;

  private constructor(format: DurableRootFormat, expectedParentRootId: Sha256Hex | null, state: PublicationPlanState) {
    this.format = format;
    this.expectedParentRootId = expectedParentRootId;
    publicationPlans.set(this, state);
    Object.freeze(this);
  }

  get capturedCut(): CapturedCut {
    return Object.freeze({ ...publicationPlanState(this).capturedCut });
  }

  get generation(): string {
    return publicationPlanState(this).generation;
  }

  get dependencies(): readonly StagedCandidateObject[] {
    return publicationPlanState(this).dependencies;
  }

  get root(): StagedCandidateObject {
    return publicationPlanState(this).root;
  }

  get closure(): readonly ImmutableObjectRef[] {
    return publicationPlanState(this).closure;
  }

  static async create(input: {
    readonly format: DurableRootFormat;
    readonly expectedParentRootId: Sha256Hex | null;
    readonly capture: AuditedCapture;
    readonly sink: CandidateObjectSink;
    readonly dependencies: readonly StagedCandidateObject[];
    readonly root: StagedCandidateObject;
    /** Authenticated parent closure refs that the child root still reaches. */
    readonly reused?: readonly ImmutableObjectRef[];
  }): Promise<CandidatePublicationPlan> {
    const capture = requireAuditedCapture(input.capture);
    const freshByKey = new Map<string, StagedCandidateObject>();
    for (const object of [...input.dependencies, input.root]) {
      const ref = stagedCandidateObjectState(object).ref;
      const previous = freshByKey.get(ref.key);
      if (previous !== undefined && !refsMatch(stagedCandidateObjectState(previous).ref, ref)) {
        throw new Error(`candidate plan repeats key ${ref.key} with different immutable content`);
      }
      freshByKey.set(ref.key, object);
    }
    const root = freshByKey.get(stagedCandidateObjectState(input.root).ref.key);
    if (root === undefined) throw new Error('candidate plan lost its root');
    const dependencies = [...freshByKey.values()].filter((object) => object !== root);
    const closureByKey = new Map<string, ImmutableObjectRef>();
    for (const ref of input.reused ?? []) {
      const parsed = snapshotObjectRef(ref);
      const previous = closureByKey.get(parsed.key);
      if (previous !== undefined && !refsMatch(previous, parsed)) {
        throw new Error(`candidate plan repeats reused key ${parsed.key} with different immutable content`);
      }
      closureByKey.set(parsed.key, parsed);
    }
    for (const object of freshByKey.values()) {
      const ref = stagedCandidateObjectState(object).ref;
      const previous = closureByKey.get(ref.key);
      if (previous !== undefined && !refsMatch(previous, ref)) {
        throw new Error(`candidate plan fresh object conflicts with reused key ${ref.key}`);
      }
      closureByKey.set(ref.key, ref);
    }
    const closure = Object.freeze([...closureByKey.values()].map(snapshotObjectRef).sort((a, b) => a.key.localeCompare(b.key)));
    const fresh = [...dependencies, root];
    return new CandidatePublicationPlan(input.format, input.expectedParentRootId, Object.freeze({
      capturedCut: Object.freeze({ ...capture.capturedCut }),
      generation: String(capture.generation),
      dependencies: Object.freeze(dependencies),
      root,
      closure,
      movedBytes: fresh.reduce((sum, object) => sum + Number(stagedCandidateObjectState(object).ref.byteLength), 0),
    }));
  }
}

function publicationPlanState(plan: CandidatePublicationPlan): PublicationPlanState {
  const state = publicationPlans.get(plan);
  if (state === undefined) throw new Error('candidate publication plan was not issued by planCandidatePublication');
  return state;
}

function snapshotObjectRef(ref: ImmutableObjectRef): ImmutableObjectRef {
  return Object.freeze({ ...v.parse(ImmutableObjectRefSchema, ref) });
}

function refsMatch(a: ImmutableObjectRef, b: ImmutableObjectRef): boolean {
  return a.key === b.key && a.byteLength === b.byteLength && a.sha256 === b.sha256;
}

export async function planCandidatePublication(input: {
  readonly format: DurableRootFormat;
  readonly expectedParentRootId: Sha256Hex | null;
  readonly capture: AuditedCapture;
  readonly sink: CandidateObjectSink;
  readonly dependencies: readonly StagedCandidateObject[];
  readonly root: StagedCandidateObject;
  readonly reused?: readonly ImmutableObjectRef[];
}): Promise<CandidatePublicationPlan> {
  return await CandidatePublicationPlan.create(input);
}


// ── range reads: validated intent, never a coordinator-proxied body ──────────

export interface CandidateRangeRequest {
  /** An already-validated RangeReadIntent whose sha256 is the exact expectation. */
  readonly intent: RangeReadIntent;
}

export function candidateRangeRequest(intent: RangeReadIntent): CandidateRangeRequest {
  return { intent: v.parse(RangeReadIntentSchema, intent) };
}

/**
 * Fetch through the direct payload path and hold the bytes to the digest the
 * intent was validated against. A wrong body never reaches a caller that
 * consumes ranges.
 */
export async function readCandidateRange(
  request: CandidateRangeRequest,
  reader: { readonly readRange: (intent: RangeReadIntent) => Promise<Uint8Array> },
): Promise<Uint8Array> {
  const bytes = await reader.readRange(request.intent);
  const digest = sha256Hex(bytes);
  if (digest !== request.intent.sha256 || String(bytes.byteLength) !== request.intent.byteLength) {
    throw new Error(
      `range read of ${request.intent.exactKey} returned ${bytes.byteLength} bytes digested ${digest}, expected ${request.intent.byteLength} bytes digested ${request.intent.sha256}`,
    );
  }
  return bytes;
}

// ── envelopes ────────────────────────────────────────────────────────────────

const envelopeEncoder = new TextEncoder();

/** Canonical envelope bytes: stable JSON plus newline. */
export function envelopeBytes(envelope: RootEnvelopeV1): Uint8Array {
  return envelopeEncoder.encode(`${JSON.stringify(envelope)}\n`);
}

export function envelopeIdOf(envelope: RootEnvelopeV1): Sha256Hex {
  return sha256Hex(envelopeBytes(envelope));
}

/** Bind an envelope to the digest a head pointer names. Canonical bytes are the
 * only identity an envelope has, so a relabeled object is refused here. */
export function requireEnvelopeAt(envelope: RootEnvelopeV1, rootEnvelopeId: string): RootEnvelopeV1 {
  if (envelopeIdOf(envelope) !== rootEnvelopeId) {
    throw new Error(`candidate envelope does not match pointer ${rootEnvelopeId}`);
  }
  return envelope;
}

/** Read immutable envelope bytes at their digest key. Non-canonical encodings
 * are refused even when they parse, so one envelope has exactly one body. */
export function parseEnvelopeBytes(bytes: Uint8Array, rootEnvelopeId: string): RootEnvelopeV1 {
  const envelope = requireEnvelopeAt(
    v.parse(RootEnvelopeV1Schema, JSON.parse(new TextDecoder().decode(bytes))),
    rootEnvelopeId,
  );
  if (!sameBytes(envelopeBytes(envelope), bytes)) {
    throw new Error(`candidate envelope body at ${rootEnvelopeId} is not canonical`);
  }
  return envelope;
}


/** Container-side payload transport. It receives a staged stream; no DO RPC carries a body. */
export interface CandidatePayloadStore {
  issuePayloadGrant(intent: UploadIntent): Promise<PayloadGrant>;
  uploadObject(grant: PayloadGrant, body: ReadableStream<Uint8Array>): Promise<ObjectReceipt>;
}

export const CandidatePublicationDraftSchema = v.strictObject({
  operationId: v.pipe(v.string(), v.minLength(1)),
  attemptId: v.pipe(v.string(), v.minLength(1)),
  format: v.picklist(DURABLE_ROOT_FORMATS),
  expectedParentRootId: v.nullable(v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/))),
  capturedCut: CapturedCutSchema,
  generation: v.pipe(v.string(), v.regex(/^\d+$/)),
  root: ImmutableObjectRefSchema,
  rootReceipt: ObjectReceiptSchema,
  closure: v.array(ImmutableObjectRefSchema),
  dependencyReceipts: v.array(ObjectReceiptSchema),
});
export type CandidatePublicationDraft = v.InferOutput<typeof CandidatePublicationDraftSchema>;

/** The operation coordinates finalization binds a draft and its envelope to. */
export interface PublishOperationIdentity {
  readonly operationId: string;
  readonly attemptId: string;
  readonly boxId: string;
  readonly epoch: string;
  readonly bootId: string;
  readonly kind: OperationRecord['kind'];
}

export interface PublishIdentityInput extends PublishOperationIdentity {
  /** Expiry stamped into every staging intent this operation issues. */
  readonly expiresAt: string;
}

export interface PublishedCandidate {
  readonly head: HeadPointerV1;
  readonly envelope: RootEnvelopeV1;
  readonly resultRootId: Sha256Hex;
  readonly receipts: readonly ObjectReceipt[];
  readonly movedBytes: number;
}
const publishedCandidates = new WeakSet<PublishedCandidate>();

/** Reject a relabeled envelope or a structural lookalike before parent reuse. */
export function requirePublishedCandidate(candidate: PublishedCandidate): PublishedCandidate {
  if (!publishedCandidates.has(candidate)) throw new Error('candidate parent was not issued by finalization');
  if (candidate.resultRootId !== envelopeIdOf(candidate.envelope)) {
    throw new Error('published candidate root id does not bind its envelope');
  }
  if (candidate.head.rootEnvelopeId !== candidate.resultRootId) {
    throw new Error('published candidate head does not bind its envelope');
  }
  if (!candidate.receipts.some((receipt) => refsMatch(receipt, candidate.envelope.rootObject))) {
    throw new Error('published candidate receipts omit its root object');
  }
  return candidate;
}

/**
 * A process-local capability, issued only after persisted evidence authenticates
 * a parent. Its WeakMap registration makes a structural lookalike unusable.
 */
class PublishedParentToken {
  #opaque = true;

  private constructor() {}

  static create(): PublishedParentToken {
    return new PublishedParentToken();
  }

  isNominal(): boolean {
    return this.#opaque;
  }
}

export type PublishedParent = PublishedParentToken;

export interface PersistedPublishedParentEvidence {
  readonly head: unknown;
  /** A separate read of the current head, not a copy the caller declares equal. */
  readonly currentHead: unknown;
  readonly envelope: unknown;
  readonly envelopeBytes?: Uint8Array;
  readonly envelopeRef?: unknown;
  readonly rootBytes?: Uint8Array;
  readonly rootRef?: unknown;
  readonly expected: {
    readonly format: DurableRootFormat;
    readonly capturedCut: CapturedCut;
    readonly lastOperationId: string;
  };
}

export interface PublishedParentInfo {
  readonly head: HeadPointerV1;
  readonly envelopeId: Sha256Hex;
  readonly format: DurableRootFormat;
  readonly capturedCut: CapturedCut;
  readonly rootObject: ImmutableObjectRef;
}

interface PublishedParentState extends PublishedParentInfo {}

const publishedParents = new WeakMap<PublishedParent, PublishedParentState>();

function issuedParentState(parent: PublishedParent): PublishedParentState {
  if (!parent.isNominal()) throw new Error('published parent is not a nominal token');
  const state = publishedParents.get(parent);
  if (!state) throw new Error('published parent was not issued by persisted-evidence recovery');
  return state;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function sameCapturedCut(actual: CapturedCut, expected: CapturedCut): boolean {
  if (
    actual.captureId !== expected.captureId
    || actual.epoch !== expected.epoch
    || actual.baseRevision !== expected.baseRevision
  ) {
    return false;
  }
  return actual.cut === expected.cut
    && actual.stableStageHandle === expected.stableStageHandle
    && actual.manifestSha256 === expected.manifestSha256;
}

/**
 * Authenticate persisted parent state after a process restart. The evidence
 * contains no closure: format codecs must open and verify the authenticated
 * root themselves before binding their format-specific parent state to this
 * token.
 */
export function recoverPublishedParent(evidence: PersistedPublishedParentEvidence): PublishedParent {
  const head = v.parse(HeadPointerV1Schema, evidence.head);
  const currentHead = v.parse(HeadPointerV1Schema, evidence.currentHead);
  const envelope = v.parse(RootEnvelopeV1Schema, evidence.envelope);
  const expectedCut = v.parse(CapturedCutSchema, evidence.expected.capturedCut);
  const canonicalEnvelope = envelopeBytes(envelope);
  const envelopeId = envelopeIdOf(envelope);

  if (
    head.version !== currentHead.version
    || head.rootEnvelopeId !== currentHead.rootEnvelopeId
    || head.lastOperationId !== currentHead.lastOperationId
  ) {
    throw new Error('persisted parent head is not the exact current head');
  }
  if (head.rootEnvelopeId !== envelopeId) {
    throw new Error('persisted parent head does not bind its envelope');
  }
  if (head.lastOperationId !== evidence.expected.lastOperationId) {
    throw new Error('persisted parent head does not bind the expected operation');
  }
  if (envelope.format !== evidence.expected.format) {
    throw new Error('persisted parent envelope has the wrong candidate format');
  }
  if (!sameCapturedCut(envelope.cut, expectedCut)) {
    throw new Error('persisted parent envelope has the wrong captured cut');
  }
  if (evidence.envelopeBytes === undefined && evidence.envelopeRef === undefined) {
    throw new Error('persisted parent lacks envelope bytes or an immutable envelope ref');
  }
  if (evidence.envelopeBytes !== undefined && !sameBytes(evidence.envelopeBytes, canonicalEnvelope)) {
    throw new Error('persisted parent envelope bytes do not match its canonical envelope');
  }
  if (evidence.envelopeRef !== undefined) {
    const envelopeRef = v.parse(ImmutableObjectRefSchema, evidence.envelopeRef);
    if (envelopeRef.byteLength !== String(canonicalEnvelope.byteLength) || envelopeRef.sha256 !== envelopeId) {
      throw new Error('persisted parent envelope ref does not match its envelope');
    }
  }
  if (evidence.rootBytes === undefined && evidence.rootRef === undefined) {
    throw new Error('persisted parent lacks root bytes or an immutable root ref');
  }
  if (
    evidence.rootBytes !== undefined
    && (
      String(evidence.rootBytes.byteLength) !== envelope.rootObject.byteLength
      || sha256Hex(evidence.rootBytes) !== envelope.rootObject.sha256
    )
  ) {
    throw new Error('persisted parent root bytes do not match its root ref');
  }
  if (evidence.rootRef !== undefined && !refsMatch(v.parse(ImmutableObjectRefSchema, evidence.rootRef), envelope.rootObject)) {
    throw new Error('persisted parent root ref does not match its envelope');
  }

  const parent = PublishedParentToken.create();
  publishedParents.set(parent, Object.freeze({
    head: Object.freeze({ ...head }),
    envelopeId,
    format: envelope.format,
    capturedCut: Object.freeze({ ...envelope.cut }),
    rootObject: snapshotObjectRef(envelope.rootObject),
  }));
  return parent;
}

/**
 * Convert a live publication through the same evidence validator used after a
 * restart. It deliberately carries no caller-declared reachable closure.
 */
export function publishedParentOf(candidate: PublishedCandidate): PublishedParent {
  const published = requirePublishedCandidate(candidate);
  return recoverPublishedParent({
    head: published.head,
    currentHead: published.head,
    envelope: published.envelope,
    envelopeBytes: envelopeBytes(published.envelope),
    rootRef: published.envelope.rootObject,
    expected: {
      format: published.envelope.format,
      capturedCut: published.envelope.cut,
      lastOperationId: published.head.lastOperationId,
    },
  });
}

export function publishedParentInfo(parent: PublishedParent): PublishedParentInfo {
  const state = issuedParentState(parent);
  return Object.freeze({
    head: Object.freeze({ ...state.head }),
    envelopeId: state.envelopeId,
    format: state.format,
    capturedCut: Object.freeze({ ...state.capturedCut }),
    rootObject: snapshotObjectRef(state.rootObject),
  });
}

/** Raised when another writer committed a different head first. */
export class StaleParentRefused extends Error {
  constructor(
    readonly expectedParentRootId: string | null,
    readonly actualHeadRootId: string | null,
  ) {
    super(
      `stale parent: expected head ${expectedParentRootId ?? 'none'}, found ${actualHeadRootId ?? 'none'}`,
    );

    this.name = 'StaleParentRefused';
  }
}

/** A reset/eviction interruption: leave the durable operation retryable. */
export class PublicationInterrupted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicationInterrupted';
  }
}
/** The head committed; only durable completion marking remains for retry. */
export class PublicationCompletionPending extends Error {
  constructor(readonly published: PublishedCandidate, cause: Error) {
    super(`published root ${published.resultRootId} awaits completion marking`, { cause });
    this.name = 'PublicationCompletionPending';
  }
}


/**
 * How many objects one publication moves at once. Each upload is one round
 * trip through the mount; run 20260905075659 moved a 64 MiB generation one
 * object at a time and its quiesce took 516 s. Sixteen keeps a few chunks of
 * buffers live and fills the mount's request pipeline.
 */
const UPLOAD_WIDTH = 16;

/** Run `run` over `items` with at most `width` in flight, results in item
 *  order. The first failure stops the pool from starting anything further;
 *  what was already in flight finishes on its own and is discarded. */
async function runUploadPool<Item, Result>(
  items: readonly Item[],
  width: number,
  run: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (failed) return;
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = await run(items[index]!);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return results;
}

/**
 * Move immutable payloads directly from the container to R2, then return only
 * receipts and refs. Dependencies move side by side; the root moves only after
 * every one of them has a verified receipt, so a crash at any point leaves
 * nothing that names an absent object.
 */
export async function stageCandidatePayload(
  plan: CandidatePublicationPlan,
  input: PublishIdentityInput,
  store: CandidatePayloadStore,
): Promise<CandidatePublicationDraft> {
  const state = publicationPlanState(plan);
  const upload = async (object: StagedCandidateObject): Promise<ObjectReceipt> => {
    const ref = stagedCandidateObjectState(object).ref;
    const intent = v.parse(UploadIntentSchema, {
      operationId: input.operationId,
      attemptId: input.attemptId,
      boxId: input.boxId,
      epoch: state.capturedCut.epoch,
      exactKey: ref.key,
      method: 'PUT',
      byteLength: ref.byteLength,
      sha256: ref.sha256,
      expiresAt: input.expiresAt,
    });
    const receipt = v.parse(ObjectReceiptSchema, await store.uploadObject(
      await store.issuePayloadGrant(intent),
      streamStagedCandidateObject(object),
    ));
    verifyReceipt(receipt, intent);
    return receipt;
  };
  const dependencyReceipts = await runUploadPool(state.dependencies, UPLOAD_WIDTH, upload);
  const rootReceipt = await upload(state.root);
  return v.parse(CandidatePublicationDraftSchema, {
    operationId: input.operationId,
    attemptId: input.attemptId,
    format: plan.format,
    expectedParentRootId: plan.expectedParentRootId,
    capturedCut: state.capturedCut,
    generation: state.generation,
    root: stagedCandidateObjectState(state.root).ref,
    rootReceipt,
    closure: state.closure,
    dependencyReceipts,
  });
}

/** DO-owned control plane: operation ledger, immutable envelope, head CAS and completion mark only. */
export interface CandidatePublicationControl {
  recordOperation(record: OperationRecord): void | Promise<void>;
  /** Writes canonical envelope bytes at its digest key, or verifies the existing immutable object. */
  writeEnvelope(envelope: RootEnvelopeV1, rootEnvelopeId: Sha256Hex): Promise<void>;
  /** Verifies one immutable object directly from store metadata, without reading its body. */
  verifyObject(ref: ImmutableObjectRef): Promise<void>;
  compareAndSwapHead(envelope: RootEnvelopeV1, expectedParentRootId: string | null): Promise<HeadPointerV1>;
  markComplete(operationId: string): Promise<void>;
  markFailed(operationId: string, failureCode: string): void | Promise<void>;
}

/** Validate every draft claim that does not need an object body. */
function validateDraft(
  rawDraft: CandidatePublicationDraft,
  input: PublishOperationIdentity,
): CandidatePublicationDraft {
  const draft = v.parse(CandidatePublicationDraftSchema, rawDraft);
  if (
    draft.operationId !== input.operationId
    || draft.attemptId !== input.attemptId
    || draft.capturedCut.epoch !== input.epoch
  ) {
    throw new Error('candidate draft does not belong to the begun operation');
  }
  const keys = new Set<string>();
  for (const receipt of [...draft.dependencyReceipts, draft.rootReceipt]) {
    if (keys.has(receipt.key)) throw new ReceiptMismatch(`candidate draft repeats receipt ${receipt.key}`);
    keys.add(receipt.key);
    if (receipt.operationId !== input.operationId || receipt.attemptId !== input.attemptId) {
      throw new ReceiptMismatch(`candidate draft receipt belongs to another operation: ${receipt.key}`);
    }
  }
  if (!refsMatch(draft.root, draft.rootReceipt)) throw new ReceiptMismatch('candidate draft root receipt mismatches root');
  verifyClosure(draft);
  return draft;
}

/** The runner supplies the canonical closure facts; the control plane never reads its payload body. */
function verifyClosure(draft: CandidatePublicationDraft): void {
  if (draft.closure.some((ref, index) => index > 0 && draft.closure[index - 1]!.key >= ref.key)) {
    throw new ReceiptMismatch('candidate closure is not canonical key-sorted metadata');
  }
  const closureRefs = new Map(draft.closure.map((ref) => [ref.key, ref]));
  if (closureRefs.size !== draft.closure.length) {
    throw new ReceiptMismatch('candidate closure repeats an immutable object key');
  }
  for (const receipt of [...draft.dependencyReceipts, draft.rootReceipt]) {
    const ref = closureRefs.get(receipt.key);
    if (ref === undefined || !refsMatch(ref, receipt)) {
      throw new ReceiptMismatch(`candidate closure omits fresh receipt ${receipt.key}`);
    }
  }
}

/**
 * Seal a staged draft into an immutable envelope and publish it. Each failure
 * marks exactly one durable failure code, and the sealed record is persisted
 * before the head CAS await so a reset can resume the same result root.
 */
export async function finalizeCandidatePayload(
  rawDraft: CandidatePublicationDraft,
  input: PublishOperationIdentity,
  control: CandidatePublicationControl,
): Promise<PublishedCandidate> {
  const markFailed = async (failureCode: string): Promise<void> => {
    await control.markFailed(input.operationId, failureCode);
  };
  let draft: CandidatePublicationDraft;
  try {
    draft = validateDraft(rawDraft, input);
  } catch (error) {
    await markFailed(error instanceof ReceiptMismatch ? 'receipt-mismatch' : 'draft-invalid');
    throw error;
  }
  try {
    for (const ref of draft.closure) await control.verifyObject(ref);
  } catch (error) {
    await markFailed('closure-unavailable');
    throw error;
  }
  const envelope = v.parse(RootEnvelopeV1Schema, {
    version: 1,
    format: draft.format,
    boxId: input.boxId,
    epoch: draft.capturedCut.epoch,
    generation: draft.generation,
    parentRootId: draft.expectedParentRootId,
    cut: draft.capturedCut,
    rootObject: draft.root,
    closure: draft.closure,
  });
  const resultRootId = envelopeIdOf(envelope);
  /** Phase-independent coordinates every recorded transition repeats. */
  const operation = {
    operationId: input.operationId,
    kind: input.kind,
    epoch: draft.capturedCut.epoch,
    bootId: input.bootId,
    baseRevision: draft.capturedCut.baseRevision,
    expectedParent: draft.expectedParentRootId,
  };
  try {
    await control.writeEnvelope(envelope, resultRootId);
  } catch (error) {
    await markFailed('envelope-write-failed');
    throw error;
  }
  // From here the result is sealed and its envelope is immutable in the object
  // store. A transient failure leaves the operation resumable, so only a lost
  // race — which no retry can win back — marks a terminal failure.
  await control.recordOperation(v.parse(OperationRecordSchema, {
    ...operation, phase: 'sealed', attemptId: input.attemptId, resultRootId,
  }));
  let head: HeadPointerV1;
  try {
    head = await control.compareAndSwapHead(envelope, draft.expectedParentRootId);
  } catch (error) {
    if (!(error instanceof StaleParentRefused)) throw error;
    await markFailed('stale-parent');
    throw error;
  }
  const published: PublishedCandidate = Object.freeze({
    head: Object.freeze({ ...head }),
    envelope: Object.freeze({
      ...envelope,
      cut: Object.freeze({ ...envelope.cut }),
      rootObject: Object.freeze({ ...envelope.rootObject }),
      closure: envelope.closure.map((ref) => ({ ...ref })),
    }),
    resultRootId,
    receipts: Object.freeze(
      [...draft.dependencyReceipts, draft.rootReceipt]
        .map((receipt) => Object.freeze({ ...receipt })),
    ),
    movedBytes: [...draft.dependencyReceipts, draft.rootReceipt]
      .reduce((bytes, receipt) => bytes + Number(receipt.byteLength), 0),
  });
  publishedCandidates.add(published);
  try {
    await control.markComplete(input.operationId);
  } catch (error) {
    await control.recordOperation(v.parse(OperationRecordSchema, {
      ...operation, phase: 'completion-pending', attemptId: input.attemptId, resultRootId,
    }));
    throw new PublicationCompletionPending(published, error instanceof Error ? error : new Error(String(error)));
  }
  await control.recordOperation(v.parse(OperationRecordSchema, { ...operation, phase: 'published', resultRootId }));
  return published;
}

/** A response that does not prove the exact object an intent named. */
export class ReceiptMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptMismatch';
  }
}


function verifyReceipt(receipt: ObjectReceipt, intent: UploadIntent): void {
  if (
    receipt.key !== intent.exactKey
    || receipt.byteLength !== intent.byteLength
    || receipt.sha256 !== intent.sha256
    || receipt.operationId !== intent.operationId
    || receipt.attemptId !== intent.attemptId
  ) {
    throw new ReceiptMismatch(
      `receipt mismatch for ${intent.exactKey}: got key=${receipt.key} len=${receipt.byteLength} sha=${receipt.sha256}`,
    );
  }
}

// ── v2: delta publication, single PUTs, ETag-proven bodies ───────────────────
//
// WHAT LEAVES THE v2 PATH. There is no closure object and no closure list, so
// nothing verifies O(#objects) per publish or per attach; the root is a record
// inside one of this generation's packs, so it is not a separate object; and
// every pack is one PUT under a size cap, so `create-multipart`,
// `upload-multipart-part` and `complete-multipart` are unreachable rather than
// merely unused.
//
// WHAT PROVES A BODY. The intercepted R2 endpoint answers a single PUT with
// HTTP 200, an empty body and one ETag, and drops the checksum headers the
// request carried (measured 2026-09-02, `bench/measure-first/MEASUREMENTS.md`
// § (d)). So a pack receipt is ETag-only: the sidecar computes the MD5 of the
// bytes it sent and requires the exact ETag back. The object KEY stays a
// SHA-256 content address, which is what makes a re-upload of the same bytes
// idempotent; nothing here claims the transport echoed a SHA-256.

export const CandidatePublicationDraftV2Schema = v.strictObject({
  operationId: v.pipe(v.string(), v.minLength(1)),
  attemptId: v.pipe(v.string(), v.minLength(1)),
  format: v.picklist(DURABLE_ROOT_FORMATS),
  expectedParentRootId: v.nullable(v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/))),
  capturedCut: CapturedCutSchema,
  generation: v.pipe(v.string(), v.regex(/^\d+$/)),
  /** The root record: a range inside one of the packs below. */
  rootObject: ObjectRangeRefSchema,
  /** The packs this generation PUT, in packing order, with their receipts. */
  added: v.array(ImmutableObjectRefSchema),
  addedReceipts: v.array(ObjectReceiptSchema),
  /** The ledger object this generation wrote, with its receipt. */
  ledger: ImmutableObjectRefSchema,
  ledgerReceipt: ObjectReceiptSchema,
  retired: v.array(ObjectKeySchema),
});
export type CandidatePublicationDraftV2 = v.InferOutput<typeof CandidatePublicationDraftV2Schema>;

/** Canonical v2 envelope bytes: stable JSON plus newline, as v1 does it. */
export function envelopeV2Bytes(envelope: RootEnvelopeV2): Uint8Array {
  return envelopeEncoder.encode(`${JSON.stringify(envelope)}\n`);
}

export function envelopeV2IdOf(envelope: RootEnvelopeV2): Sha256Hex {
  return sha256Hex(envelopeV2Bytes(envelope));
}

export interface PublishedParentV2Info {
  readonly head: HeadPointerV1;
  readonly envelopeId: Sha256Hex;
  readonly format: DurableRootFormat;
  readonly capturedCut: CapturedCut;
  readonly rootObject: ObjectRangeRef;
  readonly generation: string;
}

const publishedParentsV2 = new WeakMap<PublishedParent, PublishedParentV2Info>();

export interface PersistedPublishedParentV2Evidence {
  readonly head: unknown;
  /** A separate read of the current head, not a copy the caller declares equal. */
  readonly currentHead: unknown;
  readonly envelope: unknown;
  readonly envelopeBytes: Uint8Array;
  /** The root RECORD bytes, held to the range digest the envelope names. */
  readonly rootBytes: Uint8Array;
  readonly expected: {
    readonly format: DurableRootFormat;
    readonly capturedCut: CapturedCut;
    readonly lastOperationId: string;
  };
}

/**
 * Authenticate a v2 parent from persisted evidence: the head pointer read
 * twice, the canonical envelope its digest names, and the root record bytes at
 * the range that envelope declares. A v2 parent carries no closure, so this is
 * everything a builder may reuse against.
 */
export function recoverPublishedParentV2(evidence: PersistedPublishedParentV2Evidence): PublishedParent {
  const head = v.parse(HeadPointerV1Schema, evidence.head);
  const currentHead = v.parse(HeadPointerV1Schema, evidence.currentHead);
  const envelope = v.parse(RootEnvelopeV2Schema, evidence.envelope);
  const expectedCut = v.parse(CapturedCutSchema, evidence.expected.capturedCut);
  const envelopeId = envelopeV2IdOf(envelope);
  if (
    head.version !== currentHead.version
    || head.rootEnvelopeId !== currentHead.rootEnvelopeId
    || head.lastOperationId !== currentHead.lastOperationId
  ) {
    throw new Error('persisted v2 parent head is not the exact current head');
  }
  if (head.rootEnvelopeId !== envelopeId) throw new Error('persisted v2 parent head does not bind its envelope');
  if (head.lastOperationId !== evidence.expected.lastOperationId) {
    throw new Error('persisted v2 parent head does not bind the expected operation');
  }
  if (envelope.format !== evidence.expected.format) {
    throw new Error('persisted v2 parent envelope has the wrong candidate format');
  }
  if (!sameCapturedCut(envelope.cut, expectedCut)) {
    throw new Error('persisted v2 parent envelope has the wrong captured cut');
  }
  if (!sameBytes(evidence.envelopeBytes, envelopeV2Bytes(envelope))) {
    throw new Error('persisted v2 parent envelope bytes do not match its canonical envelope');
  }
  if (
    String(evidence.rootBytes.byteLength) !== envelope.rootObject.byteLength
    || sha256Hex(evidence.rootBytes) !== envelope.rootObject.sha256
  ) {
    throw new Error('persisted v2 parent root record does not match its range ref');
  }
  const parent = PublishedParentToken.create();
  publishedParentsV2.set(parent, Object.freeze({
    head: Object.freeze({ ...head }),
    envelopeId,
    format: envelope.format,
    capturedCut: Object.freeze({ ...envelope.cut }),
    rootObject: Object.freeze({ ...envelope.rootObject }),
    generation: envelope.generation,
  }));
  return parent;
}

export function publishedParentV2Info(parent: PublishedParent): PublishedParentV2Info {
  if (!parent.isNominal()) throw new Error('published v2 parent is not a nominal token');
  const state = publishedParentsV2.get(parent);
  if (state === undefined) throw new Error('published v2 parent was not issued by persisted-evidence recovery');
  return state;
}

/**
 * The ETag rule for a single PUT: the transport returns the MD5 of the body it
 * stored and nothing else, so that is what proves the body. Quoting is HTTP
 * syntax rather than identity, so it is stripped before the digests are
 * compared; the comparison itself is exact.
 */
export function requireEtagMatchesMd5(receipt: ObjectReceipt, md5: string): void {
  const declared = receipt.etag.replace(/^"(.*)"$/u, '$1');
  if (declared !== md5) {
    throw new ReceiptMismatch(
      `receipt for ${receipt.key} carries etag ${receipt.etag}, and its body digests md5 ${md5}`,
    );
  }
}

/** One pack a v2 build produced: its content-addressed ref and its bytes. */
export interface CandidatePackUpload {
  readonly ref: ImmutableObjectRef;
  readonly bytes: Uint8Array;
  /** MD5 of exactly these bytes, for the ETag the single PUT answers with. */
  readonly md5: string;
}

export interface CandidateV2PublicationPlan {
  readonly format: DurableRootFormat;
  readonly expectedParentRootId: Sha256Hex | null;
  readonly capturedCut: CapturedCut;
  readonly generation: string;
  readonly rootObject: ObjectRangeRef;
  readonly packs: readonly CandidatePackUpload[];
  readonly ledger: CandidatePackUpload;
  readonly retired: readonly string[];
}

/**
 * Move one v2 generation's objects to the store: one single PUT per pack, one
 * for the ledger, each held to its own ETag before anything is published. A
 * mismatch refuses HERE, before the head CAS, so a body the store did not take
 * can never become a head.
 */
export async function stageCandidatePayloadV2(
  plan: CandidateV2PublicationPlan,
  input: PublishIdentityInput,
  store: CandidatePayloadStore,
): Promise<CandidatePublicationDraftV2> {
  const added: ImmutableObjectRef[] = [];
  const addedReceipts: ObjectReceipt[] = [];
  let ledgerReceipt: ObjectReceipt | undefined;
  for (const upload of [...plan.packs, plan.ledger]) {
    const intent = v.parse(UploadIntentSchema, {
      operationId: input.operationId,
      attemptId: input.attemptId,
      boxId: input.boxId,
      epoch: plan.capturedCut.epoch,
      exactKey: upload.ref.key,
      method: 'PUT',
      byteLength: upload.ref.byteLength,
      sha256: upload.ref.sha256,
      expiresAt: input.expiresAt,
    });
    const receipt = v.parse(ObjectReceiptSchema, await store.uploadObject(
      await store.issuePayloadGrant(intent),
      memorySource(upload.bytes).open(),
    ));
    verifyReceipt(receipt, intent);
    requireEtagMatchesMd5(receipt, upload.md5);
    if (upload === plan.ledger) ledgerReceipt = receipt;
    else {
      added.push(upload.ref);
      addedReceipts.push(receipt);
    }
  }
  if (ledgerReceipt === undefined) throw new Error('candidate v2 plan staged no ledger receipt');
  return v.parse(CandidatePublicationDraftV2Schema, {
    operationId: input.operationId,
    attemptId: input.attemptId,
    format: plan.format,
    expectedParentRootId: plan.expectedParentRootId,
    capturedCut: plan.capturedCut,
    generation: plan.generation,
    rootObject: plan.rootObject,
    added,
    addedReceipts,
    ledger: plan.ledger.ref,
    ledgerReceipt,
    retired: [...plan.retired],
  });
}


/**
 * The DO-owned v2 control plane. It has no `verifyObject`, and that absence is
 * the point: the only objects a v2 publish could verify are the ones it just
 * PUT, and their receipts were already held to the intent and to the ETag of
 * the body the store took. Everything older is named by records the head
 * already reaches, so there is nothing per-object left to ask — which is what
 * removes the O(#objects) HEAD walk from both publish and attach.
 */
export interface CandidatePublicationControlV2 {
  recordOperation(record: OperationRecord): void | Promise<void>;
  writeEnvelope(envelope: RootEnvelopeV2, rootEnvelopeId: Sha256Hex): Promise<void>;
  compareAndSwapHead(envelope: RootEnvelopeV2, expectedParentRootId: string | null): Promise<HeadPointerV1>;
  markComplete(operationId: string): Promise<void>;
  markFailed(operationId: string, failureCode: string): void | Promise<void>;
}

export interface PublishedCandidateV2 {
  readonly head: HeadPointerV1;
  readonly envelope: RootEnvelopeV2;
  readonly resultRootId: Sha256Hex;
  readonly movedBytes: number;
}

/** Every claim in a v2 draft that needs no object body to check. */
function validateDraftV2(
  rawDraft: CandidatePublicationDraftV2,
  input: PublishOperationIdentity,
): CandidatePublicationDraftV2 {
  const draft = v.parse(CandidatePublicationDraftV2Schema, rawDraft);
  if (
    draft.operationId !== input.operationId
    || draft.attemptId !== input.attemptId
    || draft.capturedCut.epoch !== input.epoch
  ) {
    throw new Error('candidate v2 draft does not belong to the begun operation');
  }
  if (draft.added.length !== draft.addedReceipts.length) {
    throw new ReceiptMismatch('candidate v2 draft has a receipt for something it did not add');
  }
  const keys = new Set<string>();
  for (const [index, ref] of draft.added.entries()) {
    const receipt = draft.addedReceipts[index]!;
    if (keys.has(ref.key)) throw new ReceiptMismatch(`candidate v2 draft repeats pack ${ref.key}`);
    keys.add(ref.key);
    if (!refsMatch(ref, receipt)) {
      throw new ReceiptMismatch(`candidate v2 draft receipt mismatches pack ${ref.key}`);
    }
  }
  for (const receipt of [...draft.addedReceipts, draft.ledgerReceipt]) {
    if (receipt.operationId !== input.operationId || receipt.attemptId !== input.attemptId) {
      throw new ReceiptMismatch(`candidate v2 receipt belongs to another operation: ${receipt.key}`);
    }
  }
  if (!refsMatch(draft.ledger, draft.ledgerReceipt)) {
    throw new ReceiptMismatch('candidate v2 draft receipt mismatches its ledger');
  }
  const home = draft.added.find((ref) => ref.key === draft.rootObject.key);
  if (home === undefined) {
    throw new ReceiptMismatch(`candidate v2 root ${draft.rootObject.key} is not a pack this generation added`);
  }
  if (BigInt(draft.rootObject.byteOffset) + BigInt(draft.rootObject.byteLength) > BigInt(home.byteLength)) {
    throw new ReceiptMismatch(`candidate v2 root record lies outside pack ${home.key}`);
  }
  return draft;
}

/**
 * Seal a staged v2 draft into an immutable envelope and publish it: the same
 * record-then-CAS-then-mark order v1 uses, with the closure walk gone.
 */
export async function finalizeCandidatePayloadV2(
  rawDraft: CandidatePublicationDraftV2,
  input: PublishOperationIdentity,
  control: CandidatePublicationControlV2,
): Promise<PublishedCandidateV2> {
  let draft: CandidatePublicationDraftV2;
  try {
    draft = validateDraftV2(rawDraft, input);
  } catch (error) {
    await control.markFailed(input.operationId, error instanceof ReceiptMismatch ? 'receipt-mismatch' : 'draft-invalid');
    throw error;
  }
  const envelope = v.parse(RootEnvelopeV2Schema, {
    version: 2,
    format: draft.format,
    boxId: input.boxId,
    epoch: draft.capturedCut.epoch,
    generation: draft.generation,
    parentRootId: draft.expectedParentRootId,
    cut: draft.capturedCut,
    rootObject: draft.rootObject,
    added: draft.added,
    retired: draft.retired,
    ledger: draft.ledger,
  });
  const resultRootId = envelopeV2IdOf(envelope);
  const operation = {
    operationId: input.operationId,
    kind: input.kind,
    epoch: draft.capturedCut.epoch,
    bootId: input.bootId,
    baseRevision: draft.capturedCut.baseRevision,
    expectedParent: draft.expectedParentRootId,
  };
  try {
    await control.writeEnvelope(envelope, resultRootId);
  } catch (error) {
    await control.markFailed(input.operationId, 'envelope-write-failed');
    throw error;
  }
  await control.recordOperation(v.parse(OperationRecordSchema, {
    ...operation, phase: 'sealed', attemptId: input.attemptId, resultRootId,
  }));
  let head: HeadPointerV1;
  try {
    head = await control.compareAndSwapHead(envelope, draft.expectedParentRootId);
  } catch (error) {
    if (!(error instanceof StaleParentRefused)) throw error;
    await control.markFailed(input.operationId, 'stale-parent');
    throw error;
  }
  const published: PublishedCandidateV2 = Object.freeze({
    head: Object.freeze({ ...head }),
    envelope,
    resultRootId,
    movedBytes: [...draft.addedReceipts, draft.ledgerReceipt]
      .reduce((bytes, receipt) => bytes + Number(receipt.byteLength), 0),
  });
  try {
    await control.markComplete(input.operationId);
  } catch (error) {
    await control.recordOperation(v.parse(OperationRecordSchema, {
      ...operation, phase: 'completion-pending', attemptId: input.attemptId, resultRootId,
    }));
    throw new PublicationCompletionPendingV2(published, error instanceof Error ? error : new Error(String(error)));
  }
  await control.recordOperation(v.parse(OperationRecordSchema, { ...operation, phase: 'published', resultRootId }));
  return published;
}

/** The v2 head committed; only durable completion marking remains for retry. */
export class PublicationCompletionPendingV2 extends Error {
  constructor(readonly published: PublishedCandidateV2, cause: Error) {
    super(`published v2 root ${published.resultRootId} awaits completion marking`, { cause });
    this.name = 'PublicationCompletionPendingV2';
  }
}