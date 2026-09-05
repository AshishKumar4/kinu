/**
 * The candidate arms' store facts, read for the driver's lifecycle proof.
 *
 * Pure over an object reader, and outside `worker.ts` so a plain `bun test`
 * can prove the closure proof against a stub store: the Worker module pulls
 * in `cloudflare:workers`, which nothing outside workerd can load.
 */

import * as v from 'valibot';

import { sha256Hex } from '../src/cas/hash';
import { BOUNDED_LAYERS_FORMAT } from '../src/candidates/bounded-layers';
import { candidateStorePaths } from '../src/candidates/container';
import { MERKLE_PACK_FORMAT } from '../src/candidates/merkle-pack';
import { RootEnvelopeV1Schema } from '../src/durability/contracts';
import type { RootEnvelopeV1 } from '../src/durability/contracts';
import { describeThrown } from '../src/lifecycle';
import type { DevboxStrategyName } from '../src/storage';

/** The candidate arms, and the root-envelope format each one publishes. A
 *  non-candidate strategy has no entry, which is how the candidate route
 *  refuses to serve chain or overlay facts as if they were candidate facts. */
export const CANDIDATE_ENVELOPE_FORMAT = {
  'bounded-layers': BOUNDED_LAYERS_FORMAT,
  'merkle-pack': MERKLE_PACK_FORMAT,
} as const satisfies Partial<Record<DevboxStrategyName, string>>;

export type CandidateStrategy = keyof typeof CANDIDATE_ENVELOPE_FORMAT;

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
  // `src/devbox.ts`). Asked bare, every key read absent and outside the
  // prefix: run 20260905075659 failed bounded-layers' closure proof on 146
  // objects that were all there. The row carries the joined key, so the
  // driver's prefix check reads the address the store was asked for.
  const closure: CandidateClosureRow[] = [];
  if (headEntry !== undefined) {
    const seen = new Set<string>();
    for (const ref of [
      headEntry.envelope.rootObject,
      headEntry.envelope.closureObject,
      ...headEntry.envelope.closure,
    ]) {
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

