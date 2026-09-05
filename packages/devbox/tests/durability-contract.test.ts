import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AwaitPointDeclarationSchema,
  CandidateControlStateV1Schema,
  CandidateRunControlV1Schema,
  CompactionWorkSchema,
  DURABILITY_AWAIT_POINTS,
  DURABILITY_OPERATION_PHASES,
  DURABLE_ROOT_FORMATS,
  CapturedCutSchema,
  GcWorkSchema,
  HydrateWorkSchema,
  ImmutableObjectRefSchema,
  HeadPointerV1Schema,
  MERKLE_PACK_V2_AWAIT_POINT_DECLARATION,
  ObjectReceiptSchema,
  OperationRecordSchema,
  PackLedgerSchema,
  PayloadGrantSchema,
  PublishWorkSchema,
  RangeReadIntentSchema,
  RestoreWorkSchema,
  RootEnvelopeV1Schema,
  RootEnvelopeV2Schema,
  SIDECAR_ATTACH_KINDS,
  SealWorkSchema,
  SidecarStatusV1Schema,
  UploadIntentSchema,
  unreachedAwaitPoints,
} from '../src/durability/contracts';
import type {
  CandidateControlStateV1,
  CandidateRunControlV1,
  HeadPointerV1,
  PackLedger,
  RestoreWork,
  RootEnvelopeV1,
  RootEnvelopeV2,
  SidecarStatusV1,
} from '../src/durability/contracts';
import { runOverlayRunner } from '../src/cas/overlay-runner';
import { overlayCasStorage, type OverlayCasPorts } from '../src/overlay-cas';
import type { AttachOutcome } from '../src/storage';
import { MemoryCasStore, WatchedCasStore, treeHeavyStore } from './support/cas-cost-probe';

const SHA = 'a'.repeat(64);
const object = { key: 'v1/boxes/box/attempts/op/try/data-a', byteLength: '12', sha256: SHA };
const closureObject = { key: 'v1/boxes/box/attempts/op/try/closure-a', byteLength: '12', sha256: SHA };
const capturedCut = {
  captureId: 'capture-1',
  epoch: '7',
  baseRevision: '8',
  cut: '42',
  stableStageHandle: 'stage-1',
  manifestSha256: SHA,
};
const envelope: RootEnvelopeV1 = {
  version: 1,
  format: 'merkle-pack/v1',
  boxId: 'box-1',
  epoch: '7',
  generation: '9',
  parentRootId: null,
  cut: capturedCut,
  rootObject: object,
  closure: [object],
  closureObject,
};

describe('durability v1 wire contracts', () => {
  test('a closed root envelope binds the full captured cut, not a bare cut number', () => {
    expect(v.parse(RootEnvelopeV1Schema, envelope)).toEqual(envelope);
  });

  test('a head pointer names one exact envelope and the operation that published it', () => {
    const pointer: HeadPointerV1 = {
      version: 1,
      rootEnvelopeId: SHA,
      lastOperationId: 'op-1',
    };
    expect(v.parse(HeadPointerV1Schema, pointer)).toEqual(pointer);
    expect(() => v.parse(HeadPointerV1Schema, {
      ...pointer,
      lastOperationId: '',
    })).toThrow('Invalid length: Expected >=1 but received 0');
    expect(() => v.parse(HeadPointerV1Schema, {
      ...pointer,
      reachable: [object],
    })).toThrow('Invalid key: Expected never but received "reachable"');
  });

  test('wire counters and digests refuse unsafe representations', () => {
    // A negative byte count is unrepresentable, so it is refused at the
    // boundary rather than read as a huge unsigned length downstream.
    expect(() => v.parse(ImmutableObjectRefSchema, { ...object, byteLength: '-1' }))
      .toThrow('Expected a canonical non-negative decimal string');
    // A truncated digest cannot authenticate anything, so it never parses.
    expect(() => v.parse(ImmutableObjectRefSchema, { ...object, sha256: 'short' }))
      .toThrow('Expected a lowercase SHA-256 digest');
    // A bare decimal is no longer a legal envelope cut.
    expect(() => v.parse(RootEnvelopeV1Schema, {
      version: 1,
      format: 'merkle-pack/v1',
      boxId: 'box-1',
      epoch: '7',
      generation: '9',
      parentRootId: null,
      cut: '42',
      rootObject: object,
      closure: [object],
      closureObject,
    })).toThrow('Invalid type: Expected Object but received "42"');
    expect(() => v.parse(RootEnvelopeV1Schema, {
      version: 1,
      format: 'merkle-pack/v1',
      boxId: 'box-1',
      epoch: '01',
      generation: '9',
      parentRootId: null,
      cut: { ...capturedCut, captureId: '' },
      rootObject: object,
      closure: [object],
      closureObject,
    })).toThrow('Expected a canonical non-negative decimal string');
    // The empty capture id the envelope above also carries is refused on its
    // own field, so the refusal above is known to cover both defects.
    expect(() => v.parse(RootEnvelopeV1Schema, {
      version: 1,
      format: 'merkle-pack/v1',
      boxId: 'box-1',
      epoch: '7',
      generation: '9',
      parentRootId: null,
      cut: { ...capturedCut, captureId: '' },
      rootObject: object,
      closure: [object],
      closureObject,
    })).toThrow('Invalid length: Expected >=1 but received 0');
  });

  test('an upload receipt proves the exact attempted object', () => {
    expect(v.parse(ObjectReceiptSchema, {
      operationId: 'op-1',
      attemptId: 'attempt-1',
      key: object.key,
      byteLength: object.byteLength,
      sha256: SHA,
      etag: 'etag',
      verified: true,
    }).verified).toBe(true);
    expect(() => v.parse(ObjectReceiptSchema, {
      operationId: 'op-1',
      attemptId: 'attempt-1',
      key: object.key,
      byteLength: object.byteLength,
      sha256: SHA,
      etag: 'etag',
      verified: false,
    })).toThrow('Invalid type: Expected true but received false');
  });

  test('restore work reports every hidden readiness dimension', () => {
    expect(v.parse(RestoreWorkSchema, {
      serialRemoteOps: 1,
      totalRemoteOps: 1,
      metadataBytes: 128,
      payloadBytes: 0,
      cpuSteps: 4,
      mounts: 1,
      replayUnits: 0,
    })).toEqual({
      serialRemoteOps: 1,
      totalRemoteOps: 1,
      metadataBytes: 128,
      payloadBytes: 0,
      cpuSteps: 4,
      mounts: 1,
      replayUnits: 0,
    });
  });

  test('payload grants bind one attempt, method, object, and expiry', () => {
    const intent = v.parse(UploadIntentSchema, {
      operationId: 'op-1',
      attemptId: 'attempt-1',
      boxId: 'box-1',
      epoch: '7',
      exactKey: object.key,
      method: 'PUT',
      byteLength: object.byteLength,
      sha256: SHA,
      expiresAt: '100',
    });
    expect(intent.method).toBe('PUT');
    expect(v.parse(PayloadGrantSchema, {
      operationId: intent.operationId,
      attemptId: intent.attemptId,
      expiresAt: intent.expiresAt,
      opaque: 'provider-owned-capability',
    }).opaque).toBe('provider-owned-capability');
    expect(() => v.parse(UploadIntentSchema, { ...intent, method: 'GET' }))
      .toThrow('Invalid type: Expected "PUT" but received "GET"');
  });

  test('range reads and captures carry exact re-drive coordinates', () => {
    expect(v.parse(RangeReadIntentSchema, {
      operationId: 'op-1',
      attemptId: 'attempt-2',
      boxId: 'box-1',
      epoch: '7',
      exactKey: object.key,
      method: 'GET',
      byteOffset: '4096',
      byteLength: '8192',
      sha256: SHA,
      expiresAt: '100',
    }).byteOffset).toBe('4096');
    expect(v.parse(CapturedCutSchema, {
      captureId: 'capture-1',
      epoch: '7',
      baseRevision: '8',
      cut: '42',
      stableStageHandle: 'stage-1',
      manifestSha256: SHA,
    }).cut).toBe('42');
  });

  test('operation state stores only information independent of its phase', () => {
    const intent = v.parse(OperationRecordSchema, {
      operationId: 'op-1',
      kind: 'tick',
      epoch: '7',
      bootId: 'boot-1',
      baseRevision: '8',
      expectedParent: SHA,
      phase: 'intent',
    });
    expect(intent.phase).toBe('intent');
    expect(Object.keys(intent).sort()).toEqual([
      'baseRevision', 'bootId', 'epoch', 'expectedParent', 'kind', 'operationId', 'phase',
    ]);

    const published = v.parse(OperationRecordSchema, {
      operationId: 'op-1',
      kind: 'tick',
      epoch: '7',
      bootId: 'boot-1',
      baseRevision: '8',
      expectedParent: SHA,
      phase: 'published',
      resultRootId: SHA,
    });
    expect(published.phase).toBe('published');
    const completionPending = v.parse(OperationRecordSchema, {
      operationId: 'op-1',
      kind: 'tick',
      epoch: '7',
      bootId: 'boot-1',
      baseRevision: '8',
      expectedParent: SHA,
      phase: 'completion-pending',
      attemptId: 'attempt-1',
      resultRootId: SHA,
    });
    expect(completionPending.phase).toBe('completion-pending');
    expect(v.parse(HeadPointerV1Schema, {
      version: 1,
      rootEnvelopeId: SHA,
      lastOperationId: 'op-1',
    })).toEqual({
      version: 1,
      rootEnvelopeId: SHA,
      lastOperationId: 'op-1',
    });
    expect(() => v.parse(HeadPointerV1Schema, {
      version: 1,
      rootEnvelopeId: SHA,
      lastOperationId: 'op-1',
      parentRootId: SHA,
    })).toThrow('Invalid key: Expected never but received "parentRootId"');
  });

  test('operation phase rejects redundant and impossible state', () => {
    // An intent names no attempt yet, so an attempt id on one is refused
    // rather than carried into a phase that never reads it.
    expect(() => v.parse(OperationRecordSchema, {
      operationId: 'op-1',
      kind: 'tick',
      epoch: '7',
      bootId: 'boot-1',
      baseRevision: '8',
      expectedParent: SHA,
      phase: 'intent',
      attemptId: 'unused-attempt',
    })).toThrow('Invalid key: Expected never but received "attemptId"');
    // A sealed operation names its result id, so one that carries an attempt
    // but no result is refused as a state no writer could have produced.
    expect(() => v.parse(OperationRecordSchema, {
      operationId: 'op-1',
      kind: 'tick',
      epoch: '7',
      bootId: 'boot-1',
      baseRevision: '8',
      expectedParent: SHA,
      phase: 'sealed',
      attemptId: 'attempt-1',
    })).toThrow('Invalid key: Expected "resultRootId" but received undefined');
  });

  test('durable operation phases contain no response-only acknowledgement state', () => {
    expect(DURABILITY_OPERATION_PHASES).toEqual([
      'intent', 'transferring', 'sealed', 'completion-pending', 'published', 'failed',
    ]);
  });

  test('the durable control record holds a pointer and an operation, never an envelope', () => {
    const record: CandidateControlStateV1 = {
      version: 1,
      head: { version: 1, rootEnvelopeId: SHA, lastOperationId: 'op-1' },
      operation: null,
    };
    expect(v.parse(CandidateControlStateV1Schema, record)).toEqual(record);
    expect(v.parse(CandidateControlStateV1Schema, { version: 1, head: null, operation: null }).head).toBeNull();
    expect(() => v.parse(CandidateControlStateV1Schema, { ...record, envelope }))
      .toThrow('Invalid key: Expected never but received "envelope"');
    expect(() => v.parse(CandidateControlStateV1Schema, {
      ...record,
      head: { ...record.head, envelope },
    })).toThrow('Invalid key: Expected never but received "envelope"');
  });

  test('the container run control pairs one pointer with the exact envelope it names', () => {
    const pointer: HeadPointerV1 = { version: 1, rootEnvelopeId: SHA, lastOperationId: 'op-1' };
    const control: CandidateRunControlV1 = {
      version: 1,
      head: { pointer, envelope },
      operation: null,
    };
    expect(v.parse(CandidateRunControlV1Schema, control)).toEqual(control);
    // A pointer without its envelope, or an envelope without its pointer, is unrepresentable.
    expect(() => v.parse(CandidateRunControlV1Schema, { ...control, head: { pointer } }))
      .toThrow('Invalid key: Expected "envelope" but received undefined');
    expect(() => v.parse(CandidateRunControlV1Schema, { ...control, head: { envelope } }))
      .toThrow('Invalid key: Expected "pointer" but received undefined');
    expect(() => v.parse(CandidateRunControlV1Schema, { ...control, head: pointer }))
      .toThrow('Invalid key: Expected "pointer" but received undefined');
  });

  test('the reset fault register exactly names every external await', () => {
    expect(DURABILITY_AWAIT_POINTS).toEqual([
      'issue-payload-grant',
      'create-multipart',
      'upload-multipart-part',
      'complete-multipart',
      'verify-upload',
      'upload-root',
      'publish-head',
      'create-pin',
      'renew-pin',
      'release-pin',
      'read-mark-page',
      'complete-mark',
      'retire-object',
      'delete-retired-object',
      'mount-root',
      'cleanup-resource',
    ]);
    expect(new Set(DURABILITY_AWAIT_POINTS).size).toBe(DURABILITY_AWAIT_POINTS.length);
  });
});


// ── v2: delta envelope, pack ledger and counted work ─────────────────────────

const PACK_SHA = 'b'.repeat(64);
const pack = {
  key: `v1/merkle-pack/pack/${PACK_SHA}`,
  byteLength: '4096',
  sha256: PACK_SHA,
};
const ledgerObject = {
  key: 'v1/boxes/box/ledgers/9',
  byteLength: '512',
  sha256: 'c'.repeat(64),
};
const envelopeV2: RootEnvelopeV2 = {
  version: 2,
  format: 'merkle-pack/v2',
  boxId: 'box-1',
  epoch: '7',
  generation: '9',
  parentRootId: null,
  cut: capturedCut,
  rootObject: { key: pack.key, byteOffset: '128', byteLength: '256', sha256: SHA },
  added: [pack],
  retired: [],
  ledger: ledgerObject,
};
const ledger: PackLedger = {
  version: 1,
  format: 'merkle-pack/v2',
  boxId: 'box-1',
  generation: '9',
  packs: [{ ...pack, liveBytes: '3072', addedInGeneration: '9' }],
};

const ZERO_WORK = {
  restore: {
    serialRemoteOps: 0,
    totalRemoteOps: 0,
    metadataBytes: 0,
    payloadBytes: 0,
    cpuSteps: 0,
    mounts: 0,
    replayUnits: 0,
  },
  seal: { bytesStaged: 0, bytesChunked: 0, chunksHashed: 0, nodesRewritten: 0, wholeFiles: 0 },
  publish: { objectsPut: 0, bytesPut: 0, casAttempts: 0 },
  hydrate: { rangeGets: 0, bytesFetched: 0, bytesRequested: 0 },
  compaction: { packsRead: 0, bytesRewritten: 0, nodesRewritten: 0 },
  gc: { deletes: 0, markPages: 0, markBytes: 0 },
};
const sidecarStatus: SidecarStatusV1 = {
  version: 1,
  format: 'merkle-pack/v2',
  boxId: 'box-1',
  epoch: '7',
  bootId: 'boot-1',
  attach: { kind: 'attached', rootEnvelopeId: SHA, generation: '9' },
  lag: { unsealedBytes: 8192, unsealedMs: 1750, unpublishedGenerations: 1, unpublishedMs: 500 },
  hydration: { residentBytes: 1024, treeBytes: 4096, placeholders: 3 },
  work: ZERO_WORK,
};

describe('durability v2 wire contracts', () => {
  test('a valid v2 envelope carries only delta publication facts', () => {
    expect(v.parse(RootEnvelopeV2Schema, envelopeV2)).toEqual(envelopeV2);
    expect(Object.keys(v.parse(RootEnvelopeV2Schema, envelopeV2))).toEqual([
      'version',
      'format',
      'boxId',
      'epoch',
      'generation',
      'parentRootId',
      'cut',
      'rootObject',
      'added',
      'retired',
      'ledger',
    ]);
  });

  test('a v1 envelope carrying closure is refused under v2, naming the field', () => {
    // What the refusal NAMES is the contract: the schema rejects the closure
    // itself, in both spellings, not merely any parse failure. A schema that
    // failed on some other field would satisfy a bare toThrow.
    type EnvelopeInput = v.InferInput<typeof RootEnvelopeV1Schema>
      | v.InferInput<typeof RootEnvelopeV2Schema>;
    // The middle case is the POINT of the test: a v2 envelope that carries a
    // closure field the schema refuses. The parser is what proves it refused,
    // so the input is the schema's own type with the banned field added.
    const refusals = (input: EnvelopeInput): string =>
      v.safeParse(RootEnvelopeV2Schema, input)
        .issues?.map((issue) => issue.message).join(';') ?? '';
    expect(refusals(envelope)).toContain('closure');
    expect(
      // SAFETY: the input is the test's own fixture plus a field the schema
      // refuses, parsed immediately by that schema below; nothing else reads it.
      refusals({ ...envelopeV2, closure: [pack] } as EnvelopeInput & { closure: unknown }),
    ).toContain('closure');
    expect(
      // SAFETY: envelopeV2 is the schema's own parsed fixture, and the only
      // added member is closureObject, which RootEnvelopeV2Schema has no field
      // for. The parser below is the reader, so the shape never escapes.
      refusals({ ...envelopeV2, closureObject } as EnvelopeInput & { closureObject: unknown }),
    ).toContain('closure');
  });

  test('a v2 envelope without its ledger is refused', () => {
    const { ledger: omitted, ...withoutLedger } = envelopeV2;
    expect(omitted).toEqual(ledgerObject);
    expect(() => v.parse(RootEnvelopeV2Schema, withoutLedger))
      .toThrow('Invalid key: Expected "ledger" but received undefined');
  });

  test('the root is an authenticated range inside a pack this generation added', () => {
    expect(() => v.parse(RootEnvelopeV2Schema, {
      ...envelopeV2,
      rootObject: { ...envelopeV2.rootObject, key: pack.key + '-other' },
    })).toThrow(/root record/u);
    expect(() => v.parse(RootEnvelopeV2Schema, {
      ...envelopeV2,
      rootObject: { ...envelopeV2.rootObject, byteOffset: '4000', byteLength: '128' },
    })).toThrow(/root record/u);
    expect(() => v.parse(RootEnvelopeV2Schema, {
      ...envelopeV2,
      rootObject: { ...envelopeV2.rootObject, sha256: 'short' },
    })).toThrow(/SHA-256/u);
    expect(() => v.parse(RootEnvelopeV2Schema, {
      ...envelopeV2,
      rootObject: { ...envelopeV2.rootObject, byteLength: '0' },
    })).toThrow(/positive decimal/u);
  });

  test('added packs preserve packing order while keys remain unique and disjoint from retired packs', () => {
    const later = { key: `v1/merkle-pack/pack/${'d'.repeat(64)}`, byteLength: '1', sha256: 'd'.repeat(64) };
    expect(v.parse(RootEnvelopeV2Schema, { ...envelopeV2, added: [later, pack] }).added).toEqual([later, pack]);
    expect(() => v.parse(RootEnvelopeV2Schema, { ...envelopeV2, added: [pack, pack] })).toThrow(/same pack twice/u);
    expect(() => v.parse(RootEnvelopeV2Schema, { ...envelopeV2, retired: ['z', 'a'] })).toThrow(/sorted/u);
    expect(() => v.parse(RootEnvelopeV2Schema, { ...envelopeV2, retired: [pack.key] })).toThrow(/cannot retire/u);
  });

  test('the pack ledger binds immutable rows and preserves generation and packing order', () => {
    expect(v.parse(PackLedgerSchema, ledger)).toEqual(ledger);
    expect(() => v.parse(PackLedgerSchema, {
      ...ledger,
      packs: [{ ...ledger.packs[0], liveBytes: '4097' }],
    })).toThrow(/more live bytes/u);
    expect(() => v.parse(PackLedgerSchema, {
      ...ledger,
      packs: [{ ...ledger.packs[0], addedInGeneration: '10' }],
    })).toThrow(/after its own generation/u);
    const older = {
      key: `v1/merkle-pack/pack/${'d'.repeat(64)}`,
      byteLength: '1',
      sha256: 'd'.repeat(64),
      liveBytes: '1',
      addedInGeneration: '8',
    };
    expect(v.parse(PackLedgerSchema, { ...ledger, packs: [older, ledger.packs[0]] }).packs)
      .toEqual([older, ledger.packs[0]]);
    expect(() => v.parse(PackLedgerSchema, { ...ledger, packs: [ledger.packs[0], older] }))
      .toThrow(/added-generation order/u);
    expect(() => v.parse(PackLedgerSchema, { ...ledger, packs: [ledger.packs[0], ledger.packs[0]] }))
      .toThrow(/repeat a pack key/u);
    expect(() => v.parse(PackLedgerSchema, {
      ...ledger,
      packs: [{ ...ledger.packs[0], sha256: 'D'.repeat(64) }],
    })).toThrow(/SHA-256/u);
    expect(() => v.parse(PackLedgerSchema, { ...ledger, packs: [] }))
      .toThrow('Invalid length: Expected >=1 but received 0');
  });

  test('each counted-work row accepts safe counts and refuses unsafe counts or extra state', () => {
    const rows = [
      [SealWorkSchema, { bytesStaged: 64, bytesChunked: 64, chunksHashed: 2, nodesRewritten: 3, wholeFiles: 0 }],
      [PublishWorkSchema, { objectsPut: 3, bytesPut: 4096, casAttempts: 1 }],
      [HydrateWorkSchema, { rangeGets: 1, bytesFetched: 1024, bytesRequested: 64 }],
      [CompactionWorkSchema, { packsRead: 2, bytesRewritten: 2048, nodesRewritten: 4 }],
      [GcWorkSchema, { deletes: 2, markPages: 3, markBytes: 4096 }],
    ] as const;
    for (const [schema, row] of rows) expect(v.parse(schema, row)).toEqual(row);
    expect(() => v.parse(SealWorkSchema, { ...rows[0][1], bytesStaged: -1 }))
      .toThrow('Invalid value: Expected >=0 but received -1');
    expect(() => v.parse(PublishWorkSchema, { ...rows[1][1], objectsPut: 1.5 }))
      .toThrow('Invalid safe integer: Received 1.5');
    expect(() => v.parse(HydrateWorkSchema, { ...rows[2][1], payloadBytes: 1 }))
      .toThrow('Invalid key: Expected never but received "payloadBytes"');
    expect(() => v.parse(CompactionWorkSchema, { ...rows[3][1], bytesRewritten: Number.MAX_SAFE_INTEGER + 1 }))
      .toThrow('Invalid safe integer: Received 9007199254740992');
    expect(() => v.parse(GcWorkSchema, { ...rows[4][1], closureWalks: 1 }))
      .toThrow('Invalid key: Expected never but received "closureWalks"');
  });

  test('sidecar status binds attach state, lag, hydration and every work row', () => {
    expect(SIDECAR_ATTACH_KINDS).toEqual(['attaching', 'empty', 'attached', 'refused']);
    expect(v.parse(SidecarStatusV1Schema, sidecarStatus)).toEqual(sidecarStatus);
    expect(() => v.parse(SidecarStatusV1Schema, {
      ...sidecarStatus,
      hydration: { ...sidecarStatus.hydration, residentBytes: 4097 },
    })).toThrow(/more resident bytes/u);
    expect(() => v.parse(SidecarStatusV1Schema, {
      ...sidecarStatus,
      attach: { kind: 'attached' },
    })).toThrow('Invalid key: Expected "rootEnvelopeId" but received undefined');
    expect(() => v.parse(SidecarStatusV1Schema, {
      ...sidecarStatus,
      attach: { ...sidecarStatus.attach, stale: true },
    })).toThrow('Invalid key: Expected never but received "stale"');
    expect(() => v.parse(SidecarStatusV1Schema, {
      ...sidecarStatus,
      work: { ...sidecarStatus.work, seal: { ...sidecarStatus.work.seal, closureObjects: 1 } },
    })).toThrow('Invalid key: Expected never but received "closureObjects"');
  });

  test('the v2 arm declares exactly the await points it can reach', () => {
    expect(DURABLE_ROOT_FORMATS).toContain('merkle-pack/v2');
    expect(v.parse(AwaitPointDeclarationSchema, MERKLE_PACK_V2_AWAIT_POINT_DECLARATION))
      .toEqual(MERKLE_PACK_V2_AWAIT_POINT_DECLARATION);
    expect(unreachedAwaitPoints(MERKLE_PACK_V2_AWAIT_POINT_DECLARATION)).toEqual([
      'create-multipart',
      'upload-multipart-part',
      'complete-multipart',
      'create-pin',
      'renew-pin',
      'release-pin',
    ]);
    expect(() => v.parse(AwaitPointDeclarationSchema, {
      format: 'merkle-pack/v2',
      uses: ['publish-head', 'verify-upload'],
    })).toThrow(/register order/u);
    expect(() => v.parse(AwaitPointDeclarationSchema, {
      format: 'merkle-pack/v2',
      uses: ['verify-upload', 'verify-upload'],
    })).toThrow(/without repeats/u);
    expect(() => v.parse(AwaitPointDeclarationSchema, {
      format: 'merkle-pack/v2',
      uses: ['not-a-real-point'],
    })).toThrow('but received "not-a-real-point"');
  });
});

// ── the readiness dimensions, measured on a real attach ──────────────────────
//
// `RestoreWorkSchema` above declares the dimensions a readiness claim has to be
// stated in, and until now nothing produced one — so a strategy could advertise
// flat recovery while carrying a term that grew with its own tree, and the
// contract would not notice. overlay-cas did exactly that: `attach` called
// `inventory()`, a LIST over the whole prefix, on both of its paths.
//
// These tests fill a `RestoreWork` from a REAL attach — the shipped adapter,
// the shipped runner, receipts crossing the shipped stdout schema — and assert
// which of its seven dimensions may move. The `inventory` port is poisoned, so
// a prefix listing anywhere in attach fails the attach rather than inflating a
// number someone has to notice.

interface AttachProbe {
  readonly outcome: AttachOutcome;
  readonly work: RestoreWork;
}

/**
 * One real attach against a prefix holding `objects` folded objects, plus
 * whatever `pending` names journalled and not folded.
 *
 * Every field of the returned `RestoreWork` comes from something observed:
 * store calls for the op counts, recorded byte lengths split by key namespace
 * for the two byte figures, mount port calls for `mounts`, and the restore
 * receipt for `replayUnits`.
 */
async function measureAttach(
  objects: number,
  foldedSeq: number,
  pending: readonly (readonly [string, string])[] = [],
): Promise<AttachProbe> {
  const root = await mkdtemp(join(tmpdir(), 'overlay-attach-work-'));
  try {
    const upper = join(root, 'upper');
    await mkdir(upper);
    const store = new MemoryCasStore();
    await treeHeavyStore(store, objects, foldedSeq);
    // Journalled through the real checkpoint, so what the attach replays is a
    // journal this release wrote rather than a fixture's idea of one.
    if (pending.length > 0) {
      for (const [name, body] of pending) await writeFile(join(upper, name), body);
      await runOverlayRunner({ operation: 'checkpoint', upper, store });
      await rm(upper, { recursive: true, force: true });
      await mkdir(upper);
    }

    const watched = new WatchedCasStore(store);
    let mounted = false;
    let mounts = 0;
    let replayUnits = 0;
    let batchesDecoded = 0;
    const ports: OverlayCasPorts = {
      containerRunning: () => true,
      mountStore: async () => {
        mounts += 1;
      },
      unmountStore: async () => {},
      storeMounted: async () => false,
      mountOverlay: async () => {
        mounts += 1;
        mounted = true;
      },
      unmountOverlay: async () => {
        mounted = false;
      },
      overlayMounted: async () => mounted,
      invokeRunner: async (operation) => {
        const receipt = await runOverlayRunner({ operation, upper, store: watched });
        replayUnits = receipt.entries;
        batchesDecoded = watched.keys('get').filter(key => key.startsWith('journal/')).length;
        // Through stdout, because that is the wire. The adapter parses these
        // bytes under its strict schema, so a receipt this release cannot
        // produce fails here rather than in a reviewer's head.
        return { stdout: `${JSON.stringify(receipt)}\n`, stderr: '', exitCode: 0 };
      },
      inventory: async () => {
        throw new Error('attach listed the prefix, which is the tree-size term');
      },
      clearPrefix: async () => 0,
      // Nothing here writes to a bare work directory, so the salvage moves
      // nothing; `overlay-cas.test.ts` owns the case where a replaced container
      // left bytes there.
      salvageWorkdirResidue: async () => 0,
      readState: async () => null,
      writeState: async () => {},
      clearState: async () => {},
      checkpointIntervalMs: () => 300_000,
      now: () => 1_000,
      log: () => {},
    };

    const outcome = await overlayCasStorage(ports).attach();
    const payloadBytes = watched.payloadBytes('get') + watched.payloadBytes('put');
    return {
      outcome,
      work: {
        // The runner awaits each store call before issuing the next, so its
        // serial depth and its total are the same number. Recording both is how
        // a future batched implementation would show up as a difference.
        serialRemoteOps: watched.calls.length,
        totalRemoteOps: watched.calls.length,
        metadataBytes: watched.bytes('get') + watched.bytes('put') - payloadBytes,
        payloadBytes,
        // Local work the replay performs: decode a pending batch, apply an
        // entry. Zero when there is nothing pending, which is the point.
        cpuSteps: batchesDecoded + replayUnits,
        mounts,
        replayUnits,
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('an overlay-cas attach, in the readiness dimensions this contract declares', () => {
  test('A 100× LARGER TREE PRODUCES AN IDENTICAL RestoreWork', async () => {
    // THE CLAIM, in the contract's own vocabulary: none of the seven dimensions
    // is a function of the tree. The cursor is held equal across the two probes
    // so the only thing that varies is the object count — a larger `foldedSeq`
    // is a genuinely longer `cursor.json`, and letting both move would give a
    // real prefix scan an explainable place to hide.
    const thin = await measureAttach(20, 7);
    const fat = await measureAttach(2_000, 7);

    expect(v.parse(RestoreWorkSchema, thin.work)).toEqual(thin.work);
    expect(fat.work).toEqual(thin.work);
    // Two remote operations: read the cursor, list the journal. Plus the two
    // mounts the adapter takes — the store, then the overlay, in that order.
    expect(thin.work).toMatchObject({
      serialRemoteOps: 2,
      totalRemoteOps: 2,
      payloadBytes: 0,
      cpuSteps: 0,
      mounts: 2,
      replayUnits: 0,
    });
    expect(thin.work.metadataBytes).toBeGreaterThan(0);
    // Both prefixes hold objects, and the cursor is how attach knew that
    // without listing either one.
    expect(thin.outcome.kind).toBe('attached');
    expect(fat.outcome.kind).toBe('attached');
  });

  test('A FRESH PREFIX IS TOLD APART FROM A FOLDED ONE AT THE SAME OP, MOUNT AND PAYLOAD COST',
    async () => {
      // The classification `inventory()` used to answer. A fresh prefix reports
      // `empty`; a folded one reports `attached`; both pay two remote operations
      // and two mounts and read no payload, and neither is listed.
      //
      // THE TWO ROWS ARE NOT EQUAL, and the difference is named rather than
      // asserted away: a folded prefix has a `cursor.json` to read and a fresh
      // one does not, so `metadataBytes` differs by the size of that one control
      // object. Every other dimension is identical, which is the claim — nothing
      // here is a function of the tree.
      const fresh = await measureAttach(0, 0);
      const folded = await measureAttach(2_000, 7);

      expect(fresh.outcome.kind).toBe('empty');
      expect(folded.outcome.kind).toBe('attached');
      expect({ ...fresh.work, metadataBytes: 0 }).toEqual({ ...folded.work, metadataBytes: 0 });
      expect(fresh.work.metadataBytes).toBe(0);
      expect(folded.work.metadataBytes).toBeGreaterThan(0);
      expect(fresh.work).toMatchObject({
        serialRemoteOps: 2, totalRemoteOps: 2, payloadBytes: 0, cpuSteps: 0,
        mounts: 2, replayUnits: 0,
      });
    });

  test('ONLY THE PENDING DIMENSIONS MOVE WHEN THERE IS PENDING WORK', async () => {
    // The other half of the contract: recovery is O(pending change), so the
    // dimensions that describe pending work — the batch and blob reads, the
    // payload bytes, the replay units — are exactly the ones allowed to rise,
    // and they rise with the pending set rather than with the tree.
    const body = 'pending bytes a replay must read';
    const idle = await measureAttach(2_000, 7);
    const busy = await measureAttach(2_000, 7, [['pending.txt', body]]);

    expect(v.parse(RestoreWorkSchema, busy.work)).toEqual(busy.work);
    expect(busy.work.payloadBytes).toBe(body.length);
    expect(busy.work.replayUnits).toBe(1);
    // One batch decoded, one entry applied.
    expect(busy.work.cpuSteps).toBe(2);
    // Cursor, journal listing, the one pending batch, the one blob it names.
    expect(busy.work.totalRemoteOps).toBe(idle.work.totalRemoteOps + 2);
    // And the fixed dimensions did not move.
    expect(busy.work.mounts).toBe(idle.work.mounts);
    expect(busy.outcome.kind).toBe('attached');
  // Measured 3.2 s on a box at load 66-98 (2026-09-02 sweep, foreign mutation jobs on all
  // 24 threads), where bun's default 5 s bound read red and the test is green alone. A bound
  // on a finite run, stated with its measurement, not a detector.
  }, 15_000);
});
