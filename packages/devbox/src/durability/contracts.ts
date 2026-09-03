import * as v from 'valibot';

const DecimalSchema = v.pipe(
  v.string(),
  v.regex(/^(?:0|[1-9]\d*)$/, 'Expected a canonical non-negative decimal string'),
);
const PositiveDecimalSchema = v.pipe(v.string(), v.regex(/^[1-9]\d*$/, 'Expected a canonical positive decimal string'));
const IdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const ObjectKeySchema = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));
const Sha256Schema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/, 'Expected a lowercase SHA-256 digest'));
const CountSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

export const DURABLE_ROOT_FORMATS = [
  'bounded-layers/v1',
  'merkle-pack/v1',
  'merkle-pack/v2',
] as const;

/** Canonical decimal strings compare by length first, then digit by digit. */
function decimalAtMost(a: string, b: string): boolean {
  return a.length < b.length || (a.length === b.length && a <= b);
}

function strictlyAscending(values: readonly string[]): boolean {
  for (let i = 1; i < values.length; i += 1) {
    if (values[i - 1] >= values[i]) return false;
  }
  return true;
}

function allUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export const ImmutableObjectRefSchema = v.strictObject({
  key: ObjectKeySchema,
  byteLength: DecimalSchema,
  sha256: Sha256Schema,
});
export type ImmutableObjectRef = v.InferOutput<typeof ImmutableObjectRefSchema>;

/** One record inside an immutable object: the exact range a read intent names
 * and the plain digest of exactly those bytes. */
export const ObjectRangeRefSchema = v.strictObject({
  key: ObjectKeySchema,
  byteOffset: DecimalSchema,
  byteLength: PositiveDecimalSchema,
  sha256: Sha256Schema,
});
export type ObjectRangeRef = v.InferOutput<typeof ObjectRangeRefSchema>;

export const ObjectReceiptSchema = v.strictObject({
  operationId: IdSchema,
  attemptId: IdSchema,
  key: ObjectKeySchema,
  byteLength: DecimalSchema,
  sha256: Sha256Schema,
  etag: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  verified: v.literal(true),
});
export type ObjectReceipt = v.InferOutput<typeof ObjectReceiptSchema>;

export const CapturedCutSchema = v.strictObject({
  captureId: IdSchema,
  epoch: DecimalSchema,
  baseRevision: DecimalSchema,
  cut: DecimalSchema,
  stableStageHandle: IdSchema,
  manifestSha256: Sha256Schema,
});
export type CapturedCut = v.InferOutput<typeof CapturedCutSchema>;

export const RootEnvelopeV1Schema = v.strictObject({
  version: v.literal(1),
  format: v.picklist(DURABLE_ROOT_FORMATS),
  boxId: IdSchema,
  epoch: DecimalSchema,
  generation: DecimalSchema,
  parentRootId: v.nullable(Sha256Schema),
  cut: CapturedCutSchema,
  rootObject: ImmutableObjectRefSchema,
  /** Canonical sorted payload closure, duplicated here for metadata-only restore verification. */
  closure: v.array(ImmutableObjectRefSchema),
  /** Canonical sorted payload closure, written directly beside candidate objects. */
  closureObject: ImmutableObjectRefSchema,
});
export type RootEnvelopeV1 = v.InferOutput<typeof RootEnvelopeV1Schema>;

/** One live pack, as the ledger tracks it: its immutable identity, how many
 * of its bytes the head still reaches, and the generation that PUT it. */
export const PackLedgerRowSchema = v.pipe(
  v.strictObject({
    key: ObjectKeySchema,
    byteLength: DecimalSchema,
    sha256: Sha256Schema,
    liveBytes: DecimalSchema,
    addedInGeneration: DecimalSchema,
  }),
  v.check((row) => decimalAtMost(row.liveBytes, row.byteLength), 'A pack cannot have more live bytes than bytes'),
);
export type PackLedgerRow = v.InferOutput<typeof PackLedgerRowSchema>;

/**
 * Every pack a head reaches, written once per publish. It is O(#packs), the
 * one per-publish object that is not O(bytes changed), and it is what GC and
 * compaction read: liveness is tracked here, and a pack is deleted by ledger
 * only, never by listing a prefix or walking a closure.
 */
export const PackLedgerSchema = v.pipe(
  v.strictObject({
    version: v.literal(1),
    format: v.picklist(DURABLE_ROOT_FORMATS),
    boxId: IdSchema,
    generation: DecimalSchema,
    /** Stable pack order, one row per pack. */
    packs: v.pipe(v.array(PackLedgerRowSchema), v.minLength(1)),
  }),
  v.check(
    (ledger) => allUnique(ledger.packs.map((row) => row.key)),
    'A pack ledger cannot repeat a pack key',
  ),
  v.check(
    (ledger) => ledger.packs.every((row, index) =>
      index === 0 || decimalAtMost(ledger.packs[index - 1].addedInGeneration, row.addedInGeneration)),
    'Expected ledger packs in nondecreasing added-generation order',
  ),
  v.check(
    (ledger) => ledger.packs.every((row) => decimalAtMost(row.addedInGeneration, ledger.generation)),
    'A ledger cannot name a pack added after its own generation',
  ),
);
export type PackLedger = v.InferOutput<typeof PackLedgerSchema>;

/**
 * The v2 envelope names what this generation changed and nothing it did not:
 * the packs it PUT, the pack keys it stopped needing, and the ledger of every
 * live pack. There is no closure, so a publish and an attach cost O(k) and
 * O(1) remote operations rather than one HEAD per reachable object. The root
 * is a record inside one of the added packs, so an attach reads the row, the
 * envelope and the root, and nothing else.
 */
export const RootEnvelopeV2Schema = v.pipe(
  v.strictObject({
    version: v.literal(2),
    format: v.picklist(DURABLE_ROOT_FORMATS),
    boxId: IdSchema,
    epoch: DecimalSchema,
    generation: DecimalSchema,
    parentRootId: v.nullable(Sha256Schema),
    cut: CapturedCutSchema,
    /** The root record: a range inside one of this generation's packs. */
    rootObject: ObjectRangeRefSchema,
    /** The packs this generation PUT, in deterministic packing order. */
    added: v.array(ImmutableObjectRefSchema),
    /** Pack keys this generation stops needing, sorted; deleted by GC after grace. */
    retired: v.array(ObjectKeySchema),
    /** The pack ledger written beside this envelope. */
    ledger: ImmutableObjectRefSchema,
  }),
  v.check(
    (envelope) => allUnique(envelope.added.map((ref) => ref.key)),
    'A generation cannot add the same pack twice',
  ),
  v.check((envelope) => strictlyAscending(envelope.retired), 'Expected retired keys sorted without repeats'),
  v.check(
    (envelope) => !envelope.added.some((ref) => envelope.retired.includes(ref.key)),
    'A generation cannot retire a pack it adds',
  ),
  v.check(
    (envelope) => {
      const home = envelope.added.find((ref) => ref.key === envelope.rootObject.key);
      return (
        home !== undefined &&
        decimalAtMost(
          String(BigInt(envelope.rootObject.byteOffset) + BigInt(envelope.rootObject.byteLength)),
          home.byteLength,
        )
      );
    },
    'The root record must lie inside one of the added packs',
  ),
);
export type RootEnvelopeV2 = v.InferOutput<typeof RootEnvelopeV2Schema>;

export const HeadPointerV1Schema = v.strictObject({
  version: v.literal(1),
  rootEnvelopeId: Sha256Schema,
  lastOperationId: IdSchema,
});
export type HeadPointerV1 = v.InferOutput<typeof HeadPointerV1Schema>;

export const RestoreWorkSchema = v.strictObject({
  serialRemoteOps: CountSchema,
  totalRemoteOps: CountSchema,
  metadataBytes: CountSchema,
  payloadBytes: CountSchema,
  cpuSteps: CountSchema,
  mounts: CountSchema,
  replayUnits: CountSchema,
});
export type RestoreWork = v.InferOutput<typeof RestoreWorkSchema>;

/**
 * What one seal did, in the units its bound is stated in: O(k + p·d) means
 * `bytesStaged` and `bytesChunked` follow the bytes written since the last
 * seal and `nodesRewritten` follows the paths touched times their depth.
 * `wholeFiles` counts the one O(file) path, a file whose dirty cluster did not
 * resync inside its copied window, so it is named rather than hidden.
 */
export const SealWorkSchema = v.strictObject({
  bytesStaged: CountSchema,
  bytesChunked: CountSchema,
  chunksHashed: CountSchema,
  nodesRewritten: CountSchema,
  wholeFiles: CountSchema,
});
export type SealWork = v.InferOutput<typeof SealWorkSchema>;

/** What one publish did: single PUTs of fresh bytes plus the envelope and
 * ledger, and how many head CAS transactions it took. */
export const PublishWorkSchema = v.strictObject({
  objectsPut: CountSchema,
  bytesPut: CountSchema,
  casAttempts: CountSchema,
});
export type PublishWork = v.InferOutput<typeof PublishWorkSchema>;

/**
 * The hydrate quantum: how much a single page-in miss brings back.
 *
 * MEASURED, NOT CHOSEN. R2 answers a 64 KiB range and a 1 MiB range in the
 * same ~50-60 ms — a page-in is latency-bound, so a smaller window wastes the
 * round trip — while 8 MiB amortises bandwidth better and multiplies the bytes
 * one miss moves by eight (`bench/measure-first/MEASUREMENTS.md`, 2026-09-02).
 * One MiB is that cliff.
 */
export const HYDRATE_PAGE_BYTES = 1024 * 1024;

/**
 * How long a clean page may sit untouched before an eviction sweep may drop
 * it. The same window the pack ledger's retire-then-delete grace uses: a page
 * and a retired pack are the same bet — that nothing still needs the bytes —
 * and a box under disk pressure sweeps with the window set to zero, because
 * the alternative is refusing the write.
 */
export const CLEAN_PAGE_IDLE_MS = 600_000;

/** What one page-in miss cost: one coalesced range read per miss, and how far
 * the bytes fetched exceed the bytes the reader asked for. */
export const HydrateWorkSchema = v.strictObject({
  rangeGets: CountSchema,
  bytesFetched: CountSchema,
  bytesRequested: CountSchema,
});
export type HydrateWork = v.InferOutput<typeof HydrateWorkSchema>;

/** What one compaction did: packs it read, live bytes it copied into fresh
 * packs, and the file and ancestor nodes that took new locations. */
export const CompactionWorkSchema = v.strictObject({
  packsRead: CountSchema,
  bytesRewritten: CountSchema,
  nodesRewritten: CountSchema,
});
export type CompactionWork = v.InferOutput<typeof CompactionWorkSchema>;

/**
 * What one GC cycle did.
 *
 * TWO SWEEPS, ONE ROW, because they are the same decision at two distances:
 * `deletes` counts the ledger-driven deletes of retired packs AND the clean
 * local pages an eviction dropped, and the mark counts what the sweep
 * examined — node records and page rows, never a payload byte.
 */
export const GcWorkSchema = v.strictObject({
  deletes: CountSchema,
  markPages: CountSchema,
  markBytes: CountSchema,
});
export type GcWork = v.InferOutput<typeof GcWorkSchema>;

export const UploadIntentSchema = v.strictObject({
  operationId: IdSchema,
  attemptId: IdSchema,
  boxId: IdSchema,
  epoch: DecimalSchema,
  exactKey: ObjectKeySchema,
  method: v.literal('PUT'),
  byteLength: DecimalSchema,
  sha256: Sha256Schema,
  expiresAt: DecimalSchema,
});
export type UploadIntent = v.InferOutput<typeof UploadIntentSchema>;

export const RangeReadIntentSchema = v.strictObject({
  operationId: IdSchema,
  attemptId: IdSchema,
  boxId: IdSchema,
  epoch: DecimalSchema,
  exactKey: ObjectKeySchema,
  method: v.literal('GET'),
  byteOffset: DecimalSchema,
  byteLength: DecimalSchema,
  sha256: Sha256Schema,
  expiresAt: DecimalSchema,
});
export type RangeReadIntent = v.InferOutput<typeof RangeReadIntentSchema>;

export const PayloadGrantSchema = v.strictObject({
  operationId: IdSchema,
  attemptId: IdSchema,
  expiresAt: DecimalSchema,
  opaque: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
});
export type PayloadGrant = v.InferOutput<typeof PayloadGrantSchema>;


export const DURABILITY_OPERATION_KINDS = [
  'tick', 'barrier', 'gc', 'cleanup',
] as const;
export const DURABILITY_OPERATION_PHASES = [
  'intent', 'transferring', 'sealed', 'completion-pending', 'published', 'failed',
] as const;
const OperationBaseEntries = {
  operationId: IdSchema,
  kind: v.picklist(DURABILITY_OPERATION_KINDS),
  epoch: DecimalSchema,
  bootId: IdSchema,
  baseRevision: DecimalSchema,
  expectedParent: v.nullable(Sha256Schema),
};
export const OperationRecordSchema = v.variant('phase', [
  v.strictObject({ ...OperationBaseEntries, phase: v.literal('intent') }),
  v.strictObject({
    ...OperationBaseEntries,
    phase: v.literal('transferring'),
    attemptId: IdSchema,
  }),
  v.strictObject({
    ...OperationBaseEntries,
    phase: v.literal('sealed'),
    attemptId: IdSchema,
    resultRootId: Sha256Schema,
  }),
  v.strictObject({
    ...OperationBaseEntries,
    phase: v.literal('completion-pending'),
    attemptId: IdSchema,
    resultRootId: Sha256Schema,
  }),
  v.strictObject({
    ...OperationBaseEntries,
    phase: v.literal('published'),
    resultRootId: Sha256Schema,
  }),
  v.strictObject({
    ...OperationBaseEntries,
    phase: v.literal('failed'),
    failureCode: IdSchema,
  }),
]);
export type OperationRecord = v.InferOutput<typeof OperationRecordSchema>;

/** The sole candidate control authority persisted by a Devbox Durable Object.
 * Envelope metadata is immutable R2 data addressed by `head.rootEnvelopeId`;
 * keeping only that pointer here prevents the control record from becoming a
 * second envelope authority. */
export const CandidateControlStateV1Schema = v.strictObject({
  version: v.literal(1),
  head: v.nullable(HeadPointerV1Schema),
  operation: v.nullable(OperationRecordSchema),
});
export type CandidateControlStateV1 = v.InferOutput<typeof CandidateControlStateV1Schema>;

/** The control snapshot a container run receives. It pairs the durable head
 * pointer with the immutable envelope that pointer names, so the runner reads
 * root and closure metadata without ever becoming a head authority. */
export const CandidateRunHeadV1Schema = v.strictObject({
  pointer: HeadPointerV1Schema,
  envelope: RootEnvelopeV1Schema,
});
export type CandidateRunHeadV1 = v.InferOutput<typeof CandidateRunHeadV1Schema>;

export const CandidateRunControlV1Schema = v.strictObject({
  version: v.literal(1),
  head: v.nullable(CandidateRunHeadV1Schema),
  operation: v.nullable(OperationRecordSchema),
});
export type CandidateRunControlV1 = v.InferOutput<typeof CandidateRunControlV1Schema>;

/**
 * The v2 control snapshot a container run receives: the durable pointer with
 * the delta envelope it names. There is no closure to carry, so this is the
 * whole of what a sidecar needs to open a head — the row, the envelope, and
 * then one range read of the root record.
 */
export const CandidateRunHeadV2Schema = v.strictObject({
  pointer: HeadPointerV1Schema,
  envelope: RootEnvelopeV2Schema,
});
export type CandidateRunHeadV2 = v.InferOutput<typeof CandidateRunHeadV2Schema>;

export const CandidateRunControlV2Schema = v.strictObject({
  version: v.literal(2),
  head: v.nullable(CandidateRunHeadV2Schema),
  operation: v.nullable(OperationRecordSchema),
});
export type CandidateRunControlV2 = v.InferOutput<typeof CandidateRunControlV2Schema>;

/** Every external await where reset/re-drive behavior must be fault-injected. */
export const DURABILITY_AWAIT_POINTS = [
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
] as const;
export type DurabilityAwaitPoint = (typeof DURABILITY_AWAIT_POINTS)[number];

/**
 * Which await points an arm reaches. Fault injection at every register entry
 * is only a proof where the arm can reach the point; the rest are asserted
 * unreached, so a crash case nothing exercises cannot read as passed. `uses`
 * is in register order, so one set has one spelling.
 */
export const AwaitPointDeclarationSchema = v.strictObject({
  format: v.picklist(DURABLE_ROOT_FORMATS),
  uses: v.pipe(
    v.array(v.picklist(DURABILITY_AWAIT_POINTS)),
    v.check((points) => {
      let last = -1;
      for (const point of points) {
        const at = DURABILITY_AWAIT_POINTS.indexOf(point);
        if (at <= last) return false;
        last = at;
      }
      return true;
    }, 'Expected await points in register order without repeats'),
  ),
});
export type AwaitPointDeclaration = v.InferOutput<typeof AwaitPointDeclarationSchema>;

/** The register minus the declaration, in register order: what a fault cell
 * asserts the arm never visits. */
export function unreachedAwaitPoints(declaration: AwaitPointDeclaration): readonly DurabilityAwaitPoint[] {
  return DURABILITY_AWAIT_POINTS.filter((point) => !declaration.uses.includes(point));
}

/**
 * The merkle-pack/v2 arm. Packs are single PUTs under a size cap, so the three
 * multipart points are unreachable by construction; retired packs are deleted
 * after a grace window rather than held by pins, so the three pin points are
 * unreachable too. Parsed at load so the declaration cannot drift from the
 * register.
 */
export const MERKLE_PACK_V2_AWAIT_POINT_DECLARATION: AwaitPointDeclaration = v.parse(AwaitPointDeclarationSchema, {
  format: 'merkle-pack/v2',
  uses: [
    'issue-payload-grant',
    'verify-upload',
    'upload-root',
    'publish-head',
    'read-mark-page',
    'complete-mark',
    'retire-object',
    'delete-retired-object',
    'mount-root',
    'cleanup-resource',
  ],
});

/** What the sidecar can say about attach. `already-attached` is the Durable
 * Object's answer, never the sidecar's; `refused` names why, for example
 * `stale-parent` when another boot published past this one. */
export const SIDECAR_ATTACH_KINDS = ['attaching', 'empty', 'attached', 'refused'] as const;
export type SidecarAttachKind = (typeof SIDECAR_ATTACH_KINDS)[number];

/**
 * The status file the sidecar rewrites and the Durable Object reads on every
 * drive. The attach outcome is derived from `attach` each time rather than
 * remembered from a cold attach, the durability window is `lag`, hydration
 * progress is `hydration`, and `work` carries every counted row since boot so
 * a bound can be checked against what actually ran.
 */
export const SidecarStatusV1Schema = v.pipe(
  v.strictObject({
    version: v.literal(1),
    format: v.picklist(DURABLE_ROOT_FORMATS),
    boxId: IdSchema,
    epoch: DecimalSchema,
    bootId: IdSchema,
    attach: v.variant('kind', [
      v.strictObject({ kind: v.literal('attaching') }),
      v.strictObject({ kind: v.literal('empty') }),
      v.strictObject({ kind: v.literal('attached'), rootEnvelopeId: Sha256Schema, generation: DecimalSchema }),
      v.strictObject({ kind: v.literal('refused'), reason: IdSchema }),
    ]),
    /** Bytes and time not yet sealed, and generations and time sealed but not yet published. */
    lag: v.strictObject({
      unsealedBytes: CountSchema,
      unsealedMs: CountSchema,
      unpublishedGenerations: CountSchema,
      unpublishedMs: CountSchema,
    }),
    /** How much of the head is local: resident bytes over the tree's bytes, and placeholders still to page in. */
    hydration: v.strictObject({
      residentBytes: CountSchema,
      treeBytes: CountSchema,
      placeholders: CountSchema,
    }),
    work: v.strictObject({
      restore: RestoreWorkSchema,
      seal: SealWorkSchema,
      publish: PublishWorkSchema,
      hydrate: HydrateWorkSchema,
      compaction: CompactionWorkSchema,
      gc: GcWorkSchema,
    }),
  }),
  v.check(
    (status) => status.hydration.residentBytes <= status.hydration.treeBytes,
    'A box cannot hold more resident bytes than its tree has',
  ),
);
export type SidecarStatusV1 = v.InferOutput<typeof SidecarStatusV1Schema>;
