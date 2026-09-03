/**
 * The Durable Object side of candidate publication. It owns exactly one durable
 * record — a head pointer and at most one operation — and resolves every
 * envelope from the immutable object store by digest. Payload bytes never reach
 * it, and no other component may advance a head.
 */

import * as v from 'valibot';

import {
  PublicationCompletionPending,
  PublicationCompletionPendingV2,
  StaleParentRefused,
  envelopeIdOf,
  envelopeV2IdOf,
  finalizeCandidatePayload,
  finalizeCandidatePayloadV2,
  requireEnvelopeAt,
} from './publication';
import type {
  CandidatePublicationControl,
  CandidatePublicationControlV2,
  CandidatePublicationDraft,
  CandidatePublicationDraftV2,
} from './publication';
import type { Sha256Hex } from '../cas/types';
import {
  CandidateRunControlV1Schema,
  CandidateRunControlV2Schema,
  OperationRecordSchema,
} from '../durability/contracts';
import type {
  CandidateControlStateV1,
  CandidateRunControlV1,
  CandidateRunControlV2,
  HeadPointerV1,
  ImmutableObjectRef,
  OperationRecord,
  RootEnvelopeV1,
  RootEnvelopeV2,
} from '../durability/contracts';

/** One durable read-modify-write of the control record. */
export interface CandidateControlUpdate<T> {
  /** The record to persist, or null to leave the stored record untouched. */
  readonly next: CandidateControlStateV1 | null;
  readonly result: T;
}

/**
 * The durable control record. `update` must run `apply` and persist its record
 * inside one transaction. `apply` is deliberately synchronous: a foreign await
 * inside the transaction would widen the window another writer can commit in.
 */
export interface CandidateControlStore {
  read(): Promise<CandidateControlStateV1>;
  update<T>(apply: (current: CandidateControlStateV1) => CandidateControlUpdate<T>): Promise<T>;
  clear(): Promise<void>;
}

/** Immutable envelopes, addressed only by the digest of their canonical bytes. */
export interface CandidateEnvelopeStore {
  write(envelope: RootEnvelopeV1, rootEnvelopeId: Sha256Hex): Promise<void>;
  read(rootEnvelopeId: Sha256Hex): Promise<RootEnvelopeV1>;
}

type VerifyObject = (ref: ImmutableObjectRef) => Promise<void>;

/**
 * Verify a published envelope's own objects, and nothing below them.
 *
 * O(1) BECAUSE A WAKE IS NOT A CLOSURE WALK. The closure of a v1 envelope
 * names every chunk the tree holds, so a HEAD per member is one remote
 * operation per file — 100,000 of them at 1e5 files, half of the 200,006-op
 * wake cell 6.13 measured on 2026-09-02. What that walk could catch, a read
 * catches anyway and later: every payload read goes through
 * `readCandidateRange`, which holds the bytes to the digest and the length the
 * record declares, so a lost chunk refuses at the page-in that needs it
 * instead of at an attach that may never read it.
 *
 * The two objects checked here are the ones a wake cannot proceed without and
 * no later read would name: the root the resolution starts from, and the
 * closure record itself.
 */
async function verifyEnvelopeHead(envelope: RootEnvelopeV1, verifyObject: VerifyObject): Promise<void> {
  await verifyObject(envelope.rootObject);
  await verifyObject(envelope.closureObject);
}

/** Verify every object a publication declares. What a PUBLISH owes, over the
 *  objects it has just written, and what a recovery re-checks before it lets a
 *  sealed operation reach the head. */
async function verifyEnvelopeClosure(envelope: RootEnvelopeV1, verifyObject: VerifyObject): Promise<void> {
  await verifyObject(envelope.closureObject);
  for (const ref of envelope.closure) await verifyObject(ref);
}

/** Raised when the durable record cannot serve the operation a caller named. */
export class CandidateOperationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CandidateOperationRefused';
  }
}

type TransferringOperation = Extract<OperationRecord, { readonly phase: 'transferring' }>;
type CommittedOperation = Extract<OperationRecord, { readonly phase: 'sealed' | 'completion-pending' }>;

/** The coordinates a phase transition may never change. */
function operationBase(record: OperationRecord) {
  return {
    operationId: record.operationId,
    kind: record.kind,
    epoch: record.epoch,
    bootId: record.bootId,
    baseRevision: record.baseRevision,
    expectedParent: record.expectedParent,
  };
}

/**
 * The one head CAS rule, shared by finalization and sealed-reset recovery: the
 * pointer and the completion-pending record are written by the same durable
 * write, so a committed head is never observable as an uncommitted operation.
 */
function sealedCas(
  current: CandidateControlStateV1,
  operationId: string,
  resultRootId: Sha256Hex,
): CandidateControlUpdate<HeadPointerV1> {
  const operation = current.operation;
  if (operation === null || operation.operationId !== operationId) {
    throw new CandidateOperationRefused(`candidate head CAS lost operation ${operationId}`);
  }
  if (operation.phase === 'completion-pending' || operation.phase === 'published') {
    if (operation.resultRootId !== resultRootId || current.head === null || current.head.rootEnvelopeId !== resultRootId) {
      throw new CandidateOperationRefused(`candidate operation ${operationId} already committed a different root`);
    }
    return { next: null, result: current.head };
  }
  if (operation.phase !== 'sealed' || operation.resultRootId !== resultRootId) {
    throw new CandidateOperationRefused(`candidate head CAS lacks a sealed ${resultRootId} operation`);
  }
  const currentHead = current.head?.rootEnvelopeId ?? null;
  if (currentHead !== resultRootId && currentHead !== operation.expectedParent) {
    throw new StaleParentRefused(operation.expectedParent, currentHead);
  }
  const head: HeadPointerV1 = current.head !== null && currentHead === resultRootId
    ? current.head
    : { version: 1, rootEnvelopeId: resultRootId, lastOperationId: operationId };
  return {
    next: {
      version: 1,
      head,
      operation: v.parse(OperationRecordSchema, {
        ...operationBase(operation),
        phase: 'completion-pending',
        attemptId: operation.attemptId,
        resultRootId,
      }),
    },
    result: head,
  };
}
async function compareAndSwapActiveHead(input: {
  readonly active: TransferringOperation;
  readonly store: CandidateControlStore;
  readonly expectedParentRootId: string | null;
  readonly resultRootId: Sha256Hex;
}): Promise<HeadPointerV1> {
  if (input.expectedParentRootId !== input.active.expectedParent) {
    throw new CandidateOperationRefused('candidate head CAS names a different expected parent');
  }
  return await input.store.update((current) => sealedCas(current, input.active.operationId, input.resultRootId));
}

/** The completion mark. A reset before it re-runs exactly this step. */
function publishMark(
  current: CandidateControlStateV1,
  operationId: string,
): CandidateControlUpdate<CandidateControlStateV1> {
  const operation = current.operation;
  if (operation === null || operation.operationId !== operationId) {
    throw new CandidateOperationRefused(`candidate completion names no operation ${operationId}`);
  }
  if (operation.phase === 'published') return { next: null, result: current };
  if (operation.phase !== 'completion-pending') {
    throw new CandidateOperationRefused(`candidate operation cannot complete from ${operation.phase}`);
  }
  if (current.head === null || current.head.rootEnvelopeId !== operation.resultRootId) {
    throw new CandidateOperationRefused('candidate completion head does not bind its sealed result');
  }
  const next: CandidateControlStateV1 = {
    version: 1,
    head: current.head,
    operation: v.parse(OperationRecordSchema, {
      ...operationBase(operation),
      phase: 'published',
      resultRootId: operation.resultRootId,
    }),
  };
  return { next, result: next };
}

/** The terminal failure record. The first failure wins and the head is untouched. */
function failMark(
  current: CandidateControlStateV1,
  operationId: string,
  failureCode: string,
): CandidateControlUpdate<CandidateControlStateV1> {
  const operation = current.operation;
  if (
    operation === null
    || operation.operationId !== operationId
    || operation.phase === 'completion-pending'
    || operation.phase === 'published'
    || operation.phase === 'failed'
  ) {
    return { next: null, result: current };
  }
  const next: CandidateControlStateV1 = {
    version: 1,
    head: current.head,
    operation: v.parse(OperationRecordSchema, { ...operationBase(operation), phase: 'failed', failureCode }),
  };
  return { next, result: next };
}

/**
 * Finish an operation a reset interrupted after its payload sealed. The sealed
 * envelope is immutable and digest-addressed, so recovery resumes the original
 * expected-parent CAS instead of re-staging anything.
 */
async function recoverOperation(
  active: CommittedOperation,
  store: CandidateControlStore,
  envelopes: CandidateEnvelopeStore,
  verifyObject: VerifyObject,
): Promise<CandidateControlStateV1> {
  if (active.phase === 'sealed') {
    const envelope = await envelopes.read(active.resultRootId);
    if (envelope.parentRootId !== active.expectedParent) {
      throw new CandidateOperationRefused(
        `candidate sealed envelope ${active.resultRootId} names a different expected parent`,
      );
    }
    try {
      await verifyEnvelopeClosure(envelope, verifyObject);
    } catch (error) {
      await store.update((current) => failMark(current, active.operationId, 'closure-unavailable'));
      throw error;
    }
    try {
      await store.update((current) => sealedCas(current, active.operationId, active.resultRootId));
    } catch (error) {
      // Another writer published first. This result can never win, and leaving
      // it sealed would wedge every later operation behind a dead recovery.
      if (!(error instanceof StaleParentRefused)) throw error;
      return await store.update((current) => failMark(current, active.operationId, 'stale-parent'));
    }
  }
  return await store.update((current) => publishMark(current, active.operationId));
}

/**
 * Re-drive an operation whose payload never sealed. A new container boot takes
 * a fresh attempt and a higher epoch, which fences every receipt the previous
 * boot may still be holding.
 */
async function redriveOperation(
  active: OperationRecord,
  bootId: string,
  store: CandidateControlStore,
): Promise<CandidateControlStateV1> {
  return await store.update((current) => {
    const operation = current.operation;
    if (
      operation === null
      || operation.operationId !== active.operationId
      || (operation.phase !== 'intent' && operation.phase !== 'transferring')
      || (
        active.phase === 'transferring'
        && (operation.phase !== 'transferring' || operation.attemptId !== active.attemptId)
      )
    ) {
      throw new CandidateOperationRefused(`candidate operation ${active.operationId} changed while re-driving`);
    }
    const next: CandidateControlStateV1 = {
      version: 1,
      head: current.head,
      operation: v.parse(OperationRecordSchema, {
        ...operationBase(operation),
        epoch: String(BigInt(operation.epoch) + 1n),
        bootId,
        phase: 'transferring',
        attemptId: crypto.randomUUID(),
      }),
    };
    return { next, result: next };
  });
}

/**
 * Fence a runner that terminated before it sealed its transfer, so the next
 * checkpoint receives a new attempt instead of rejoining that terminal process.
 */
export async function redriveCandidateOperation(input: {
  readonly active: OperationRecord;
  readonly store: CandidateControlStore;
  readonly envelopes: CandidateEnvelopeStore;
}): Promise<CandidateRunControlV1> {
  if (input.active.phase !== 'transferring') {
    throw new CandidateOperationRefused(`candidate operation ${input.active.operationId} is not transferring`);
  }
  return await runControl(
    await redriveOperation(input.active, input.active.bootId, input.store),
    input.envelopes,
  );
}

/**
 * Close an operation whose fenced journal manifest is already the published
 * head. No new envelope exists: the current pointer remains authoritative.
 */
export async function settleCandidateNoChange(input: {
  readonly active: TransferringOperation;
  readonly store: CandidateControlStore;
}): Promise<CandidateControlStateV1> {
  return await input.store.update((current) => {
    const operation = current.operation;
    if (operation?.operationId === input.active.operationId && operation.phase === 'published') {
      if (operation.resultRootId !== input.active.expectedParent) {
        throw new CandidateOperationRefused(
          `candidate no-change operation ${input.active.operationId} settled a different head`,
        );
      }
      return { next: null, result: current };
    }
    if (
      operation === null
      || operation.operationId !== input.active.operationId
      || operation.phase !== 'transferring'
      || operation.attemptId !== input.active.attemptId
    ) {
      throw new CandidateOperationRefused(
        `candidate no-change operation ${input.active.operationId} changed before settlement`,
      );
    }
    if (input.active.expectedParent === null || current.head?.rootEnvelopeId !== input.active.expectedParent) {
      throw new CandidateOperationRefused(
        `candidate no-change operation ${input.active.operationId} no longer names the published head`,
      );
    }
    const next: CandidateControlStateV1 = {
      version: 1,
      head: current.head,
      operation: v.parse(OperationRecordSchema, {
        ...operationBase(operation),
        phase: 'published',
        resultRootId: input.active.expectedParent,
      }),
    };
    return { next, result: next };
  });
}

async function freshOperation(
  observed: CandidateControlStateV1,
  kind: OperationRecord['kind'],
  bootId: string,
  store: CandidateControlStore,
  envelopes: CandidateEnvelopeStore,
): Promise<CandidateControlStateV1> {
  const parent = observed.head === null ? null : await envelopes.read(observed.head.rootEnvelopeId);
  const operation = v.parse(OperationRecordSchema, {
    operationId: crypto.randomUUID(),
    kind,
    epoch: String(parent === null ? 0n : BigInt(parent.epoch) + 1n),
    bootId,
    baseRevision: parent === null ? '0' : parent.cut.cut,
    expectedParent: observed.head?.rootEnvelopeId ?? null,
    phase: 'transferring',
    attemptId: crypto.randomUUID(),
  });
  return await store.update((current) => {
    const busy = current.operation !== null
      && current.operation.phase !== 'published'
      && current.operation.phase !== 'failed';
    if (busy || (current.head?.rootEnvelopeId ?? null) !== (observed.head?.rootEnvelopeId ?? null)) {
      throw new CandidateOperationRefused('candidate control changed while beginning an operation');
    }
    const next: CandidateControlStateV1 = { version: 1, head: current.head, operation };
    return { next, result: next };
  });
}

async function runControl(
  control: CandidateControlStateV1,
  envelopes: CandidateEnvelopeStore,
): Promise<CandidateRunControlV1> {
  const pointer = control.head;
  return v.parse(CandidateRunControlV1Schema, {
    version: 1,
    head: pointer === null ? null : { pointer, envelope: await envelopes.read(pointer.rootEnvelopeId) },
    operation: control.operation,
  });
}

/**
 * The restore path: the durable pointer, the exact envelope it names, and a
 * check of that envelope's own objects. NOT of its closure — see
 * {@link verifyEnvelopeHead} for why a wake that walked it would scale with
 * the tree instead of with what the generation changed.
 */
export async function candidateRunControl(
  store: CandidateControlStore,
  envelopes: CandidateEnvelopeStore,
  verifyObject: VerifyObject,
): Promise<CandidateRunControlV1> {
  const control = await runControl(await store.read(), envelopes);
  if (control.head !== null) await verifyEnvelopeHead(control.head.envelope, verifyObject);
  return control;
}

/**
 * Begin the next operation. A prior operation is first driven to rest: one that
 * sealed is published, one that never sealed is re-driven under this boot.
 */
export async function beginCandidateOperation(input: {
  readonly kind: OperationRecord['kind'];
  readonly bootId: string;
  readonly store: CandidateControlStore;
  readonly envelopes: CandidateEnvelopeStore;
  readonly verifyObject: VerifyObject;
}): Promise<CandidateRunControlV1> {
  let control = await input.store.read();
  const active = control.operation;
  if (active !== null && active.phase !== 'published' && active.phase !== 'failed') {
    // A container has one journal fence. Different checkpoint kinds join this
    // transfer and re-run their own fence after it settles.
    if (active.phase === 'intent' || active.phase === 'transferring') {
      const redriven = active.phase === 'transferring' && active.bootId === input.bootId
        ? control
        : await redriveOperation(active, input.bootId, input.store);
      return await runControl(redriven, input.envelopes);
    }
    control = await recoverOperation(active, input.store, input.envelopes, input.verifyObject);
  }
  return await runControl(
    await freshOperation(control, input.kind, input.bootId, input.store, input.envelopes),
    input.envelopes,
  );
}

function controlPlane(input: {
  readonly active: TransferringOperation;
  readonly store: CandidateControlStore;
  readonly envelopes: CandidateEnvelopeStore;
  readonly verifyObject: VerifyObject;
}): CandidatePublicationControl {
  const active = input.active;
  return {
    recordOperation: async (record) => await input.store.update((current) => {
      const operation = current.operation;
      if (operation === null || operation.operationId !== active.operationId) {
        throw new CandidateOperationRefused('candidate operation changed before recording a transition');
      }
      if (
        record.operationId !== operation.operationId
        || record.kind !== operation.kind
        || record.epoch !== operation.epoch
        || record.bootId !== operation.bootId
        || record.baseRevision !== operation.baseRevision
        || record.expectedParent !== operation.expectedParent
      ) {
        throw new CandidateOperationRefused('candidate finalization attempted to change its control identity');
      }
      if ((record.phase === 'sealed' || record.phase === 'completion-pending') && record.attemptId !== active.attemptId) {
        throw new CandidateOperationRefused('candidate finalization attempted to change its attempt');
      }
      if (operation.phase === 'completion-pending' || operation.phase === 'published') {
        // The CAS and the completion mark already own these transitions durably.
        if (record.phase === 'intent' || record.phase === 'transferring' || record.phase === 'failed') {
          throw new CandidateOperationRefused('candidate committed operation is immutable');
        }
        if (record.resultRootId !== operation.resultRootId) {
          throw new CandidateOperationRefused('candidate committed operation names a different result root');
        }
        return { next: null, result: undefined };
      }
      const next: CandidateControlStateV1 = {
        version: 1,
        head: current.head,
        operation: record,
      };
      return { next, result: undefined };
    }),
    writeEnvelope: async (envelope, rootEnvelopeId) =>
      await input.envelopes.write(requireEnvelopeAt(envelope, rootEnvelopeId), rootEnvelopeId),
    verifyObject: input.verifyObject,
    compareAndSwapHead: async (envelope, expectedParentRootId) =>
      await compareAndSwapActiveHead({
        active,
        store: input.store,
        expectedParentRootId,
        resultRootId: envelopeIdOf(envelope),
      }),
    markComplete: async (operationId) => {
      await input.store.update((current) => publishMark(current, operationId));
    },
    markFailed: async (operationId, failureCode) => {
      await input.store.update((current) => failMark(current, operationId, failureCode));
    },
  };
}

/**
 * Seal and publish a staged draft against the begun operation. Replaying the
 * same draft is idempotent; a draft naming any other operation is refused.
 *
 * THE DRAFT BINDS THE OPERATION IN EVERY PHASE, not only while it transfers.
 * A re-drive bumps the epoch and the attempt, so the draft an earlier boot
 * staged stops binding the operation the moment a new boot takes it over —
 * and it stays unbound after that boot publishes. Answering such a draft with
 * the published control told the replaced boot its bytes were the head when
 * the head was the other boot's; it is answered as the loser it is.
 */
export async function finalizeCandidateOperation(input: {
  readonly draft: CandidatePublicationDraft;
  readonly boxId: string;
  readonly store: CandidateControlStore;
  readonly envelopes: CandidateEnvelopeStore;
  readonly verifyObject: VerifyObject;
}): Promise<CandidateControlStateV1> {
  const control = await input.store.read();
  const active = control.operation;
  const draft = input.draft;
  if (active === null) throw new CandidateOperationRefused('candidate finalization has no begun operation');
  if (draft.operationId !== active.operationId) {
    throw new CandidateOperationRefused(
      `candidate draft ${draft.operationId} is not active operation ${active.operationId}`,
    );
  }
  if (
    draft.capturedCut.captureId !== active.operationId
    || draft.capturedCut.epoch !== active.epoch
    || draft.capturedCut.baseRevision !== active.baseRevision
    || draft.expectedParentRootId !== active.expectedParent
    || ('attemptId' in active && draft.attemptId !== active.attemptId)
  ) {
    const head = control.head?.rootEnvelopeId ?? null;
    if (head !== draft.expectedParentRootId) throw new StaleParentRefused(draft.expectedParentRootId, head);
    throw new CandidateOperationRefused('candidate draft does not bind the begun control operation');
  }
  if (active.phase === 'published') return control;
  if (active.phase === 'failed') {
    throw new CandidateOperationRefused(
      `candidate operation ${active.operationId} failed with ${active.failureCode}`,
    );
  }
  if (active.phase === 'sealed' || active.phase === 'completion-pending') {
    return await recoverOperation(active, input.store, input.envelopes, input.verifyObject);
  }
  if (active.phase === 'intent') {
    throw new CandidateOperationRefused(`candidate operation ${active.operationId} never began a transfer`);
  }
  try {
    await finalizeCandidatePayload(draft, {
      operationId: active.operationId,
      attemptId: active.attemptId,
      boxId: input.boxId,
      epoch: active.epoch,
      bootId: active.bootId,
      kind: active.kind,
    }, controlPlane({
      active,
      store: input.store,
      envelopes: input.envelopes,
      verifyObject: input.verifyObject,
    }));
  } catch (error) {
    // The head is durably committed; the next begin re-marks the pending completion.
    if (!(error instanceof PublicationCompletionPending)) throw error;
  }
  return await input.store.read();
}

// ── v2: one CAS, no closure walk ─────────────────────────────────────────────
//
// The v2 control record is the SAME record: one head pointer and at most one
// operation, advanced by the same CAS and marked by the same completion. What
// changes is what the Durable Object reads to get there. A v1 attach verified
// every object in the head's closure and a v1 publish verified it again; a v2
// attach reads the row and the envelope, and a v2 publish verifies only the
// receipts of the packs it just wrote. The closure walk is gone from both.

/** Immutable v2 envelopes, addressed only by the digest of canonical bytes. */
export interface CandidateEnvelopeStoreV2 {
  write(envelope: RootEnvelopeV2, rootEnvelopeId: Sha256Hex): Promise<void>;
  read(rootEnvelopeId: Sha256Hex): Promise<RootEnvelopeV2>;
}

async function runControlV2(
  control: CandidateControlStateV1,
  envelopes: CandidateEnvelopeStoreV2,
): Promise<CandidateRunControlV2> {
  const pointer = control.head;
  return v.parse(CandidateRunControlV2Schema, {
    version: 2,
    head: pointer === null ? null : { pointer, envelope: await envelopes.read(pointer.rootEnvelopeId) },
    operation: control.operation,
  });
}

/**
 * Finish a v2 operation a reset interrupted after its payload sealed. The
 * sealed envelope is immutable and digest-addressed, so recovery resumes the
 * original expected-parent CAS; nothing is re-staged and nothing is verified
 * object by object.
 */
async function recoverOperationV2(
  active: CommittedOperation,
  store: CandidateControlStore,
  envelopes: CandidateEnvelopeStoreV2,
): Promise<CandidateControlStateV1> {
  if (active.phase === 'sealed') {
    const envelope = await envelopes.read(active.resultRootId);
    if (envelope.parentRootId !== active.expectedParent) {
      throw new CandidateOperationRefused(
        `candidate sealed v2 envelope ${active.resultRootId} names a different expected parent`,
      );
    }
    try {
      await store.update((current) => sealedCas(current, active.operationId, active.resultRootId));
    } catch (error) {
      // Another writer published first. This result can never win, and leaving
      // it sealed would wedge every later operation behind a dead recovery.
      if (!(error instanceof StaleParentRefused)) throw error;
      return await store.update((current) => failMark(current, active.operationId, 'stale-parent'));
    }
  }
  return await store.update((current) => publishMark(current, active.operationId));
}

/**
 * `freshOperation` reads the CURRENT head's envelope to learn the cut an
 * operation begins from, and that read is the only thing it wants from an
 * envelope store. A v2 head answers the same facts, so the v1-shaped seam is
 * satisfied by a reader that hands them over rather than by a second copy of
 * `freshOperation`. Writing through it is refused: a v2 operation publishes a
 * v2 envelope or nothing.
 */
function envelopesV1Bridge(envelopes: CandidateEnvelopeStoreV2): CandidateEnvelopeStore {
  return {
    write: async () => {
      throw new CandidateOperationRefused('a v2 operation never writes a v1 envelope');
    },
    read: async (rootEnvelopeId) => {
      const envelope = await envelopes.read(rootEnvelopeId);
      return {
        version: 1,
        format: envelope.format,
        boxId: envelope.boxId,
        epoch: envelope.epoch,
        generation: envelope.generation,
        parentRootId: envelope.parentRootId,
        cut: envelope.cut,
        rootObject: {
          key: envelope.rootObject.key,
          byteLength: envelope.rootObject.byteLength,
          sha256: envelope.rootObject.sha256,
        },
        closure: [],
        closureObject: envelope.ledger,
      };
    },
  };
}

/**
 * Begin the next v2 operation, driving any prior one to rest first: one that
 * sealed is completed from its record, one that never sealed is re-driven
 * under this boot.
 */
export async function beginCandidateOperationV2(input: {
  readonly kind: OperationRecord['kind'];
  readonly bootId: string;
  readonly store: CandidateControlStore;
  readonly envelopes: CandidateEnvelopeStoreV2;
}): Promise<CandidateRunControlV2> {
  let control = await input.store.read();
  const active = control.operation;
  if (active !== null && active.phase !== 'published' && active.phase !== 'failed') {
    if (active.phase === 'intent' || active.phase === 'transferring') {
      const redriven = active.phase === 'transferring' && active.bootId === input.bootId
        ? control
        : await redriveOperation(active, input.bootId, input.store);
      return await runControlV2(redriven, input.envelopes);
    }
    control = await recoverOperationV2(active, input.store, input.envelopes);
  }
  return await runControlV2(
    await freshOperation(control, input.kind, input.bootId, input.store, envelopesV1Bridge(input.envelopes)),
    input.envelopes,
  );
}

function controlPlaneV2(input: {
  readonly active: TransferringOperation;
  readonly store: CandidateControlStore;
  readonly envelopes: CandidateEnvelopeStoreV2;
}): CandidatePublicationControlV2 {
  const active = input.active;
  return {
    recordOperation: async (record) => await input.store.update((current) => {
      const operation = current.operation;
      if (operation === null || operation.operationId !== active.operationId) {
        throw new CandidateOperationRefused('candidate operation changed before recording a transition');
      }
      if (
        record.operationId !== operation.operationId
        || record.kind !== operation.kind
        || record.epoch !== operation.epoch
        || record.bootId !== operation.bootId
        || record.baseRevision !== operation.baseRevision
        || record.expectedParent !== operation.expectedParent
      ) {
        throw new CandidateOperationRefused('candidate finalization attempted to change its control identity');
      }
      if (
        (record.phase === 'sealed' || record.phase === 'completion-pending')
        && record.attemptId !== active.attemptId
      ) {
        throw new CandidateOperationRefused('candidate finalization attempted to change its attempt');
      }
      if (operation.phase === 'completion-pending' || operation.phase === 'published') {
        if (record.phase === 'intent' || record.phase === 'transferring' || record.phase === 'failed') {
          throw new CandidateOperationRefused('candidate committed operation is immutable');
        }
        if (record.resultRootId !== operation.resultRootId) {
          throw new CandidateOperationRefused('candidate committed operation names a different result root');
        }
        return { next: null, result: undefined };
      }
      return { next: { version: 1, head: current.head, operation: record }, result: undefined };
    }),
    writeEnvelope: async (envelope, rootEnvelopeId) => {
      if (envelopeV2IdOf(envelope) !== rootEnvelopeId) {
        throw new CandidateOperationRefused(`candidate v2 envelope does not match pointer ${rootEnvelopeId}`);
      }
      await input.envelopes.write(envelope, rootEnvelopeId);
    },
    compareAndSwapHead: async (envelope, expectedParentRootId) =>
      await compareAndSwapActiveHead({
        active,
        store: input.store,
        expectedParentRootId,
        resultRootId: envelopeV2IdOf(envelope),
      }),
    markComplete: async (operationId) => {
      await input.store.update((current) => publishMark(current, operationId));
    },
    markFailed: async (operationId, failureCode) => {
      await input.store.update((current) => failMark(current, operationId, failureCode));
    },
  };
}

/**
 * Seal and publish a staged v2 draft against the begun operation. Replaying
 * one draft is idempotent, and a draft naming any other operation — an earlier
 * boot's, after a re-drive bumped the epoch — is refused as the loser it is.
 */
export async function finalizeCandidateOperationV2(input: {
  readonly draft: CandidatePublicationDraftV2;
  readonly boxId: string;
  readonly store: CandidateControlStore;
  readonly envelopes: CandidateEnvelopeStoreV2;
}): Promise<CandidateControlStateV1> {
  const control = await input.store.read();
  const active = control.operation;
  const draft = input.draft;
  if (active === null) throw new CandidateOperationRefused('candidate finalization has no begun operation');
  if (draft.operationId !== active.operationId) {
    throw new CandidateOperationRefused(
      `candidate draft ${draft.operationId} is not active operation ${active.operationId}`,
    );
  }
  if (
    draft.capturedCut.captureId !== active.operationId
    || draft.capturedCut.epoch !== active.epoch
    || draft.capturedCut.baseRevision !== active.baseRevision
    || draft.expectedParentRootId !== active.expectedParent
    || ('attemptId' in active && draft.attemptId !== active.attemptId)
  ) {
    const head = control.head?.rootEnvelopeId ?? null;
    if (head !== draft.expectedParentRootId) throw new StaleParentRefused(draft.expectedParentRootId, head);
    throw new CandidateOperationRefused('candidate draft does not bind the begun control operation');
  }
  if (active.phase === 'published') return control;
  if (active.phase === 'failed') {
    throw new CandidateOperationRefused(`candidate operation ${active.operationId} failed with ${active.failureCode}`);
  }
  if (active.phase === 'sealed' || active.phase === 'completion-pending') {
    return await recoverOperationV2(active, input.store, input.envelopes);
  }
  if (active.phase === 'intent') {
    throw new CandidateOperationRefused(`candidate operation ${active.operationId} never began a transfer`);
  }
  try {
    await finalizeCandidatePayloadV2(draft, {
      operationId: active.operationId,
      attemptId: active.attemptId,
      boxId: input.boxId,
      epoch: active.epoch,
      bootId: active.bootId,
      kind: active.kind,
    }, controlPlaneV2({ active, store: input.store, envelopes: input.envelopes }));
  } catch (error) {
    // The head is durably committed; the next begin re-marks the completion.
    if (!(error instanceof PublicationCompletionPendingV2)) throw error;
  }
  return await input.store.read();
}


/**
 * Record that an operation will never publish.
 *
 * A seal that dies before the head CAS — a refused ETag, a transport that
 * dropped, a stage that vanished — leaves a `transferring` record behind, and
 * the next seal would JOIN that transfer rather than start one, waiting on
 * bytes nobody is still uploading. This is how a container-side failure
 * becomes a durable fact the next begin can step past. The first failure
 * wins, a committed operation is untouched, and the head never moves.
 */
export async function failCandidateOperation(input: {
  readonly operationId: string;
  readonly failureCode: string;
  readonly store: CandidateControlStore;
}): Promise<CandidateControlStateV1> {
  return await input.store.update((current) => failMark(current, input.operationId, input.failureCode));
}