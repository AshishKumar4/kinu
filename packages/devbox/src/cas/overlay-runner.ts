import * as v from 'valibot';

import { createHash } from 'node:crypto';
import { lstat, open, readlink, readdir } from 'node:fs/promises';
import { closeSync, constants as FS } from 'node:fs';
import type { Stats } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { BeneathError, BeneathRoot } from '../native-openat2';
import { describeThrown } from '../lifecycle';

import {
  CAS_FORMAT_VERSION,
  CHUNK_SIZE,
  appendJournalBatch,
  blobKey,
  counterDelta,
  emptyCounters,
  encodeJson,
  foldJournalIntoTree,
  replayPending,
  stageBlobs,
  stampEntries,
  sweepOrphanBlobs,
  throughStorePool,
  type CasPutMeta,
  type CasStore,
  type FileDigest,
  type NewJournalEntry,
  type StoreCounters,
} from './index';
import { byApplyOrder, PendingJournalState } from './pending-state';
import { UpperSignatureSchema, type UpperSignature } from './state';

const OPAQUE_MARKER = '.wh..wh..opq';
const WHITEOUT_PREFIX = '.wh.';

/** The scan cache, beside the bytes it describes. */
const KEY_SCAN = 'scan.json';

const ScanCacheSchema = v.strictObject({
  version: v.literal(CAS_FORMAT_VERSION),
  signatures: v.record(v.string(), UpperSignatureSchema),
});

/**
 * WHERE A RUN SPENT ITSELF, when someone asks it to say.
 *
 * A phase's milliseconds do not name its cost. Every phase below is a straight
 * line of store calls whose per-call latency dwarfs anything local, so a row
 * carries the store's own counter delta beside the wall time:
 * a minute spent on two thousand metadata round trips and a minute spent moving
 * a gigabyte are the same number and different defects, and only the counters
 * tell them apart. `detail` carries whatever else that phase counted — paths
 * walked, files digested — so a breakdown can be attributed to a term rather
 * than admired.
 *
 * Off unless a sink is supplied: a production run pays one branch per phase and
 * allocates nothing.
 */
export interface ProfileRow {
  readonly phase: string;
  readonly ms: number;
  readonly store: StoreCounters;
  readonly detail?: Readonly<Record<string, number>>;
}

export type ProfileSink = (row: ProfileRow) => void;

/** Time one phase and bill it to the store that served it. */
function profiler(store: CasStore, sink: ProfileSink | undefined) {
  return async <T>(
    phase: string,
    run: () => Promise<T>,
    detail?: (value: T) => Readonly<Record<string, number>>,
  ): Promise<T> => {
    if (sink === undefined) return await run();
    const before = { ...store.counters };
    const started = performance.now();
    const value = await run();
    const row = { phase, ms: Math.round(performance.now() - started), store: counterDelta(before, store.counters) };
    sink(detail === undefined ? row : { ...row, detail: detail(value) });
    return value;
  };
}

/** A phase that touches no store, timed the same way so one table holds both. */
function localPhase(
  sink: ProfileSink | undefined,
  phase: string,
  started: number,
  detail: Readonly<Record<string, number>>,
): void {
  if (sink === undefined) return;
  sink({ phase, ms: Math.round(performance.now() - started), store: emptyCounters(), detail });
}

/**
 * What the previous scan recorded, or nothing.
 *
 * A cache is not authority — the pending journal is — so a row this release
 * did not write reads as ABSENT. That costs one full re-scan and cannot lose a
 * change, where refusing would brick every checkpoint until someone deleted
 * the object by hand.
 */
async function readScanCache(store: CasStore): Promise<ReadonlyMap<string, UpperSignature>> {
  const bytes = await store.get(KEY_SCAN);
  if (bytes === null) return new Map();
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    // Recorded on stderr, never stdout: stdout carries the receipt.
    console.error(
      `[overlay-cas-runner] scan cache is not JSON and was ignored: ${describeThrown({ cause: error })}`,
    );
    return new Map();
  }
  const parsed = v.safeParse(ScanCacheSchema, raw);
  return parsed.success ? new Map(Object.entries(parsed.output.signatures)) : new Map();
}

/** Two rows for the same path, field for field. Only these fields decide
 *  whether the next scan re-reads a path, so only these decide whether the row
 *  on the store is stale. */
function sameSignature(a: UpperSignature | undefined, b: UpperSignature): boolean {
  return a !== undefined && a.kind === b.kind && a.mode === b.mode && a.mtimeMs === b.mtimeMs
    && a.size === b.size && a.hash === b.hash && a.target === b.target
    && a.device === b.device && a.inode === b.inode;
}

/** The rows a tick would leave on the store, and whether storing them would
 *  change anything. `changed` is the write condition — see {@link nextScanCache}. */
export interface ScanCacheUpdate {
  readonly signatures: ReadonlyMap<string, UpperSignature>;
  readonly changed: boolean;
}

/**
 * THE STALE BYSTANDER RULE, applied to the cache this scan may write.
 *
 * `stageBlobs` stops at the first file that changed under it, so every entry
 * after that one in the order was scanned and NEVER journalled. Caching those
 * fresh signatures would tell the next scan the change was already committed,
 * and it would be lost on the next recycle. So an unjournalled path keeps its
 * PREVIOUS row and is detected again; a tombstoned path loses its row, because
 * the path no longer exists to be detected.
 *
 * `changed` IS THE WRITE CONDITION, and it is reported from here because here
 * is the only place that knows it. The caller used to infer it — "staging took
 * fewer entries than the scan measured, so some row is stale" — and that
 * inference is PERMANENTLY TRUE for an upper holding one deletion or one opaque
 * directory: both re-emit an entry on every pass and neither leaves a row that
 * could ever satisfy the comparison. A box holding a single deleted file
 * therefore rewrote its whole scan cache every interval, forever, to store
 * bytes identical to the ones already there. Measured on the deployed 1 MB arm
 * at one 25,072 B PUT of 1,975 ms per idle tick.
 *
 * Exported because the rule is reached only when staging refuses a file that
 * changed under it, which no caller can arrange from outside this process.
 */
export function nextScanCache(
  previous: ReadonlyMap<string, UpperSignature>,
  scanned: ReadonlyMap<string, UpperSignature>,
  unjournalled: ReadonlySet<string>,
  tombstoned: ReadonlySet<string>,
): ScanCacheUpdate {
  const next = new Map(previous);
  let changed = false;
  for (const [path, signature] of scanned) {
    if (unjournalled.has(path)) continue;
    if (!sameSignature(next.get(path), signature)) changed = true;
    next.set(path, signature);
  }
  for (const path of tombstoned) {
    if (next.delete(path)) changed = true;
  }
  return { signatures: next, changed };
}

/**
 * A key as the SDK's egress endpoint stores it. Every segment is
 * percent-encoded the way s3fs encodes an object path (RFC 3986 unreserved
 * characters only), because the endpoint keeps the path as it arrives and the
 * lower mount looks `tree/` objects up by that spelling. A trailing `/` is a
 * directory, never an empty segment.
 */
function encodedKey(key: string): string {
  const parts = (key.endsWith('/') ? key.slice(0, -1) : key).split('/');
  if (key.length === 0 || parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`CAS store refused unsafe key: ${key}`);
  }
  return key.split('/')
    .map(part => encodeURIComponent(part).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

/** The four entities `escapeXML` in the endpoint's listing produces, `&amp;`
 *  last so an escaped ampersand is not decoded twice. */
function unescapeXml(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

/**
 * The store, over the SDK's egress endpoint for a mounted R2 binding:
 * `http://r2.internal/<binding>/<key>`, path-style, no credential. Mounting the
 * binding with `mountBucket` is what registers the host for interception and
 * what makes every key here land under the mount's prefix; the s3fs mount
 * itself is only the overlay's read-only lower from then on.
 *
 * ONE REQUEST PER STORE CALL, and a PUT is complete when its receipt says so.
 * The endpoint answers a PUT with R2's own ETag, which for a single-part
 * upload is the MD5 of the body, so a PUT is verified against the bytes this
 * process sent and not against a status alone. Nothing here writes a temp
 * object and renames it: through the mount that rename was a server-side
 * COPY plus a DELETE per object, and it was 97.9% of a 400 s tick (probe
 * ocs09011400, 2026-09-01).
 *
 * WHAT THE ENDPOINT KEEPS. `handlePutObject` forwards Content-Type and drops
 * every `x-amz-meta-*` header (SDK 0.12.8, `sandbox-CPj2jsbz.js`). The mode
 * and mtime are still sent, as s3fs spells them, because they are the object's
 * POSIX facts and a conforming S3 store keeps them; on this platform the type
 * survives and the mode does not, which is the fidelity the arm declares.
 */
export class HttpCasStore implements CasStore {
  readonly counters: StoreCounters = emptyCounters();

  constructor(private readonly base: string) {}

  async put(key: string, bytes: Uint8Array, meta?: CasPutMeta): Promise<void> {
    this.counters.putCalls += 1;
    const response = await fetch(`${this.base}/${encodedKey(key)}`, {
      method: 'PUT', headers: putHeaders(key, bytes.byteLength, meta), body: bodyOf(bytes),
    });
    await verifyReceipt(key, response, createHash('md5').update(bytes).digest('hex'));
    this.counters.bytesPut += bytes.byteLength;
  }

  async putStream(
    key: string,
    stream: ReadableStream<Uint8Array>,
    size: number,
    meta?: CasPutMeta,
  ): Promise<void> {
    // THE SIZE IS THE ORACLE. The caller measured these bytes before the
    // stream was read, and a short read is how a file still settling gets
    // published as a complete object. The digest rides along so the receipt
    // is checked against what actually went over the wire.
    const digest = createHash('md5');
    let landed = 0;
    const counted = stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        landed += chunk.byteLength;
        digest.update(chunk);
        controller.enqueue(chunk);
      },
      flush(controller) {
        // Content-Length already bounds what the wire accepts; a SHORT stream
        // is the case only this side can refuse before a partial body is
        // answered as an object.
        if (landed !== size) controller.error(new Error(`${key} streamed ${landed} bytes, expected ${size}`));
      },
    }));
    this.counters.putCalls += 1;
    const response = await fetch(`${this.base}/${encodedKey(key)}`, {
      method: 'PUT', headers: putHeaders(key, size, meta), body: counted,
    });
    await verifyReceipt(key, response, digest.digest('hex'));
    this.counters.bytesPut += size;
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.counters.getCalls += 1;
    const response = await fetch(`${this.base}/${encodedKey(key)}`);
    if (response.status === 404) {
      await response.arrayBuffer();
      return null;
    }
    if (response.status !== 200) throw await refused('GET', key, response);
    const bytes = new Uint8Array(await response.arrayBuffer());
    this.counters.bytesGot += bytes.byteLength;
    return bytes;
  }

  async delete(key: string): Promise<void> {
    this.counters.deleteCalls += 1;
    const response = await fetch(`${this.base}/${encodedKey(key)}`, { method: 'DELETE' });
    if (!response.ok) throw await refused('DELETE', key, response);
    await response.arrayBuffer();
  }

  /** Every key under `prefix`, one request per page of at most 1000. */
  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      this.counters.listCalls += 1;
      const query = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': '1000' });
      if (token !== undefined) query.set('continuation-token', token);
      const response = await fetch(`${this.base}/?${query.toString()}`);
      if (response.status !== 200) throw await refused('LIST', prefix, response);
      const page = await response.text();
      for (const match of page.matchAll(/<Key>([^<]*)<\/Key>/g)) {
        keys.push(decodeURIComponent(unescapeXml(match[1] ?? '')));
      }
      const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(page)?.[1];
      token = next === undefined ? undefined : unescapeXml(next);
    } while (token !== undefined);
    return keys.sort();
  }
}

function putHeaders(key: string, size: number, meta: CasPutMeta | undefined): Headers {
  const headers = new Headers({
    'content-length': String(size),
    'content-type': key.endsWith('/') ? 'application/x-directory' : 'application/octet-stream',
  });
  if (meta !== undefined) {
    headers.set('x-amz-meta-mode', String(meta.mode));
    if (meta.mtimeMs !== undefined) headers.set('x-amz-meta-mtime', (meta.mtimeMs / 1000).toFixed(3));
  }
  return headers;
}

/** The same bytes, no copy, as a view over their own `ArrayBuffer`: the type a
 *  request body takes under the Workers program that also compiles this file.
 *  Nothing here ever hands a shared buffer to a request, so that is refused
 *  rather than sliced. */
function bodyOf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const { buffer } = bytes;
  if (!(buffer instanceof ArrayBuffer)) throw new Error('a shared buffer cannot be a request body');
  return new Uint8Array(buffer, bytes.byteOffset, bytes.byteLength);
}

/** A PUT is confirmed by a 200 whose ETag is the MD5 of the body sent. */
async function verifyReceipt(key: string, response: Response, md5: string): Promise<void> {
  const etag = response.headers.get('etag')?.replace(/^"|"$/g, '');
  if (response.status === 200 && etag === md5) {
    await response.arrayBuffer();
    return;
  }
  const words = (await response.text()).trim().slice(0, 200);
  throw new Error(
    `the store did not confirm ${key}: HTTP ${response.status}, ETag ${etag ?? 'absent'} for a body of `
    + `MD5 ${md5}${words.length > 0 ? ` (${words})` : ''}`,
  );
}

async function refused(verb: string, key: string, response: Response): Promise<Error> {
  const words = (await response.text()).trim().slice(0, 200);
  return new Error(`${verb} ${key}: HTTP ${response.status}${words.length > 0 ? ` ${words}` : ''}`);
}

async function* walk(root: string): AsyncGenerator<string> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    yield path;
    if (entry.isDirectory()) yield* walk(path);
  }
}

async function digestFile(path: string): Promise<FileDigest> {
  const handle = await open(path, 'r');
  try {
    const whole = createHash('sha256');
    const parts: { kind: 'data'; hash: string; size: number }[] = [];
    const buffer = new Uint8Array(CHUNK_SIZE);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      const bytes = buffer.slice(0, bytesRead);
      whole.update(bytes);
      parts.push({ kind: 'data', hash: createHash('sha256').update(bytes).digest('hex'), size: bytesRead });
      size += bytesRead;
    }
    return { hash: whole.digest('hex'), size, parts };
  } finally {
    await handle.close();
  }
}

async function scanUpper(
  upper: string,
  previous: ReadonlyMap<string, UpperSignature>,
  sink?: ProfileSink,
): Promise<{ entries: readonly NewJournalEntry[]; signatures: ReadonlyMap<string, UpperSignature> }> {
  const records: { path: string; absolute: string; stat: Stats }[] = [];
  const files: typeof records = [];
  const walked = performance.now();
  try {
    for await (const absolute of walk(upper)) {
      records.push({ path: relative(upper, absolute).split(sep).join('/'), absolute, stat: await lstat(absolute) });
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`overlay upper vanished: ${upper}`, { cause: error });
    }
    throw error;
  }
  localPhase(sink, 'scan/walk-upper', walked, { paths: records.length });
  const classified = performance.now();
  const opaque = new Set<string>();
  const entries: NewJournalEntry[] = [];
  const signatures = new Map<string, UpperSignature>();
  for (const record of records) {
    const name = record.path.slice(record.path.lastIndexOf('/') + 1);
    if (name === OPAQUE_MARKER) opaque.add(record.path.slice(0, Math.max(0, record.path.lastIndexOf('/'))));
  }
  for (const record of records) {
    const name = record.path.slice(record.path.lastIndexOf('/') + 1);
    const parent = record.path.includes('/') ? record.path.slice(0, record.path.lastIndexOf('/')) : '';
    const mode = Number(record.stat.mode);
    const mtimeMs = Math.round(Number(record.stat.mtimeMs));
    if (name === OPAQUE_MARKER) continue;
    if (name.startsWith(WHITEOUT_PREFIX)) {
      const hidden = name.slice(WHITEOUT_PREFIX.length);
      entries.push({ kind: 'delete', path: parent === '' ? hidden : `${parent}/${hidden}` });
      continue;
    }
    if (record.stat.isSymbolicLink()) {
      const target = await readlink(record.absolute);
      const signature: UpperSignature = { kind: 'symlink', mode, mtimeMs, size: Number(record.stat.size), target };
      signatures.set(record.path, signature);
      if (previous.get(record.path)?.kind !== 'symlink' || previous.get(record.path)?.target !== target) {
        entries.push({ kind: 'symlink', path: record.path, target, mode, mtimeMs });
      }
      continue;
    }
    if (record.stat.isDirectory()) {
      const signature: UpperSignature = { kind: 'dir', mode, mtimeMs, size: 0 };
      signatures.set(record.path, signature);
      if (opaque.has(record.path) || previous.get(record.path)?.kind !== 'dir' || previous.get(record.path)?.mode !== mode) {
        entries.push({ kind: 'dir', path: record.path, mode, mtimeMs, opaque: opaque.has(record.path) });
      }
      continue;
    }
    if (record.stat.isFile()) files.push(record);
  }
  localPhase(sink, 'scan/classify', classified, { files: files.length, entries: entries.length });
  const digested = performance.now();
  let rehashed = 0;
  let rehashedBytes = 0;
  const links = new Map<string, typeof records>();
  for (const file of files) {
    const key = `${file.stat.dev}:${file.stat.ino}`;
    const group = links.get(key) ?? [];
    group.push(file);
    links.set(key, group);
  }
  for (const group of links.values()) {
    group.sort((a, b) => a.path.localeCompare(b.path));
    const canonical = group[0]!;
    const mode = Number(canonical.stat.mode);
    const mtimeMs = Math.round(Number(canonical.stat.mtimeMs));
    const device = String(canonical.stat.dev);
    const inode = String(canonical.stat.ino);
    const before = previous.get(canonical.path);
    if (before?.kind === 'file' && before.mode === mode && before.size === Number(canonical.stat.size)
      && before.mtimeMs === mtimeMs && before.device === device && before.inode === inode
      && before.hash !== undefined) {
      for (const file of group) signatures.set(file.path, before);
      continue;
    }
    const digest = await digestFile(canonical.absolute);
    rehashed += 1;
    rehashedBytes += digest.size;
    const signature: UpperSignature = {
      kind: 'file', mode, mtimeMs, size: digest.size, hash: digest.hash, device, inode,
    };
    signatures.set(canonical.path, signature);
    entries.push({
      kind: 'file', path: canonical.path, mode, mtimeMs, size: digest.size, hash: digest.hash, parts: digest.parts,
    });
    for (const alias of group.slice(1)) {
      const aliasMode = Number(alias.stat.mode);
      const aliasMtimeMs = Math.round(Number(alias.stat.mtimeMs));
      signatures.set(alias.path, { ...signature, mode: aliasMode, mtimeMs: aliasMtimeMs });
      entries.push({
        kind: 'hardlink', path: alias.path, target: canonical.path, mode: aliasMode, mtimeMs: aliasMtimeMs,
      });
    }
  }
  localPhase(sink, 'scan/digest', digested, { rehashed, rehashedBytes, reused: files.length - rehashed });
  entries.sort(byApplyOrder);
  return { entries, signatures };
}

function parentDirectory(path: string): string | null {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? null : path.slice(0, slash);
}

function mtimeNs(entry: { readonly mtimeMs: number }): bigint {
  return BigInt(Math.trunc(entry.mtimeMs * 1_000_000));
}

function removeIfPresent(root: BeneathRoot, path: string): void {
  try {
    root.unlink(path);
  } catch (error) {
    if (!(error instanceof BeneathError) || error.errno !== 2) throw error;
  }
}

/**
 * Replay the pending journal into the upper and report the cursor it read.
 *
 * THE CURSOR IS RETURNED BECAUSE IT WAS ALREADY PAID FOR. `replayPending` GETs
 * `cursor.json` to know where pending begins, and a caller that has to classify
 * the store — never folded and nothing pending, versus a real store whose
 * pending set happens to be empty — would otherwise answer by LISTing the
 * prefix. That listing is the tree-size term this strategy exists to not have.
 */
async function materializePending(
  root: BeneathRoot,
  store: CasStore,
): Promise<{ readonly entries: number; readonly foldedSeq: number }> {
  const pending = await replayPending(store);
  const entries = [...pending.pending].sort(byApplyOrder);
  // THE BLOBS OF ONE REPLAY ARE FETCHED TOGETHER, AND THE TREE STILL APPLIES
  // IN ORDER.
  //
  // MEASURED. After the deployed 25-minute checkpoint missed its deadline in
  // run 20260903140046, every later segment was answered `a restoration has
  // been running in the request for N ms` until the runner died on
  // `GET cursor.json: HTTP 530`. The 530 is the platform's store read path,
  // which is not this file's to fix — but the replay that spun until it
  // happened is: this fetched one blob per await, so a wake after a large tick
  // cost latency times blob count. The reads are independent
  // (content-addressed keys, verified by digest on arrival), so they overlap;
  // the APPLICATION below stays in `byApplyOrder`, because parents before
  // children and deletes last is what makes a replayed tree correct.
  const wanted = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind !== 'file') continue;
    for (const part of entry.parts) {
      if (part.kind === 'data') wanted.set(part.hash, blobKey(part.hash));
    }
  }
  const fetched = new Map<string, Uint8Array>();
  await throughStorePool([...wanted], async ([hash, key]) => {
    const bytes = await store.get(key);
    if (bytes === null) throw new Error(`blob missing: ${hash}`);
    fetched.set(hash, bytes);
  }, ([, key]) => key);
  for (const entry of entries) {
    const parent = parentDirectory(entry.path);
    if (parent !== null) root.mkdir(parent);
    switch (entry.kind) {
      case 'dir':
        root.mkdir(entry.path, entry.mode & 0o7777);
        root.chmod(entry.path, entry.mode & 0o7777);
        root.utimens(entry.path, mtimeNs(entry), mtimeNs(entry));
        break;
      case 'file': {
        removeIfPresent(root, entry.path);
        closeSync(root.createFile(entry.path, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC, entry.mode & 0o7777));
        let offset = 0;
        for (const part of entry.parts) {
          if (part.kind === 'data') {
            const bytes = fetched.get(part.hash);
            if (bytes === undefined) throw new Error(`blob missing for ${entry.path}: ${part.hash}`);
            root.writeRange(entry.path, offset, bytes);
          }
          offset += part.size;
        }
        root.truncate(entry.path, entry.size);
        root.chmod(entry.path, entry.mode & 0o7777);
        root.utimens(entry.path, mtimeNs(entry), mtimeNs(entry));
        break;
      }
      case 'hardlink':
        removeIfPresent(root, entry.path);
        root.hardlink(entry.target, entry.path);
        root.chmod(entry.path, entry.mode & 0o7777);
        root.utimens(entry.path, mtimeNs(entry), mtimeNs(entry));
        break;
      case 'symlink':
        removeIfPresent(root, entry.path);
        root.symlink(entry.target, entry.path);
        root.utimens(entry.path, mtimeNs(entry), mtimeNs(entry));
        break;
      case 'delete': {
        removeIfPresent(root, entry.path);
        const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
        const marker = parent === null ? `${WHITEOUT_PREFIX}${name}` : `${parent}/${WHITEOUT_PREFIX}${name}`;
        closeSync(root.createFile(marker, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC, 0o600));
        break;
      }
    }
  }
  return { entries: entries.length, foldedSeq: pending.foldedSeq };
}


/**
 * One run: what to do, the upper to do it against, and the OPEN store to do it
 * through.
 *
 * `store` is an open `CasStore` rather than the `--store` endpoint, because
 * `movedBytes` below is defined as a delta on its counters. A caller holding
 * the instance can read the whole bill — which keys were fetched, how many
 * listings were paid for, what was written — and check the receipt against it.
 * A runner that opened its own store from an endpoint would make that claim
 * unobservable from outside the process, which is how the attach cost went
 * unmeasured long enough to grow a prefix inventory. `cliRequest` is the one
 * place an endpoint becomes a store.
 */
export type OverlayRunnerRequest = {
  readonly operation: 'checkpoint' | 'fold' | 'restore';
  readonly upper: string;
  readonly store: CasStore;
  /** Where a phase breakdown goes, when one was asked for. Absent in every
   *  production invocation: the DO reads a receipt, not a profile. */
  readonly profile?: ProfileSink;
};

/**
 * Everything the Durable Object learns about a run.
 *
 * Six counters, no signatures: the scan cache lives in the store beside the
 * bytes it describes, so the receipt carries only what the caller acts on —
 * whether anything changed, what it moved, what a fold consumed, what the reap
 * took back, and where the durable cursor now stands.
 *
 * `movedBytes` IS A MEASUREMENT, NOT A SUM OF ENTRY SIZES. It used to be the
 * logical size of every journalled file, which is neither what a commit writes
 * nor a quantity a caller can check against the store: a rename journals a
 * whole file and uploads no content, so the old figure billed bytes that never
 * moved, while the journal batch, the tree writes, the manifest and the cursor
 * — all real objects — were billed to nobody. This is the store's own
 * `bytesPut` delta across the operation: the bytes this run WROTE. Not net
 * growth — an overwrite replaces bytes and the reap removes them, so the prefix
 * can shrink through a run that moved plenty.
 *
 * `foldedSeq` is the durable cursor as this run left it: unchanged by a tick,
 * advanced by a fold, and merely READ by a restore. It is what makes a fresh
 * store distinguishable from a folded one without a prefix listing.
 */
export type OverlayRunnerReceipt = {
  readonly operation: 'checkpoint' | 'fold' | 'restore';
  readonly entries: number;
  readonly movedBytes: number;
  readonly foldedEntries: number;
  readonly sweptBlobs: number;
  readonly foldedSeq: number;
};

/** Run the CAS mutation beside the mounted prefix; the DO receives only the receipt. */
export async function runOverlayRunner(request: OverlayRunnerRequest): Promise<OverlayRunnerReceipt> {
  const { operation, upper, store, profile } = request;
  const phase = profiler(store, profile);
  const openedBytesPut = store.counters.bytesPut;
  if (operation === 'restore') {
    const root = new BeneathRoot(upper);
    try {
      const replayed = await phase('restore/replay', async () => await materializePending(root, store),
        value => ({ entries: value.entries, foldedSeq: value.foldedSeq }));
      return {
        operation: 'restore',
        entries: replayed.entries,
        movedBytes: store.counters.bytesPut - openedBytesPut,
        foldedEntries: 0,
        sweptBlobs: 0,
        foldedSeq: replayed.foldedSeq,
      };
    } finally {
      root.close();
    }
  }
  const previous = await phase('tick/read-scan-cache', async () => await readScanCache(store),
    value => ({ rows: value.size }));
  const scan = await phase('tick/scan-upper', async () => await scanUpper(upper, previous, profile),
    value => ({ entries: value.entries.length, signatures: value.signatures.size }));
  const pendingState = new PendingJournalState();
  await phase('tick/load-pending', async () => { await pendingState.load(store); },
    () => ({ foldedSeq: pendingState.foldedSeq() }));
  const changed = pendingState.filterChanged(scan.entries);
  const staged = await phase('tick/stage-blobs', async () => await stageBlobs({
    store,
    entries: stampEntries(changed, pendingState.sequence()),
    known: pendingState.blobHashes(),
    readChunk: async (entry, index, size) => {
      const root = new BeneathRoot(upper);
      try {
        let offset = 0;
        let dataIndex = 0;
        for (const part of entry.parts) {
          if (part.kind === 'data' && dataIndex++ === index) return root.readRange(entry.path, offset, size);
          offset += part.size;
        }
        return null;
      } catch (error) {
        if (error instanceof BeneathError && error.errno === 2) return null;
        throw error;
      } finally {
        root.close();
      }
    },
    commitBatch: async batch => await appendJournalBatch(store, batch),
  }), value => ({ staged: value.staged.length }));
  pendingState.record(staged.staged);
  const journalled = new Set(staged.staged.map(entry => entry.path));
  // THE CACHE IS WRITTEN ONLY WHEN A ROW CHANGED, and an idle tick therefore
  // writes NOTHING AT ALL. This object carries one row per path in the upper,
  // so an npm-shaped workspace makes it the largest thing a tick touches — and
  // it used to be rewritten unconditionally, so a box sitting idle paid a PUT
  // proportional to its own size every interval, forever, to store bytes
  // identical to the ones already there. The receipt then said `entries: 0`
  // while the prefix had grown, and the adapter turned that into a skip
  // claiming nothing moved.
  //
  // The condition is the ROW SET, not a count of entries, and that is the whole
  // correction: counting said "write whenever staging took fewer entries than
  // the scan measured", which is permanently true for an upper holding one
  // whiteout or one opaque directory, because `scanUpper` re-emits both on
  // every pass and `filterChanged` drops both every time. `nextScanCache`
  // answers what the count was standing in for — see the rule there.
  const cache = nextScanCache(
    previous,
    scan.signatures,
    new Set(changed.map(entry => entry.path).filter(path => !journalled.has(path))),
    new Set(staged.staged.filter(entry => entry.kind === 'delete').map(entry => entry.path)),
  );
  if (cache.changed) {
    await phase('tick/write-scan-cache', async () => {
      await store.put(KEY_SCAN, encodeJson({
        version: CAS_FORMAT_VERSION,
        signatures: Object.fromEntries(cache.signatures),
      }));
    });
  }
  let folded = { foldedEntries: 0, sweptBlobs: 0, foldedSeq: pendingState.foldedSeq() };
  if (operation === 'fold') {
    const result = await phase('fold/journal-into-tree', async () => await foldJournalIntoTree(store),
      value => ({ foldedEntries: value.foldedEntries, treeWrites: value.treeWrites, treeDeletes: value.treeDeletes }));
    // THE REAP COMES AFTER THE CURSOR, never before: a blob deleted while a
    // journal entry still names it is a blob the next replay would be asked
    // for, so the sweep runs on the state the fold left behind.
    const swept = await phase('fold/sweep-orphan-blobs', async () => await sweepOrphanBlobs(store),
      value => ({ deleted: value.deleted }));
    folded = {
      foldedEntries: result.foldedEntries,
      sweptBlobs: swept.deleted,
      foldedSeq: result.cursorAfter,
    };
  }
  return {
    operation,
    entries: staged.staged.length,
    // LAST, because every write above is inside the delta: the chunk blobs, the
    // journal batch objects, the scan cache, and — on a fold — the tree writes,
    // the manifest and the cursor.
    movedBytes: store.counters.bytesPut - openedBytesPut,
    ...folded,
  };
}

/** The CLI's argv, with `--store URL` opened into the store the run measures
 *  itself against. This is the one place an endpoint becomes a store.
 *
 *  `--profile stderr` asks for the phase breakdown. It goes to STDERR because
 *  stdout carries the receipt and exactly one line of it, and a diagnostic that
 *  moved the receipt would change the contract it exists to explain. */
function cliRequest(argv: readonly string[]): OverlayRunnerRequest {
  const values = new Map<string, string>();
  for (let at = 0; at < argv.length; at += 2) {
    const key = argv[at];
    const value = argv[at + 1];
    if (key === undefined || value === undefined || !key.startsWith('--')) {
      throw new Error('usage: overlay-cas-runner --operation checkpoint|fold|restore --upper PATH --store URL');
    }
    values.set(key.slice(2), value);
  }
  const operation = values.get('operation');
  const upper = values.get('upper');
  const store = values.get('store');
  if ((operation !== 'checkpoint' && operation !== 'fold' && operation !== 'restore')
    || upper === undefined || store === undefined) {
    throw new Error('usage: overlay-cas-runner --operation checkpoint|fold|restore --upper PATH --store URL');
  }
  const request: OverlayRunnerRequest = { operation, upper, store: new HttpCasStore(store) };
  if (values.get('profile') !== 'stderr') return request;
  return {
    ...request,
    profile: row => { process.stderr.write(`[profile] ${JSON.stringify(row)}\n`); },
  };
}

if (import.meta.main) {
  const receipt = await runOverlayRunner(cliRequest(Bun.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
