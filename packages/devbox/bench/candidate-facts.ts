/**
 * The candidate arms' store facts, read for the driver's lifecycle proof.
 *
 * Pure over an object reader, and outside `worker.ts` so a plain `bun test`
 * can prove the closure proof against a stub store: the Worker module pulls
 * in `cloudflare:workers`, which nothing outside workerd can load.
 *
 * PROVENANCE. First added in `4b2c25c76` ("the closure prefix",
 * 2026-09-05) with red-before/green-after regression
 * `tests/candidate-closure-facts.test.ts`. Deleted in `b56f83b54`
 * (2026-09-09, bench fixture ships one strategy) together with its test in
 * `32fd27369`. Restored 2026-09-10 as a bench-local verifier: the product
 * sources it imported are gone (`src/candidates/*` removed in `337eaf6f9`,
 * envelope shapes removed from `src/durability/contracts.ts`), so the shapes
 * it needs are defined HERE, copied from the archive and cited below. This
 * module is not a product route — `src/storage.ts:221` ships one strategy —
 * it is the fixture half a future decisive run including a candidate arm
 * must hold, so the run never re-derives the prefix join under pressure.
 *
 * WHAT IT PROVES. The envelope's payload keys are MOUNT-RELATIVE
 * (`obj/<sha256>`, `closure/<sha256>`). The runner stages them beneath the
 * store mounted at the payload prefix, and the product's own verification
 * joined the prefix before reading (`src/devbox.ts:2825` at
 * `archive/bounded-layers-attach`, `const key =
 * \`${paths.payloadPrefix}/${ref.key}\`` then `bucket.head(key)`). A facts
 * reader that asks for the bare keys reads every object absent while the
 * joined objects are there — run `kinu-devbox-bench-20260905075659` failed
 * bounded-layers' closure proof on 146 such false absences. The row carries
 * the JOINED key; the driver's prefix check then reads the address the
 * store was asked for.
 */

import { createHash } from 'node:crypto';

import * as v from 'valibot';

import { describeThrown } from '../src/lifecycle';

/** sha256 of bytes, as lowercase hex. Inlined from `src/cas/hash.ts` at
 *  `4b2c25c76` (`createHash('sha256').update(bytes).digest('hex')`), which
 *  `337eaf6f9` removed with the rest of `src/cas/`. */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The candidate arms, and the root-envelope format each one publishes. A
 *  non-candidate strategy has no entry, which is how the candidate route
 *  refused to serve chain or overlay facts as if they were candidate facts.
 *  Values from the archive at `4b2c25c76`: `BOUNDED_LAYERS_FORMAT` in
 *  `src/candidates/bounded-layers.ts:72` (`'bounded-layers/v1'`),
 *  `MERKLE_PACK_FORMAT` in `src/candidates/merkle-pack/wire.ts:23`
 *  (`'merkle-pack/v1'`). */
export const CANDIDATE_ENVELOPE_FORMAT = {
  'bounded-layers': 'bounded-layers/v1',
  'merkle-pack': 'merkle-pack/v1',
} as const;

export type CandidateStrategy = keyof typeof CANDIDATE_ENVELOPE_FORMAT;

// ── the archived shapes, inlined ────────────────────────────────────────────
//
// `src/durability/contracts.ts` at `4b2c25c76` held `ImmutableObjectRefSchema`,
// `CapturedCutSchema` and `RootEnvelopeV1Schema`; the single-strategy refactor
// (`337eaf6f9`) removed them. They are reproduced here so the verifier reads
// the SHIPPED envelope bytes rather than a re-imagined shape. Field for
// field with the archive; only the imports are gone.

const DecimalSchema = v.pipe(
  v.string(),
  v.regex(/^(?:0|[1-9]\d*)$/, 'Expected a canonical non-negative decimal string'),
);

const Sha256Schema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/, 'Expected a lowercase SHA-256 digest'));

const ObjectKeySchema = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));

const IdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128));

const ImmutableObjectRefSchema = v.strictObject({
  key: ObjectKeySchema,
  byteLength: DecimalSchema,
  sha256: Sha256Schema,
});

type ImmutableObjectRef = v.InferOutput<typeof ImmutableObjectRefSchema>;

const CapturedCutSchema = v.strictObject({
  captureId: IdSchema,
  epoch: DecimalSchema,
  baseRevision: DecimalSchema,
  cut: DecimalSchema,
  stableStageHandle: IdSchema,
  manifestSha256: Sha256Schema,
});

const RootEnvelopeV1Schema = v.strictObject({
  version: v.literal(1),
  format: v.picklist(['bounded-layers/v1', 'merkle-pack/v1']),
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

const envelopeEncoder = new TextEncoder();

/** Canonical envelope bytes: JSON plus one newline. From
 *  `src/candidates/publication.ts:338` at `4b2c25c76`. */
export function envelopeBytes(envelope: RootEnvelopeV1): Uint8Array {
  return envelopeEncoder.encode(`${JSON.stringify(envelope)}\n`);
}

/** The envelope's only identity: sha256 of its canonical bytes. From
 *  `src/candidates/publication.ts:342` at `4b2c25c76`. */
export function envelopeIdOf(envelope: RootEnvelopeV1): string {
  return sha256Hex(envelopeBytes(envelope));
}

/** This arm's store prefixes. From `src/candidates/container.ts:37` at
 *  `4b2c25c76` (`candidateStorePaths`, which returned the named
 *  `CandidateStorePaths`): the payload subtree the container replacement
 *  owns, and the control prefix DELIBERATELY outside it, so an envelope key
 *  that fell inside the mount would be a defect. */
export interface CandidateStorePaths {
  readonly payloadPrefix: string;
  readonly envelopePrefix: string;
}

export function candidateStorePaths(boxPrefix: string, strategy: CandidateStrategy): CandidateStorePaths {
  return {
    payloadPrefix: `${boxPrefix}/candidate/${strategy}`,
    envelopePrefix: `${boxPrefix}/candidate-control/${strategy}/envelopes`,
  };
}

// ── candidate control facts ─────────────────────────────────────────────────
//
// The DRIVER judges a candidate arm's lifecycle. This fixture only reports
// facts, because a fixture that returned a verdict would be the thing under
// test grading itself.
//
// Three of those facts exist only in the object store, and no container command
// can reach them: which root envelopes this arm published, whether each is the
// immutable object its own key digest claims it is, and whether the payload
// closure the head envelope names is completely present at the declared byte
// lengths. The envelope prefix is deliberately OUTSIDE the payload subtree a
// container replacement owns, so an envelope key that fell inside the mount
// would be a defect rather than a detail.

/** The object rows a closure proof reads. Narrower than `R2Bucket` on purpose:
 *  the proof is then provable against a store that cannot lie about paging. */
export interface CandidateObjectReader {
  list(options: { prefix: string; cursor?: string }): Promise<{
    objects: readonly { readonly key: string; readonly size: number }[];
    truncated: boolean;
    cursor?: string;
  }>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  head(key: string): Promise<{ readonly size: number } | null>;
}

/** One object the head envelope names, and what the store actually holds for
 *  it. `storedBytes` is null when the key is absent — never 0, which is a real
 *  length an empty object could have. */
export interface CandidateClosureRow {
  readonly key: string;
  /** The canonical decimal byte length the envelope declares. */
  readonly declaredBytes: string;
  readonly storedBytes: number | null;
}

export interface CandidateEnvelopeRow {
  readonly key: string;
  readonly rootEnvelopeId: string;
  /** sha256 of the stored bytes. The key names a digest, so a value that
   *  disagrees means the envelope is not the immutable object its address
   *  claims and nothing may be restored from it. */
  readonly sha256: string;
  readonly format: string;
  readonly boxId: string;
  readonly generation: string;
  readonly cut: string;
  readonly closureCount: number;
}

export interface CandidateStoreFacts {
  readonly payloadPrefix: string;
  readonly envelopePrefix: string;
  /** The durable-object id this arm's envelopes must be stamped with. */
  readonly expectedBoxId: string;
  /** The root-envelope format this arm must publish. */
  readonly expectedFormat: string;
  readonly envelopes: readonly CandidateEnvelopeRow[];
  /** The single greatest-generation envelope, or null when there is none or
   *  more than one shares that generation. */
  readonly head: CandidateEnvelopeRow | null;
  /** Envelope keys sharing the greatest generation when more than one does. A
   *  forked head has no single authority to restore from. */
  readonly forkedHeads: readonly string[];
  /** Every object the head envelope names: its root, its closure manifest, and
   *  the closure itself. Empty when there is no single head. */
  readonly closure: readonly CandidateClosureRow[];
  /** Keys listed under the envelope prefix that could not be read as a root
   *  envelope, with the reason each one failed. */
  readonly unreadable: readonly string[];
}

async function listAllObjects(
  reader: CandidateObjectReader,
  prefix: string,
): Promise<readonly { readonly key: string; readonly size: number }[]> {
  const rows: { readonly key: string; readonly size: number }[] = [];
  let cursor: string | undefined;

  for (;;) {
    const page = await reader.list(cursor === undefined ? { prefix } : { prefix, cursor });
    rows.push(...page.objects);

    if (!page.truncated) return rows;

    // A truncated page carrying no cursor cannot be continued. Returning its
    // partial rows would let a newer envelope or a fork hide on the next page,
    // so a missing cursor is a hard fact-collection failure, never a short
    // listing the driver might mistake for a complete control envelope set.
    if (page.cursor === undefined) {
      throw new Error(`candidate object listing for ${prefix} was truncated without a cursor`);
    }

    cursor = page.cursor;
  }
}

type EnvelopeDecode =
  | { readonly ok: true; readonly envelope: RootEnvelopeV1 }
  | { readonly ok: false; readonly reason: string };

const envelopeDecoder = new TextDecoder('utf-8', { fatal: true });

/** Decode one stored envelope. Every failure is a REASON rather than a throw:
 *  one unreadable envelope must not hide the arm's other envelopes. */
function decodeEnvelope(bytes: Uint8Array): EnvelopeDecode {
  let text: string;

  try {
    text = envelopeDecoder.decode(bytes);
  } catch (cause) {
    return { ok: false, reason: `is not UTF-8: ${describeThrown({ cause })}` };
  }

  let decoded: unknown;

  try {
    decoded = JSON.parse(text);
  } catch (cause) {
    return { ok: false, reason: `is not JSON: ${describeThrown({ cause })}` };
  }

  const parsed = v.safeParse(RootEnvelopeV1Schema, decoded);

  return parsed.success
    ? { ok: true, envelope: parsed.output }
    : { ok: false, reason: `is not a root envelope: ${parsed.issues[0]?.message ?? 'unknown shape'}` };
}

/**
 * Read this arm's control envelopes and resolve the head's payload closure.
 *
 * Exported so the closure proof is provable against a stub store: the live
 * route only supplies the bucket and the arm's own prefixes.
 */
export async function candidateStoreFacts(
  reader: CandidateObjectReader,
  strategy: CandidateStrategy,
  boxPrefix: string,
): Promise<CandidateStoreFacts> {
  const paths = candidateStorePaths(boxPrefix, strategy);
  const envelopePrefix = `${paths.envelopePrefix}/`;
  const listed = await listAllObjects(reader, envelopePrefix);
  const decoded: { readonly row: CandidateEnvelopeRow; readonly envelope: RootEnvelopeV1 }[] = [];
  const unreadable: string[] = [];

  for (const listedRow of listed) {
    const object = await reader.get(listedRow.key);

    if (object === null) {
      unreadable.push(`${listedRow.key} was listed but holds no bytes`);
      continue;
    }

    const bytes = new Uint8Array(await object.arrayBuffer());
    const result = decodeEnvelope(bytes);

    if (!result.ok) {
      unreadable.push(`${listedRow.key} ${result.reason}`);
      continue;
    }

    decoded.push({
      row: {
        key: listedRow.key,
        // The key IS the claimed digest; the extension is its only decoration.
        rootEnvelopeId: listedRow.key.slice(envelopePrefix.length).replace(/\.json$/, ''),
        sha256: sha256Hex(bytes),
        format: result.envelope.format,
        boxId: result.envelope.boxId,
        generation: result.envelope.generation,
        cut: result.envelope.cut.cut,
        closureCount: result.envelope.closure.length,
      },
      envelope: result.envelope,
    });
  }

  // THE HEAD IS THE GREATEST GENERATION, and only when exactly one envelope
  // holds it. Two envelopes at one generation is a fork: a restore would pick
  // one arbitrarily, so the fact says there is no head rather than choosing.
  const greatest = decoded.reduce<bigint | null>((best, entry) => {
    const generation = BigInt(entry.row.generation);

    return best === null || generation > best ? generation : best;
  }, null);

  const newest = greatest === null
    ? []
    : decoded.filter((entry) => BigInt(entry.row.generation) === greatest);

  const headEntry = newest.length === 1 ? newest[0] : undefined;

  // THE ENVELOPE'S KEYS ARE MOUNT-RELATIVE. The runner writes `obj/<sha>`
  // and `closure/<sha>` beneath the store mounted at the payload prefix, and
  // the product's own verification joins the two (`verifyObject` in
  // `src/devbox.ts` at `archive/bounded-layers-attach`). Asked bare, every
  // key reads absent and outside the prefix: run 20260905075659 failed
  // bounded-layers' closure proof on 146 objects that were all there. The row
  // carries the joined key, so the driver's prefix check reads the address
  // the store was asked for.
  const closure: CandidateClosureRow[] = [];

  if (headEntry !== undefined) {
    const seen = new Set<string>();

    const refs: readonly ImmutableObjectRef[] = [
      headEntry.envelope.rootObject,
      headEntry.envelope.closureObject,
      ...headEntry.envelope.closure,
    ];

    for (const ref of refs) {
      if (seen.has(ref.key)) continue;
      seen.add(ref.key);
      const key = `${paths.payloadPrefix}/${ref.key}`;
      const stored = await reader.head(key);
      closure.push({
        key,
        declaredBytes: ref.byteLength,
        storedBytes: stored === null ? null : stored.size,
      });
    }
  }

  return {
    payloadPrefix: `${paths.payloadPrefix}/`,
    envelopePrefix,
    expectedBoxId: boxPrefix.replace(/^boxes\//, ''),
    expectedFormat: CANDIDATE_ENVELOPE_FORMAT[strategy],
    envelopes: decoded.map((entry) => entry.row),
    head: headEntry?.row ?? null,
    forkedHeads: newest.length > 1 ? newest.map((entry) => entry.row.key) : [],
    closure,
    unreadable,
  };
}
