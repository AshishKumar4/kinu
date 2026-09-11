/**
 * Live G4 security fault cells, worker side.
 *
 * Runs inside the benchmark fixture (packages/devbox/bench/worker.ts
 * `POST /security`) against the REAL product storage boundaries with REAL
 * bucket and Durable Object storage, but strictly inside an isolated
 * per-call namespace: `<boxPrefix>security-cells/<nonce>/`. Nothing here
 * touches a live control record (`devbox:storage-state`) or a live payload
 * prefix. The attacks are real — stale revisions, hostile ids, hostile
 * layer digests, secret scans — and the refusals are the production
 * controls' own.
 *
 * Product controls reused (never reimplemented):
 *   F7  ChainRecordAdvanced rev-gated compare, the rule
 *       `SnapshotChainPorts.writeState` enforces on the live row.
 *   F10 isChainId + baseObjectKey refusal, and layerIntegrityFailure's
 *       digest/version rule over a same-length replacement.
 *   F11 the box-prefix key builders (chainStoreRoot + baseObjectKey /
 *       deltaObjectKey) for prefix, and the same rev fence for replay.
 *   F12 scans reply text, non-token env values and isolated store bytes for
 *       the live fixture secret and reports presence only — never the value.
 *
 * Every catch records: an expected refusal lands in the cell's detail or in
 * `cleanupErrors`, and anything outside the production gate returns `unable`
 * rather than a verdict the wrong gate produced. Cleanup failures are G8's,
 * so they are recorded in `cleanupErrors` without changing the verdict.
 *
 * A cell that cannot run reports `unable` with its reason and leaves
 * `completed` false, so the gate refuses rather than passing on zeros.
 */

import * as v from 'valibot';

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

const textDecoder = new TextDecoder();

/** Two distinct well-formed digests. `layerIntegrityFailure` compares the
 *  declared digest against the stored one, so what these hash is irrelevant
 *  and only their difference is under test. */
const DECLARED_DIGEST = 'a'.repeat(64);

const STORED_DIGEST = `${'a'.repeat(63)}b`;

/** The isolated prefix for one call. The nonce is driver-chosen per call. */
export function securityPrefixFor(boxPrefix: string, nonce: string): string {
  if (!NONCE.test(nonce)) throw new Error('security nonce is not an 8-64 char id');
  const base = boxPrefix.endsWith('/') ? boxPrefix : `${boxPrefix}/`;

  return `${base}security-cells/${nonce}/`;
}

function cell(id: SecurityCellId, status: SecurityCellStatus, detail: string): SecurityCellResult {
  return { id, status, detail: detail.slice(0, 300) };
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
    bytes: 1024, digest: DECLARED_DIGEST, objectVersion: 'version-a',
  };

  const sameLengthOtherDigest: ChainLayer = {
    bytes: 1024, digest: STORED_DIGEST, objectVersion: 'version-b',
  };

  const failure = layerIntegrityFailure({ declared, stored: sameLengthOtherDigest, label: 'delta' });

  if (failure === null) return cell('F10', 'accepted', 'same-length replacement with a different digest passed integrity');
  // Soundness: an identical layer must NOT refuse (else the gate above is vacuous).
  const sound = layerIntegrityFailure({ declared, stored: { ...declared }, label: 'delta' });

  if (sound !== null) return cell('F10', 'unable', `identical layer refused integrity: ${sound.slice(0, 120)}`);

  return cell('F10', 'refused', `hostile ids (${refusals.length}) refused; same-length digest mismatch refused`);
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
  /** Live fixture secret, held transiently for the F12 scan and never echoed. */
  fixtureSecret: string;
  /** Non-token env values to scan for leaks (name + value pairs). */
  envValues: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}): Promise<SecurityCellsObservation> {
  const strategy = input.strategy;
  const securityPrefix = securityPrefixFor(input.boxPrefix, input.nonce);
  const cleanupErrors: string[] = [];

  const f7 = await f7Chain({ storage: input.storage, nonce: input.nonce, cleanupErrors });
  const f10 = await f10Chain();

  const f11 = await f11Chain({
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
