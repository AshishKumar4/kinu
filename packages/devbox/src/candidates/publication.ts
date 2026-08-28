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
  ObjectReceiptSchema,
  OperationRecordSchema,
  RangeReadIntentSchema,
  RootEnvelopeV1Schema,
  UploadIntentSchema,
} from '../durability/contracts';
import type {
  CapturedCut,
  HeadPointerV1,
  ImmutableObjectRef,
  ObjectReceipt,
  OperationRecord,
  PayloadGrant,
  RangeReadIntent,
  RootEnvelopeV1,
  UploadIntent,
} from '../durability/contracts';

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
  readonly closureObject: StagedCandidateObject;
  /** Canonically sorted refs stored inside closureObject. */
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

  get closureObject(): StagedCandidateObject {
    return publicationPlanState(this).closureObject;
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
    const closureBytes = new TextEncoder().encode(`${JSON.stringify(closure)}\n`);
    const closureObject = await input.sink.stage(`closure/${sha256Hex(closureBytes)}`, closureBytes);
    const fresh = [...dependencies, root, closureObject];
    return new CandidatePublicationPlan(input.format, input.expectedParentRootId, Object.freeze({
      capturedCut: Object.freeze({ ...capture.capturedCut }),
      generation: String(capture.generation),
      dependencies: Object.freeze(dependencies),
      root,
      closureObject,
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
  closureObject: ImmutableObjectRefSchema,
  closureReceipt: ObjectReceiptSchema,
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
  if (!candidate.receipts.some((receipt) => refsMatch(receipt, candidate.envelope.closureObject))) {
    throw new Error('published candidate receipts omit its closure object');
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


/** Move immutable payloads directly from the container to R2, then return only receipts and refs. */
export async function stageCandidatePayload(
  plan: CandidatePublicationPlan,
  input: PublishIdentityInput,
  store: CandidatePayloadStore,
): Promise<CandidatePublicationDraft> {
  const state = publicationPlanState(plan);
  const receipts: ObjectReceipt[] = [];
  for (const object of [...state.dependencies, state.root, state.closureObject]) {
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
    receipts.push(receipt);
  }
  const closureReceipt = receipts.at(-1);
  const rootReceipt = receipts.at(-2);
  if (rootReceipt === undefined || closureReceipt === undefined) throw new Error('candidate plan lacks root or closure receipt');
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
    closureObject: stagedCandidateObjectState(state.closureObject).ref,
    closureReceipt,
    dependencyReceipts: receipts.slice(0, -2),
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
  for (const receipt of [...draft.dependencyReceipts, draft.rootReceipt, draft.closureReceipt]) {
    if (keys.has(receipt.key)) throw new ReceiptMismatch(`candidate draft repeats receipt ${receipt.key}`);
    keys.add(receipt.key);
    if (receipt.operationId !== input.operationId || receipt.attemptId !== input.attemptId) {
      throw new ReceiptMismatch(`candidate draft receipt belongs to another operation: ${receipt.key}`);
    }
  }
  if (!refsMatch(draft.root, draft.rootReceipt)) throw new ReceiptMismatch('candidate draft root receipt mismatches root');
  if (!refsMatch(draft.closureObject, draft.closureReceipt)) {
    throw new ReceiptMismatch('candidate draft closure receipt mismatches closure object');
  }
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
    await control.verifyObject(draft.closureObject);
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
    closureObject: draft.closureObject,
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
      closureObject: Object.freeze({ ...envelope.closureObject }),
    }),
    resultRootId,
    receipts: Object.freeze(
      [...draft.dependencyReceipts, draft.rootReceipt, draft.closureReceipt]
        .map((receipt) => Object.freeze({ ...receipt })),
    ),
    movedBytes: [...draft.dependencyReceipts, draft.rootReceipt, draft.closureReceipt]
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
