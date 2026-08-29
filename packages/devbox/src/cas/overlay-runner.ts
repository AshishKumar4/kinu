import * as v from 'valibot';

import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readlink,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { closeSync, constants as FS, createWriteStream } from 'node:fs';
import type { Stats } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join, relative, sep } from 'node:path';

import { BeneathError, BeneathRoot } from '../native-openat2';
import { describeThrown } from '../lifecycle';

import {
  CAS_FORMAT_VERSION,
  CHUNK_SIZE,
  appendJournalBatch,
  emptyCounters,
  encodeJson,
  foldJournalIntoTree,
  replayPending,
  stageBlobs,
  stampEntries,
  sweepOrphanBlobs,
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
 * Exported because the rule is reached only when staging refuses a file that
 * changed under it, which no caller can arrange from outside this process.
 */
export function nextScanCache(
  previous: ReadonlyMap<string, UpperSignature>,
  scanned: ReadonlyMap<string, UpperSignature>,
  unjournalled: ReadonlySet<string>,
  tombstoned: ReadonlySet<string>,
): ReadonlyMap<string, UpperSignature> {
  const next = new Map(previous);
  for (const [path, signature] of scanned) {
    if (unjournalled.has(path)) continue;
    next.set(path, signature);
  }
  for (const path of tombstoned) next.delete(path);
  return next;
}

function safeKey(key: string): string {
  if (key.length === 0 || key.startsWith('/') || key.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`CAS store refused unsafe key: ${key}`);
  }
  return key;
}

function modeBits(mode: number): number {
  return mode & 0o7777;
}

/**
 * A web `ReadableStream` as a Node async iterable, one chunk at a time.
 *
 * `Readable.fromWeb` cannot take this stream, and the reason is a real one
 * rather than a types quirk to paper over: this file is compiled by TWO
 * programs — this package's own, and `packages/cf-backend`, which imports the
 * strategy — and they disagree about which `ReadableStream` a port declares.
 * Under cf-backend it is the Workers one, which has no `blob`/`text`/`bytes`/
 * `json`, and `fromWeb` requires node's own web stream type that does
 * (`TS2739` at the call site). A cast would assert a structural claim that is
 * false in one of the two programs. Reading through `getReader`, which both
 * spell identically, makes no claim at all.
 *
 * IT STAYS A STREAM. One chunk is in flight at a time and nothing accumulates,
 * which is the whole reason this path exists: the blobs it writes are as large
 * as the files a workload produced.
 *
 * THE READER IS ALWAYS RELEASED, AND AN ABANDONED PRODUCER IS TOLD. A consumer
 * that stops early — a full disk, a broken pipe, `pipeline` destroying the
 * Readable after a write error — reaches this `finally` through the generator's
 * own `return`, so the producer is cancelled instead of waiting on a reader
 * nobody will read again.
 */
async function* webStreamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let drained = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        drained = true;
        return;
      }
      if (value !== undefined) yield value;
    }
  } finally {
    // Nothing to cancel on a stream that ended by itself. On one this consumer
    // walked away from, cancel is the only thing that releases the producer —
    // and its own rejection must not replace the failure already in flight.
    if (!drained) {
      try {
        await reader.cancel();
      } catch (cause) {
        // RECORDED, NOT RETHROWN. The caller's error is the answer, so this one
        console.error(
          '[devbox] a reader this consumer walked away from did not cancel: '
          + describeThrown({ cause }),
        );
      }
    }
    reader.releaseLock();
  }
}

/** A CAS store backed by the container's RW R2 mount.
 *
 * It retains the object key layout and counter semantics of the R2 adapter.
 * chmod/mtime are deliberately applied after the atomic rename so s3fs can
 * translate them into the metadata read by the lower mount. */
export class FileCasStore implements CasStore {
  readonly counters: StoreCounters = emptyCounters();

  constructor(readonly root: string) {}

  #path(key: string): string {
    return join(this.root, safeKey(key));
  }

  async put(key: string, bytes: Uint8Array, meta?: CasPutMeta): Promise<void> {
    this.counters.putCalls += 1;
    this.counters.bytesPut += bytes.byteLength;
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    if (meta?.symlink === true) {
      const temporary = `${path}.tmp-${crypto.randomUUID()}`;
      await symlink(new TextDecoder().decode(bytes), temporary);
      await rename(temporary, path);
      return;
    }
    const temporary = `${path}.tmp-${crypto.randomUUID()}`;
    await writeFile(temporary, bytes);
    await rename(temporary, path);
    await this.#applyMeta(path, meta);
  }

  async putStream(
    key: string,
    stream: ReadableStream<Uint8Array>,
    size: number,
    meta?: CasPutMeta,
  ): Promise<void> {
    if (meta?.symlink === true) {
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      if (bytes.byteLength !== size) throw new Error(`${key} streamed ${bytes.byteLength} bytes, expected ${size}`);
      await this.put(key, bytes, meta);
      return;
    }
    this.counters.putCalls += 1;
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${crypto.randomUUID()}`;
    let landed: number;
    try {
      await pipeline(Readable.from(webStreamChunks(stream)), createWriteStream(temporary));
      landed = Number((await stat(temporary)).size);
      // THE SIZE IS THE ORACLE. The caller measured these bytes before the
      // stream was read, and a short read is how a file still settling gets
      // published as a complete blob.
      if (landed !== size) throw new Error(`${key} streamed ${landed} bytes, expected ${size}`);
    } catch (error) {
      // NO PARTIAL FILE OUTLIVES A FAILED PUT, and the rename below is why: it
      // is what publishes, so a temp left behind corrupts nothing — it is bytes
      // under this box's prefix that no key names, and a `.tmp-<uuid>` name is
      // one no sweep can recognise, so the leak would be permanent. The stream
      // failing mid-flight and the size disagreeing are one exit for that
      // reason.
      try {
        await rm(temporary, { force: true });
      } catch (cause) {
        // RECORDED, NOT RETHROWN. The put's own error is the answer. This one
        // says a `.tmp-<uuid>` file no key names was left under the prefix, and
        // no sweep can recognise that name, so the leak is permanent and silence
        // about it is the worst outcome.
        console.error(
          `[devbox] a failed put left ${temporary} behind: `
          + describeThrown({ cause }),
        );
      }
      throw error;
    }
    await rename(temporary, path);
    await this.#applyMeta(path, meta);
    this.counters.bytesPut += landed;
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.counters.getCalls += 1;
    try {
      const file = Bun.file(this.#path(key));
      if (!(await file.exists())) return null;
      const bytes = new Uint8Array(await file.arrayBuffer());
      this.counters.bytesGot += bytes.byteLength;
      return bytes;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async head(key: string): Promise<{ size: number } | null> {
    this.counters.headCalls += 1;
    try {
      return { size: Number((await lstat(this.#path(key))).size) };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    this.counters.deleteCalls += 1;
    await rm(this.#path(key), { force: true, recursive: true });
  }

  async list(prefix: string): Promise<string[]> {
    this.counters.listCalls += 1;
    const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    const base = join(this.root, safeKey(normalized));
    try {
      const found: string[] = [];
      for await (const entry of walk(base)) {
        if ((await lstat(entry)).isDirectory()) continue;
        const key = relative(this.root, entry).split(sep).join('/');
        if (key.startsWith(prefix)) found.push(key);
      }
      return found.sort();
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async #applyMeta(path: string, meta?: CasPutMeta): Promise<void> {
    if (meta === undefined) return;
    await chmod(path, modeBits(meta.mode));
    if (meta.mtimeMs !== undefined) {
      const time = new Date(meta.mtimeMs);
      await utimes(path, time, time);
    }
  }
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
): Promise<{ entries: readonly NewJournalEntry[]; signatures: ReadonlyMap<string, UpperSignature> }> {
  const records: { path: string; absolute: string; stat: Stats }[] = [];
  const files: typeof records = [];
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

async function materializePending(root: BeneathRoot, store: CasStore): Promise<number> {
  const pending = await replayPending(store);
  const entries = [...pending.pending].sort(byApplyOrder);
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
            const bytes = await store.get(`blobs/${part.hash.slice(0, 2)}/${part.hash}`);
            if (bytes === null) throw new Error(`blob missing for ${entry.path}: ${part.hash}`);
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
  return entries.length;
}


export type OverlayRunnerRequest = {
  readonly operation: 'checkpoint' | 'fold' | 'restore';
  readonly upper: string;
  readonly store: string;
};

/**
 * Everything the Durable Object learns about a run.
 *
 * Five counters, no signatures: the scan cache lives in the store beside the
 * bytes it describes, so the receipt carries only what the caller acts on —
 * whether anything changed, what it moved, what a fold consumed and what the
 * reap took back.
 */
export type OverlayRunnerReceipt = {
  readonly operation: 'checkpoint' | 'fold' | 'restore';
  readonly entries: number;
  readonly stagedBytes: number;
  readonly foldedEntries: number;
  readonly sweptBlobs: number;
};

/** Run the CAS mutation beside the mounted R2 prefix; the DO receives only the receipt. */
export async function runOverlayRunner(request: OverlayRunnerRequest): Promise<OverlayRunnerReceipt> {
  const store = new FileCasStore(request.store);
  if (request.operation === 'restore') {
    const root = new BeneathRoot(request.upper);
    try {
      const entries = await materializePending(root, store);
      return { operation: 'restore', entries, stagedBytes: 0, foldedEntries: 0, sweptBlobs: 0 };
    } finally {
      root.close();
    }
  }
  const previous = await readScanCache(store);
  const scan = await scanUpper(request.upper, previous);
  const pendingState = new PendingJournalState();
  await pendingState.load(store);
  const changed = pendingState.filterChanged(scan.entries);
  const staged = await stageBlobs({
    store,
    entries: stampEntries(changed, pendingState.sequence()),
    known: pendingState.blobHashes(),
    readChunk: async (entry, index, size) => {
      const root = new BeneathRoot(request.upper);
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
  });
  pendingState.record(staged.staged);
  const journalled = new Set(staged.staged.map(entry => entry.path));
  await store.put(KEY_SCAN, encodeJson({
    version: CAS_FORMAT_VERSION,
    signatures: Object.fromEntries(nextScanCache(
      previous,
      scan.signatures,
      new Set(changed.map(entry => entry.path).filter(path => !journalled.has(path))),
      new Set(staged.staged.filter(entry => entry.kind === 'delete').map(entry => entry.path)),
    )),
  }));
  let folded = { foldedEntries: 0, sweptBlobs: 0 };
  if (request.operation === 'fold') {
    const result = await foldJournalIntoTree(store);
    // THE REAP COMES AFTER THE CURSOR, never before: a blob deleted while a
    // journal entry still names it is a blob the next replay would be asked
    // for, so the sweep runs on the state the fold left behind.
    const swept = await sweepOrphanBlobs(store);
    folded = { foldedEntries: result.foldedEntries, sweptBlobs: swept.deleted };
  }
  return {
    operation: request.operation,
    entries: staged.staged.length,
    stagedBytes: staged.staged.reduce((sum, entry) => sum + (entry.kind === 'file' ? entry.size : 0), 0),
    ...folded,
  };
}

function cliRequest(argv: readonly string[]): OverlayRunnerRequest {
  const values = new Map<string, string>();
  for (let at = 0; at < argv.length; at += 2) {
    const key = argv[at];
    const value = argv[at + 1];
    if (key === undefined || value === undefined || !key.startsWith('--')) {
      throw new Error('usage: overlay-cas-runner --operation checkpoint|fold --upper PATH --store PATH');
    }
    values.set(key.slice(2), value);
  }
  const operation = values.get('operation');
  const upper = values.get('upper');
  const store = values.get('store');
  if ((operation !== 'checkpoint' && operation !== 'fold' && operation !== 'restore')
    || upper === undefined || store === undefined) {
    throw new Error('usage: overlay-cas-runner --operation checkpoint|fold|restore --upper PATH --store PATH');
  }
  return { operation, upper, store };
}

if (import.meta.main) {
  const receipt = await runOverlayRunner(cliRequest(Bun.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
