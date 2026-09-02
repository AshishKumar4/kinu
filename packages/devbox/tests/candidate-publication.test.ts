import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

import { sha256Hex } from '../src/cas/hash';
import { AuditedCapture, MutationLog, tick, toCapturedCut } from '../src/capture/model';
import {
  CapturedCutSchema,
  ImmutableObjectRefSchema,
  RootEnvelopeV1Schema,
} from '../src/durability/contracts';
import type {
  CapturedCut,
  HeadPointerV1,
  ImmutableObjectRef,
  ObjectReceipt,
  OperationRecord,
  PayloadGrant,
  RootEnvelopeV1,
  UploadIntent,
} from '../src/durability/contracts';
import {
  FileCandidateObjectSink,
  MemoryCandidateObjectSink,
  PublicationCompletionPending,
  PublicationInterrupted,
  StaleParentRefused,
  envelopeBytes,
  envelopeIdOf,
  finalizeCandidatePayload,
  parseEnvelopeBytes,
  planCandidatePublication,
  stageCandidatePayload,
  streamStagedCandidateObject,
} from '../src/candidates/publication';
import type {
  CandidateObjectSink,
  CandidatePayloadStore,
  CandidatePublicationControl,
  CandidatePublicationDraft,
  CandidatePublicationPlan,
  PublishIdentityInput,
} from '../src/candidates/publication';
import {
  beginCandidateOperation,
  candidateRunControl,
  finalizeCandidateOperation,
  settleCandidateNoChange,
  type CandidateEnvelopeStore,
} from '../src/candidates/control';
import { candidateContainerStorage, candidateStorePaths, type CandidateStorePaths } from '../src/candidates/container';
import type { CandidateContainerPorts } from '../src/candidates/container';
import type { CandidateRunControlV1 } from '../src/durability/contracts';
import { ControlReset, MemoryControlStore, MemoryEnvelopeStore } from './support/candidate-control';

const enc = new TextEncoder();
const dec = new TextDecoder();
const SHA = 'a'.repeat(64);

const capture = await (async () => {
  const log = new MutationLog();
  await log.perform({ op: 'write', path: 'captured.txt', content: { kind: 'dense', bytes: enc.encode('captured') } });
  return toCapturedCut(
    log.entries,
    {
      mechanism: 'mutation-journal',
      cut: log.lastSeq,
      generation: log.generation,
      entries: log.paths().map((path) => log.entryOf(path)!),
    },
    { captureId: 'cap-1', epoch: '7', baseRevision: '8', stableStageHandle: 'stage-9' },
  );
})();

const identity: PublishIdentityInput = {
  operationId: 'op-1',
  attemptId: 'attempt-1',
  boxId: 'box-b',
  epoch: '7',
  bootId: 'boot-1',
  kind: 'tick',
  expiresAt: '1000',
};

function ref(key: string, bytes: Uint8Array): ImmutableObjectRef {
  return v.parse(ImmutableObjectRefSchema, {
    key,
    byteLength: String(bytes.byteLength),
    sha256: sha256Hex(bytes),
  });
}

function capturedCutFixture(cut = '42'): CapturedCut {
  return v.parse(CapturedCutSchema, {
    captureId: 'cap-1',
    epoch: '7',
    baseRevision: '8',
    cut,
    stableStageHandle: 'stage-9',
    manifestSha256: SHA,
  });
}
function seedEnvelopeFor(cut: string, rootText: string): RootEnvelopeV1 {
  const rootObject = ref('v1/boxes/b/roots/root-0', enc.encode(rootText));
  const closureBytes = canonicalClosure([rootObject]);
  return v.parse(RootEnvelopeV1Schema, {
    version: 1,
    format: 'bounded-layers/v1',
    boxId: 'box-b',
    epoch: '6',
    generation: '8',
    parentRootId: null,
    cut: capturedCutFixture(cut),
    rootObject,
    closure: [rootObject],
    closureObject: ref('closure/seed', closureBytes),
  });
}

function canonicalClosure(refs: readonly ImmutableObjectRef[]): Uint8Array {
  const sorted = [...refs]
    .map((item) => ({ key: item.key, byteLength: item.byteLength, sha256: item.sha256 }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return enc.encode(`${JSON.stringify(sorted)}\n`);
}

function receiptFor(input: PublishIdentityInput, item: ImmutableObjectRef): ObjectReceipt {
  return {
    operationId: input.operationId,
    attemptId: input.attemptId,
    key: item.key,
    byteLength: item.byteLength,
    sha256: item.sha256,
    etag: `etag-${item.sha256.slice(0, 8)}`,
    verified: true,
  };
}

async function makePlan(
  sink: CandidateObjectSink,
  expectedParentRootId: string | null,
  reused: readonly ImmutableObjectRef[] = [],
  rootText = 'root-bytes',
): Promise<CandidatePublicationPlan> {
  const dependencies = await Promise.all([
    sink.stage('v1/boxes/b/objects/delta-0', enc.encode('delta-bytes')),
    sink.stage('v1/boxes/b/objects/index', enc.encode('index-bytes')),
  ]);
  const root = await sink.stage('v1/boxes/b/roots/root-1', enc.encode(rootText));
  return await planCandidatePublication({
    format: 'merkle-pack/v1',
    expectedParentRootId,
    capture,
    sink,
    dependencies,
    root,
    reused,
  });
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    length += next.value.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

class ResetOperation extends PublicationInterrupted {
  constructor(readonly at: string) {
    super(`reset at ${at}`);
    this.name = 'ResetOperation';
  }
}

type FaultPoint = 'issue-payload-grant' | 'upload-object' | 'verify-object' | 'write-envelope' | 'publish-head';

/** Payload transport and DO control plane meet only at durable object metadata. */
class InMemoryPublicationBoundary implements CandidatePayloadStore, CandidatePublicationControl {
  readonly payloads = new Map<string, Uint8Array>();
  readonly envelopes = new Map<string, Uint8Array>();
  readonly uploads: string[] = [];
  readonly records: OperationRecord[] = [];
  readonly failures = new Map<string, string>();
  readonly faults = new Set<FaultPoint>();
  readonly corruptKeys = new Set<string>();
  head: { envelope: RootEnvelopeV1; pointer: HeadPointerV1 } | null = null;
  failCompletion = false;

  constructor(seedHead?: RootEnvelopeV1) {
    if (seedHead) {
      this.head = {
        envelope: seedHead,
        pointer: { version: 1, rootEnvelopeId: envelopeIdOf(seedHead), lastOperationId: 'op-seed' },
      };
    }
  }

  private async fault(point: FaultPoint): Promise<void> {
    if (this.faults.delete(point)) throw new ResetOperation(point);
    await tick();
  }

  recordOperation(record: OperationRecord): void {
    this.records.push(record);
  }

  markFailed(operationId: string, failureCode: string): void {
    if (!this.failures.has(operationId)) this.failures.set(operationId, failureCode);
  }

  async issuePayloadGrant(intent: UploadIntent): Promise<PayloadGrant> {
    await this.fault('issue-payload-grant');
    return {
      operationId: intent.operationId,
      attemptId: intent.attemptId,
      expiresAt: intent.expiresAt,
      opaque: `grant:${intent.exactKey}`,
    };
  }

  async uploadObject(grant: PayloadGrant, body: ReadableStream<Uint8Array>): Promise<ObjectReceipt> {
    await this.fault('upload-object');
    const key = grant.opaque.slice('grant:'.length);
    const source = await readStream(body);
    const bytes = this.corruptKeys.has(key) ? enc.encode('corrupted') : source;
    this.payloads.set(key, bytes.slice());
    this.uploads.push(key);
    return receiptFor(
      { ...identity, operationId: grant.operationId, attemptId: grant.attemptId, expiresAt: grant.expiresAt },
      ref(key, bytes),
    );
  }

  async verifyObject(item: ImmutableObjectRef): Promise<void> {
    await this.fault('verify-object');
    const bytes = this.payloads.get(item.key);
    if (bytes === undefined) throw new Error(`missing candidate object ${item.key}`);
    if (String(bytes.byteLength) !== item.byteLength || sha256Hex(bytes) !== item.sha256) {
      throw new Error(`candidate object metadata mismatches immutable ref: ${item.key}`);
    }
  }

  async writeEnvelope(envelope: RootEnvelopeV1, rootEnvelopeId: string): Promise<void> {
    await this.fault('write-envelope');
    if (rootEnvelopeId !== envelopeIdOf(envelope)) throw new Error('envelope key does not match canonical bytes');
    const bytes = envelopeBytes(envelope);
    const existing = this.envelopes.get(rootEnvelopeId);
    if (
      existing !== undefined
      && (existing.byteLength !== bytes.byteLength || !existing.every((byte, index) => byte === bytes[index]))
    ) {
      throw new Error('immutable envelope key already holds different bytes');
    }
    this.envelopes.set(rootEnvelopeId, bytes);
  }

  async compareAndSwapHead(
    envelope: RootEnvelopeV1,
    expectedParentRootId: string | null,
  ): Promise<HeadPointerV1> {
    await this.fault('publish-head');
    const current = this.head?.pointer.rootEnvelopeId ?? null;
    const next = envelopeIdOf(envelope);
    if (current !== next && current !== expectedParentRootId) {
      throw new StaleParentRefused(expectedParentRootId, current);
    }
    if (current !== next) {
      this.head = {
        envelope,
        pointer: { version: 1, rootEnvelopeId: next, lastOperationId: 'op-current' },
      };
    }
    return this.head!.pointer;
  }

  async markComplete(): Promise<void> {
    if (this.failCompletion) {
      this.failCompletion = false;
      throw new Error('completion store unavailable');
    }
    await tick();
  }
}

function closureRef(item: ObjectReceipt): ImmutableObjectRef {
  return { key: item.key, byteLength: item.byteLength, sha256: item.sha256 };
}

describe('candidate payload staging and finalization', () => {
  test('stages direct streams, includes reused refs in a canonical closure, then finalizes', async () => {
    const sink = new MemoryCandidateObjectSink();
    const reused = ref('v1/boxes/b/objects/reused-0', enc.encode('already-remote'));
    const plan = await makePlan(sink, null, [reused]);
    const boundary = new InMemoryPublicationBoundary();
    boundary.payloads.set(reused.key, enc.encode('already-remote'));

    const draft = await stageCandidatePayload(plan, identity, boundary);
    expect(boundary.uploads).toEqual([
      'v1/boxes/b/objects/delta-0',
      'v1/boxes/b/objects/index',
      'v1/boxes/b/roots/root-1',
      plan.closureObject.ref.key,
    ]);
    const expectedClosure = [...plan.dependencies.map((item) => item.ref), plan.root.ref, reused];
    expect(dec.decode(boundary.payloads.get(plan.closureObject.ref.key))).toBe(
      dec.decode(canonicalClosure(expectedClosure)),
    );

    const published = await finalizeCandidatePayload(draft, identity, boundary);
    expect(published.resultRootId).toBe(envelopeIdOf(published.envelope));
    expect(published.head.rootEnvelopeId).toBe(published.resultRootId);
    expect(boundary.records.map((record) => record.phase)).toEqual(['sealed', 'published']);
  });
  test('refuses a deleted reused closure ref before CAS', async () => {
    const reusedBytes = enc.encode('already-remote');
    const reused = ref('v1/boxes/b/objects/reused-0', reusedBytes);
    const boundary = new InMemoryPublicationBoundary();
    boundary.payloads.set(reused.key, reusedBytes);
    const draft = await stageCandidatePayload(
      await makePlan(new MemoryCandidateObjectSink(), null, [reused]),
      identity,
      boundary,
    );
    boundary.payloads.delete(reused.key);

    await expect(finalizeCandidatePayload(draft, identity, boundary)).rejects.toThrow('missing candidate object');
    expect(boundary.failures.get(identity.operationId)).toBe('closure-unavailable');
    expect(boundary.head).toBeNull();
  });

  test('copies both memory and file-backed sink inputs before the caller mutates them', async () => {
    const memorySource = enc.encode('sealed source');
    const memoryObject = await new MemoryCandidateObjectSink().stage('memory', memorySource);
    memorySource.fill(0);

    const files = new Map<string, Uint8Array>();
    const fileSink = new FileCandidateObjectSink({
      async write(key, bytes) {
        files.set(key, bytes.slice());
      },
      open(key) {
        const bytes = files.get(key);
        if (bytes === undefined) throw new Error(`missing staged file ${key}`);
        return new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice());
            controller.close();
          },
        });
      },
    });
    const fileSource = enc.encode('file source');
    const fileObject = await fileSink.stage('file', fileSource);
    fileSource.fill(0);

    expect(await readStream(streamStagedCandidateObject(memoryObject))).toEqual(enc.encode('sealed source'));
    expect(await readStream(streamStagedCandidateObject(fileObject))).toEqual(enc.encode('file source'));
  });

  test('rejects a receipt mismatch during the payload phase without advancing a head', async () => {
    const seed = seedEnvelopeFor('41', 'old-root');
    const boundary = new InMemoryPublicationBoundary(seed);
    boundary.corruptKeys.add('v1/boxes/b/objects/delta-0');

    await expect(stageCandidatePayload(await makePlan(new MemoryCandidateObjectSink(), envelopeIdOf(seed)), identity, boundary))
      .rejects.toThrow('receipt mismatch');
    expect(boundary.head!.pointer.rootEnvelopeId).toBe(envelopeIdOf(seed));
    expect(boundary.records).toEqual([]);
  });

  test('leaves an existing head intact for each pre-commit payload or finalization interruption', async () => {
    const seed = seedEnvelopeFor('41', 'old-root');
    const parent = envelopeIdOf(seed);
    for (const point of ['issue-payload-grant', 'upload-object', 'verify-object', 'publish-head'] as const) {
      const boundary = new InMemoryPublicationBoundary(seed);
      const plan = await makePlan(new MemoryCandidateObjectSink(), parent);
      if (point === 'issue-payload-grant' || point === 'upload-object') {
        boundary.faults.add(point);
        await expect(stageCandidatePayload(plan, identity, boundary)).rejects.toBeInstanceOf(ResetOperation);
      } else {
        const draft = await stageCandidatePayload(plan, identity, boundary);
        boundary.faults.add(point);
        await expect(finalizeCandidatePayload(draft, identity, boundary)).rejects.toBeInstanceOf(ResetOperation);
      }
      expect(boundary.head!.pointer.rootEnvelopeId).toBe(parent);
    }
  });

  test('rejects a canonical closure which omits a fresh root receipt', async () => {
    const boundary = new InMemoryPublicationBoundary();
    const draft = await stageCandidatePayload(await makePlan(new MemoryCandidateObjectSink(), null), identity, boundary);
    const forgedDraft: CandidatePublicationDraft = {
      ...draft,
      closure: draft.dependencyReceipts.map(closureRef),
    };

    await expect(finalizeCandidatePayload(forgedDraft, identity, boundary)).rejects.toThrow(
      'candidate closure omits fresh receipt',
    );
    expect(boundary.head).toBeNull();
    expect(boundary.records).toEqual([]);
  });

  test('rejects a missing closure manifest before it creates a sealed operation', async () => {
    const boundary = new InMemoryPublicationBoundary();
    const draft = await stageCandidatePayload(await makePlan(new MemoryCandidateObjectSink(), null), identity, boundary);
    boundary.payloads.delete(draft.closureObject.key);

    await expect(finalizeCandidatePayload(draft, identity, boundary)).rejects.toThrow('missing candidate object');
    expect(boundary.failures.get(identity.operationId)).toBe('closure-unavailable');
    expect(boundary.head).toBeNull();
    expect(boundary.records).toEqual([]);
  });

  test('refuses a stale parent and retains the winner', async () => {
    const seed = seedEnvelopeFor('41', 'old-root');
    const parent = envelopeIdOf(seed);
    const boundary = new InMemoryPublicationBoundary(seed);
    const winnerInput = { ...identity, operationId: 'op-winner' };
    const winnerDraft = await stageCandidatePayload(
      await makePlan(new MemoryCandidateObjectSink(), parent, [], 'winner-root'),
      winnerInput,
      boundary,
    );
    const winner = await finalizeCandidatePayload(winnerDraft, winnerInput, boundary);

    const loserInput = { ...identity, operationId: 'op-loser' };
    const loserDraft = await stageCandidatePayload(
      await makePlan(new MemoryCandidateObjectSink(), parent, [], 'loser-root'),
      loserInput,
      boundary,
    );
    await expect(finalizeCandidatePayload(loserDraft, loserInput, boundary)).rejects.toBeInstanceOf(StaleParentRefused);
    expect(boundary.failures.get(loserInput.operationId)).toBe('stale-parent');
    expect(boundary.head!.pointer.rootEnvelopeId).toBe(winner.resultRootId);
  });

  test('records completion pending after the head commits and finalizes the same draft on retry', async () => {
    const boundary = new InMemoryPublicationBoundary();
    const draft = await stageCandidatePayload(await makePlan(new MemoryCandidateObjectSink(), null), identity, boundary);
    boundary.failCompletion = true;

    await expect(finalizeCandidatePayload(draft, identity, boundary)).rejects.toBeInstanceOf(PublicationCompletionPending);
    const committed = boundary.head!.pointer.rootEnvelopeId;
    expect(boundary.records.at(-1)).toMatchObject({ phase: 'completion-pending', resultRootId: committed });

    const published = await finalizeCandidatePayload(draft, identity, boundary);
    expect(published.resultRootId).toBe(committed);
    expect(boundary.records.at(-1)).toMatchObject({ phase: 'published', resultRootId: committed });
  });
});

// ── the durable control machine ──────────────────────────────────────────────

interface TestEnvelopeStore extends CandidateEnvelopeStore {
  readonly objects: Map<string, Uint8Array>;
}

/** The R2 control plane uses full object keys, not payload-mount-relative keys. */
class R2EnvelopeStore implements TestEnvelopeStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly r2 = new Map<string, Uint8Array>();

  constructor(private readonly paths: CandidateStorePaths) {}

  key(rootEnvelopeId: string): string {
    return `${this.paths.envelopePrefix}/${rootEnvelopeId}.json`;
  }

  async write(envelope: RootEnvelopeV1, rootEnvelopeId: string): Promise<void> {
    const key = this.key(rootEnvelopeId);
    const existing = this.r2.get(key);
    if (existing !== undefined) {
      parseEnvelopeBytes(existing, rootEnvelopeId);
      return;
    }
    const bytes = envelopeBytes(envelope);
    this.r2.set(key, bytes);
    this.objects.set(rootEnvelopeId, bytes);
  }

  async read(rootEnvelopeId: string): Promise<RootEnvelopeV1> {
    const bytes = this.r2.get(this.key(rootEnvelopeId));
    if (bytes === undefined) throw new Error(`candidate envelope is absent: ${rootEnvelopeId}`);
    return parseEnvelopeBytes(bytes, rootEnvelopeId);
  }
}

/** One arm: payload transport in memory, control through the production machine. */
class ControlHarness {
  readonly payloads = new InMemoryPublicationBoundary();
  readonly store = new MemoryControlStore();

  constructor(readonly envelopes: TestEnvelopeStore = new MemoryEnvelopeStore()) {}

  async begin(kind: OperationRecord['kind'] = 'tick', bootId = 'boot-1'): Promise<CandidateRunControlV1> {
    return await beginCandidateOperation({
      kind, bootId, store: this.store, envelopes: this.envelopes, verifyObject: this.payloads.verifyObject.bind(this.payloads),
    });
  }

  async stage(control: CandidateRunControlV1): Promise<CandidatePublicationDraft> {
    const operation = transferring(control);
    const sink = new MemoryCandidateObjectSink();
    const plan = await planCandidatePublication({
      format: 'merkle-pack/v1',
      expectedParentRootId: operation.expectedParent,
      capture: await captureFor(operation),
      sink,
      dependencies: [await sink.stage(`objects/delta-${operation.attemptId}`, enc.encode(`delta-${operation.epoch}`))],
      root: await sink.stage(`roots/root-${operation.attemptId}`, enc.encode(`root-${operation.epoch}`)),
    });
    return await stageCandidatePayload(plan, {
      operationId: operation.operationId,
      attemptId: operation.attemptId,
      boxId: 'box-b',
      epoch: operation.epoch,
      bootId: operation.bootId,
      kind: operation.kind,
      expiresAt: '1000',
    }, this.payloads);
  }

  async finalize(draft: CandidatePublicationDraft) {
    return await finalizeCandidateOperation({
      draft,
      boxId: 'box-b',
      store: this.store,
      envelopes: this.envelopes,
      verifyObject: this.payloads.verifyObject.bind(this.payloads),
    });
  }

  /** Begin, stage and publish one operation, then answer the committed root. */
  async publish(): Promise<string> {
    const finalized = await this.finalize(await this.stage(await this.begin()));
    const head = finalized.head;
    if (head === null) throw new Error('expected a published head');
    return head.rootEnvelopeId;
  }

  durableOperation(): OperationRecord {
    const operation = this.store.record.operation;
    if (operation === null) throw new Error('expected a durable operation');
    return operation;
  }
}

function transferring(control: CandidateRunControlV1) {
  const operation = control.operation;
  if (operation === null || operation.phase !== 'transferring') {
    throw new Error(`expected a transferring operation, got ${operation?.phase ?? 'none'}`);
  }
  return operation;
}

async function captureFor(operation: OperationRecord): Promise<AuditedCapture> {
  const log = new MutationLog();
  await log.perform({
    op: 'write', path: 'captured.txt', content: { kind: 'dense', bytes: enc.encode(`captured-${operation.epoch}`) },
  });
  return toCapturedCut(log.entries, {
    mechanism: 'mutation-journal',
    cut: log.lastSeq,
    generation: log.generation,
    entries: log.paths().map((path) => log.entryOf(path)!),
  }, {
    captureId: operation.operationId,
    epoch: operation.epoch,
    baseRevision: operation.baseRevision,
    stableStageHandle: `stage-${operation.operationId}`,
  });
}

/** A head another writer published, readable by the harness under test. */
async function rivalHead(target: ControlHarness): Promise<HeadPointerV1> {
  const rival = new ControlHarness();
  const rootEnvelopeId = await rival.publish();
  const bytes = rival.envelopes.objects.get(rootEnvelopeId);
  if (bytes === undefined) throw new Error('rival envelope is missing');
  target.envelopes.objects.set(rootEnvelopeId, bytes);
  return { version: 1, rootEnvelopeId, lastOperationId: 'op-rival' };
}

describe('candidate durable control', () => {
  test('seals a result durably before the head commits, then marks it published', async () => {
    const harness = new ControlHarness();
    const root = await harness.publish();

    expect(harness.store.writes).toEqual(['transferring', 'sealed', 'completion-pending', 'published']);
    expect(harness.durableOperation()).toMatchObject({ phase: 'published', resultRootId: root });
    expect(harness.store.record.head).toEqual({
      version: 1, rootEnvelopeId: root, lastOperationId: harness.durableOperation().operationId,
    });
    expect([...harness.envelopes.objects.keys()]).toEqual([root]);
  });

  test('keeps the published envelope outside the replaced payload mount for a later attach', async () => {
    const paths = candidateStorePaths('boxes/box-b', 'merkle-pack');
    const envelopes = new R2EnvelopeStore(paths);
    const published = new ControlHarness(envelopes);
    const rootEnvelopeId = await published.publish();

    expect(paths.mountPrefix).toBe('/boxes/box-b/candidate/merkle-pack');
    expect(paths.envelopePrefix).toBe('boxes/box-b/candidate-control/merkle-pack/envelopes');
    expect(paths.envelopePrefix.startsWith(`${paths.payloadPrefix}/`)).toBeFalse();
    expect([...envelopes.r2.keys()]).toEqual([envelopes.key(rootEnvelopeId)]);

    // A replacement has only the durable head, the direct control object, and
    // the mounted payload closure. It cannot recover any container-local state.
    const attached = await candidateRunControl(
      published.store,
      envelopes,
      published.payloads.verifyObject.bind(published.payloads),
    );
    expect(attached.head?.pointer.rootEnvelopeId).toBe(rootEnvelopeId);
  });

  test('re-drives an operation left at intent with a fresh attempt and epoch', async () => {
    const harness = new ControlHarness();
    harness.store.record = {
      version: 1,
      head: null,
      operation: {
        operationId: 'op-intent',
        kind: 'tick',
        epoch: '4',
        bootId: 'boot-0',
        baseRevision: '2',
        expectedParent: null,
        phase: 'intent',
      },
    };

    const begun = transferring(await harness.begin());
    expect(begun).toMatchObject({ operationId: 'op-intent', epoch: '5', bootId: 'boot-1', baseRevision: '2' });
    expect(begun.attemptId.length).toBeGreaterThan(0);
  });

  test('keeps the granted attempt when the same boot begins again', async () => {
    const harness = new ControlHarness();
    const first = await harness.begin();

    expect(await harness.begin()).toEqual(first);
    expect(harness.store.writes).toEqual(['transferring']);
  });

  test('a new boot re-drives the transfer and refuses the stale attempt', async () => {
    const harness = new ControlHarness();
    const first = transferring(await harness.begin());
    const staleDraft = await harness.stage(await harness.begin());
    const redriven = transferring(await harness.begin('tick', 'boot-2'));

    expect(redriven.operationId).toBe(first.operationId);
    expect(redriven.attemptId).not.toBe(first.attemptId);
    expect(redriven.epoch).toBe(String(BigInt(first.epoch) + 1n));
    expect(redriven.bootId).toBe('boot-2');
    await expect(harness.finalize(staleDraft)).rejects.toThrow('does not bind the begun control operation');
    expect(harness.durableOperation()).toMatchObject({ phase: 'transferring', attemptId: redriven.attemptId });
    expect(harness.store.record.head).toBeNull();
  });

  test('a reset at sealed publishes the same result root on the next begin', async () => {
    const harness = new ControlHarness();
    const draft = await harness.stage(await harness.begin());
    harness.store.resetAfterPhase = 'sealed';

    await expect(harness.finalize(draft)).rejects.toBeInstanceOf(ControlReset);
    const sealed = harness.durableOperation();
    expect(sealed.phase).toBe('sealed');
    expect(harness.store.record.head).toBeNull();
    const resultRootId = sealed.phase === 'sealed' ? sealed.resultRootId : '';
    expect(harness.envelopes.objects.has(resultRootId)).toBeTrue();

    const next = transferring(await harness.begin());
    expect(harness.store.record.head?.rootEnvelopeId).toBe(resultRootId);
    expect(next.expectedParent).toBe(resultRootId);
    expect(next.operationId).not.toBe(sealed.operationId);
    expect(harness.store.writes).toEqual([
      'transferring', 'sealed', 'completion-pending', 'published', 'transferring',
    ]);
  });

  test('a reset at completion-pending only re-marks the committed head', async () => {
    const harness = new ControlHarness();
    const draft = await harness.stage(await harness.begin());
    harness.store.resetAfterPhase = 'completion-pending';

    await expect(harness.finalize(draft)).rejects.toBeInstanceOf(ControlReset);
    const committed = harness.store.record.head?.rootEnvelopeId;
    expect(committed).toMatch(/^[0-9a-f]{64}$/);
    expect(harness.durableOperation().phase).toBe('completion-pending');

    const next = transferring(await harness.begin());
    expect(next.expectedParent).toBe(committed ?? null);
    expect(harness.store.record.head?.rootEnvelopeId).toBe(committed);
    expect(harness.store.writes.filter((phase) => phase === 'completion-pending')).toHaveLength(1);
    expect(harness.store.writes.filter((phase) => phase === 'published')).toHaveLength(1);
  });

  test('replays a published draft idempotently and refuses a draft from another operation', async () => {
    const harness = new ControlHarness();
    const draft = await harness.stage(await harness.begin());
    const published = await harness.finalize(draft);

    expect(await harness.finalize(draft)).toEqual(published);
    expect(harness.store.writes.filter((phase) => phase === 'published')).toHaveLength(1);

    await harness.begin();
    await expect(harness.finalize(draft)).rejects.toThrow('is not active operation');
  });

  test('joins a different checkpoint kind while one transfer is active', async () => {
    const harness = new ControlHarness();
    const tick = await harness.begin('tick');

    expect(await harness.begin('barrier')).toEqual(tick);
  });

  test('settles an unchanged fence without changing the immutable head', async () => {
    const harness = new ControlHarness();
    const root = await harness.publish();
    const begun = transferring(await harness.begin());

    await settleCandidateNoChange({ active: begun, store: harness.store });

    expect(harness.store.record.head?.rootEnvelopeId).toBe(root);
    expect(harness.durableOperation()).toMatchObject({
      operationId: begun.operationId,
      phase: 'published',
      resultRootId: root,
    });
  });

  test('refuses a stale parent, keeps the winner, and fails the loser terminally', async () => {
    const harness = new ControlHarness();
    const draft = await harness.stage(await harness.begin());
    const rival = await rivalHead(harness);
    harness.store.record = { version: 1, head: rival, operation: harness.store.record.operation };

    await expect(harness.finalize(draft)).rejects.toBeInstanceOf(StaleParentRefused);
    expect(harness.store.record.head).toEqual(rival);
    expect(harness.durableOperation()).toMatchObject({ phase: 'failed', failureCode: 'stale-parent' });

    expect(transferring(await harness.begin()).expectedParent).toBe(rival.rootEnvelopeId);
  });

  test('a sealed result that lost the race fails and unblocks the next operation', async () => {
    const harness = new ControlHarness();
    const draft = await harness.stage(await harness.begin());
    harness.store.resetAfterPhase = 'sealed';
    await expect(harness.finalize(draft)).rejects.toBeInstanceOf(ControlReset);
    const rival = await rivalHead(harness);
    harness.store.record = { version: 1, head: rival, operation: harness.store.record.operation };

    const next = transferring(await harness.begin());
    expect(harness.store.writes).toContain('failed');
    expect(next.expectedParent).toBe(rival.rootEnvelopeId);
    expect(harness.store.record.head).toEqual(rival);
  });

  test('refuses root, dependency, and closure deletion before CAS', async () => {
    for (const deleted of ['root', 'dependency', 'closure'] as const) {
      const harness = new ControlHarness();
      const control = await harness.begin();
      const draft = await harness.stage(control);
      const key = deleted === 'root'
        ? draft.root.key
        : deleted === 'dependency'
          ? draft.dependencyReceipts[0]!.key
          : draft.closureObject.key;
      harness.payloads.payloads.delete(key);

      await expect(harness.finalize(draft)).rejects.toThrow('missing candidate object');
      expect(harness.durableOperation()).toMatchObject({ phase: 'failed', failureCode: 'closure-unavailable' });
      expect(harness.store.record.head).toBeNull();
      expect(harness.envelopes.objects.size).toBe(0);
    }
  });

  test('refuses envelope bytes that are not the canonical body of their digest', async () => {
    const harness = new ControlHarness();
    const root = await harness.publish();
    const canonical = harness.envelopes.objects.get(root);
    if (canonical === undefined) throw new Error('expected a published envelope');
    const envelope = v.parse(RootEnvelopeV1Schema, JSON.parse(dec.decode(canonical)));

    harness.envelopes.objects.set(root, enc.encode(`${JSON.stringify(envelope, null, 2)}\n`));
    await expect(candidateRunControl(
      harness.store, harness.envelopes, harness.payloads.verifyObject.bind(harness.payloads),
    )).rejects.toThrow('is not canonical');

    harness.envelopes.objects.set(root, envelopeBytes({ ...envelope, generation: '999' }));
    await expect(candidateRunControl(
      harness.store, harness.envelopes, harness.payloads.verifyObject.bind(harness.payloads),
    )).rejects.toThrow('does not match pointer');

    harness.envelopes.objects.delete(root);
    await expect(harness.begin()).rejects.toThrow('candidate envelope is absent');
  });

  test('restore accepts only a fully existent closure', async () => {
    for (const deleted of ['root', 'dependency', 'closure'] as const) {
      const harness = new ControlHarness();
      const root = await harness.publish();
      const envelope = v.parse(RootEnvelopeV1Schema, JSON.parse(dec.decode(harness.envelopes.objects.get(root)!)));
      const key = deleted === 'root'
        ? envelope.rootObject.key
        : deleted === 'dependency'
          ? envelope.closure.find((ref) => ref.key !== envelope.rootObject.key)!.key
          : envelope.closureObject.key;
      harness.payloads.payloads.delete(key);

      await expect(candidateRunControl(
        harness.store, harness.envelopes, harness.payloads.verifyObject.bind(harness.payloads),
      )).rejects.toThrow('missing candidate object');
    }
  });
});

describe('the candidate container seam answers its own failure', () => {
  /**
   * The host seam, stubbed at the one call each test needs. Every member is
   * present because the seam declares it; a checkpoint that fails at `begin`
   * reaches none of the rest, and saying so here is cheaper than a fake
   * container.
   */
  function containerPorts(overrides: {
    begin?: () => Promise<CandidateRunControlV1>;
    recordFailure?: (reason: string) => Promise<void>;
    recorded?: string[];
  }): CandidateContainerPorts {
    const absent = (name: string) => async (): Promise<never> => {
      throw new Error(`this test reaches no further than ${name}`);
    };
    return {
      format: 'merkle-pack',
      runnerPath: '/opt/kinu/candidate-runner.bundle.mjs',
      mountStore: async () => {},
      unmountStore: async () => {},
      clearStore: async () => {},
      attachmentHealth: async () => ({
        storeMounted: true,
        storeAccessible: true,
        journalProcess: true,
        journalSocket: true,
        journalMounted: true,
      }),
      begin: overrides.begin ?? absent('begin'),
      redrive: absent('redrive'),
      finalize: absent('finalize'),
      settleNoChange: absent('settleNoChange'),
      restoreState: absent('restoreState'),
      bootId: async () => 'boot-test',
      clearControl: async () => {},
      clearRunnerResults: async () => {},
      clearRunnerAttempt: async () => {},
      startJournal: async () => {},
      stopJournal: async () => {},
      getRunnerProcess: async () => null,
      waitForRunnerExit: absent('waitForRunnerExit'),
      activeCheckpoint: async () => null,
      writeRunnerControl: async () => absent('writeRunnerControl')(),
      startRunnerProcess: async () => absent('startRunnerProcess')(),
      readRunnerResult: async () => absent('readRunnerResult')(),
      boxId: () => 'box-b',
      recordFailure: overrides.recordFailure ?? (async (reason) => {
        overrides.recorded?.push(reason);
      }),
    };
  }

  const notBegun = async (): Promise<CandidateRunControlV1> =>
    ({ version: 1, head: null, operation: null });
  /** What `checkpoint` finds when the control plane admitted no operation. */
  const NOT_BEGUN = 'candidate tick did not begin a transferring operation';

  test('a failed checkpoint files its reason and returns it', async () => {
    const recorded: string[] = [];
    const outcome = await candidateContainerStorage(
      containerPorts({ begin: notBegun, recorded }),
    ).checkpoint('tick');

    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toBe(NOT_BEGUN);
    expect(recorded).toEqual([NOT_BEGUN]);
  });

  test('an incident write that fails cannot replace the reason it was filing', async () => {
    // The incident row is a durable write, so it fails exactly as the operation
    // can. Its rejection used to surface INSTEAD — as a throw out of a method
    // whose contract is to return its failure, carrying the storage error and
    // discarding what the checkpoint had actually found.
    const outcome = await candidateContainerStorage(containerPorts({
      begin: notBegun,
      recordFailure: async () => {
        throw new Error('durable storage unreachable');
      },
    })).checkpoint('tick');

    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toBe(NOT_BEGUN);
    expect(outcome.bytes).toBeUndefined();
    expect(outcome.movedBytes).toBeUndefined();
  });
});
