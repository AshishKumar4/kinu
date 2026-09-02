// Measuring what a CAS operation costs.
//
// THE BILL IS THE CLAIM. The overlay-cas headline is that recovery costs
// O(pending change) and that an unchanged attach costs a fixed few operations,
// and neither is observable from an end state: a store looks identical whether
// attach listed its whole prefix or read one object. So the tests need the
// trace — which keys were fetched, how many listings were paid for, what was
// written, in what order — and a prefix large enough that a listing would show.
//
// Shared because three suites assert against the same numbers: the CAS helper
// tests, the runner tests that measure the operation, and the
// durability-contract tests that state the result in the readiness dimensions
// that contract declares.

import { createHash } from 'node:crypto';
import type { Server } from 'bun';

import {
  PREFIX_BLOBS,
  PREFIX_JOURNAL,
  PREFIX_TREE,
  KEY_CURSOR,
  advanceCursor,
  blobKey,
  emptyCounters,
  type CasPutMeta,
  type CasStore,
  type StoreCounters,
} from '../../src/cas';

/** The store as the CAS helpers see it, in memory, with the order of every
 *  mutation written down: the crash-ordering assertions read `writes`, because
 *  an end-state check cannot tell a safe order from an unsafe one. */
export class MemoryCasStore implements CasStore {
  readonly counters: StoreCounters = emptyCounters();
  readonly objects = new Map<string, Uint8Array>();
  readonly meta = new Map<string, CasPutMeta>();
  readonly writes: string[] = [];
  /** When set, a blob GET outside `putStream` throws: the replay must hand
   *  back a lazy stream, never read blobs eagerly. */
  requireBlobGetsInsideStream = false;
  private insidePutStream = false;

  async put(key: string, bytes: Uint8Array, meta?: CasPutMeta): Promise<void> {
    this.counters.putCalls += 1;
    this.counters.bytesPut += bytes.byteLength;
    this.writes.push(`put:${key}`);
    this.objects.set(key, bytes);
    if (meta !== undefined) this.meta.set(key, meta);
  }

  async putStream(
    key: string,
    stream: ReadableStream<Uint8Array>,
    size: number,
    meta?: CasPutMeta,
  ): Promise<void> {
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    this.insidePutStream = true;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        total += value.byteLength;
      }
    } finally {
      this.insidePutStream = false;
      reader.releaseLock();
    }
    if (total !== size) throw new Error(`${key} streamed ${total} bytes, declared ${size}`);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    await this.put(key, bytes, meta);
  }

  async get(key: string): Promise<Uint8Array | null> {
    if (this.requireBlobGetsInsideStream && key.startsWith(PREFIX_BLOBS) && !this.insidePutStream) {
      throw new Error(`eager blob read outside putStream: ${key}`);
    }
    const value = this.objects.get(key);
    this.counters.getCalls += 1;
    if (value === undefined) return null;
    this.counters.bytesGot += value.byteLength;
    return value;
  }

  async delete(key: string): Promise<void> {
    this.counters.deleteCalls += 1;
    this.writes.push(`delete:${key}`);
    this.objects.delete(key);
    this.meta.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    this.counters.listCalls += 1;
    return [...this.objects.keys()].filter(key => key.startsWith(prefix)).sort();
  }
}

/** One store call. `bytes` is the payload it carried — what a get returned or a
 *  put wrote. A LIST records zero, because a listing's cost is the call and the
 *  keys it names, and letting it contribute to a byte sum would make every
 *  metadata-bytes assertion mean two things at once. */
export interface StoreCall {
  readonly op: 'get' | 'put' | 'delete' | 'list';
  readonly key: string;
  readonly bytes: number;
}

/** Bytes of file CONTENT, as opposed to the cursor, the journal, the manifest
 *  and the scan cache. The distinction is the whole point of a byte assertion
 *  about attach: a fresh attach reads its cursor, so a single total can never
 *  show that it materialized nothing. */
export function isPayloadKey(key: string): boolean {
  return key.startsWith(PREFIX_BLOBS) || key.startsWith(PREFIX_TREE);
}

/** A store that also writes down what it was asked for. It WRAPS rather than
 *  extends, so a store whose `putStream` delegates to `put` cannot record one
 *  write twice and quietly inflate every byte assertion built on this. */
export class WatchedCasStore implements CasStore {
  readonly calls: StoreCall[] = [];

  constructor(private readonly inner: CasStore) {}

  get counters(): StoreCounters {
    return this.inner.counters;
  }

  /** Every call, as `op key`, for order assertions. */
  trace(): readonly string[] {
    return this.calls.map(call => `${call.op} ${call.key}`);
  }

  keys(op: StoreCall['op']): readonly string[] {
    return this.calls.filter(call => call.op === op).map(call => call.key);
  }

  /** Content bytes only, so a cursor read does not read as materialization. */
  payloadBytes(op: StoreCall['op']): number {
    return this.calls
      .filter(call => call.op === op && isPayloadKey(call.key))
      .reduce((sum, call) => sum + call.bytes, 0);
  }

  bytes(op: StoreCall['op']): number {
    return this.calls.filter(call => call.op === op).reduce((sum, call) => sum + call.bytes, 0);
  }

  async put(key: string, bytes: Uint8Array, meta?: CasPutMeta): Promise<void> {
    await this.inner.put(key, bytes, meta);
    this.calls.push({ op: 'put', key, bytes: bytes.byteLength });
  }

  async putStream(
    key: string,
    stream: ReadableStream<Uint8Array>,
    size: number,
    meta?: CasPutMeta,
  ): Promise<void> {
    await this.inner.putStream(key, stream, size, meta);
    // The declared size, which `putStream` has already refused to disagree with.
    this.calls.push({ op: 'put', key, bytes: size });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const bytes = await this.inner.get(key);
    this.calls.push({ op: 'get', key, bytes: bytes?.byteLength ?? 0 });
    return bytes;
  }

  async delete(key: string): Promise<void> {
    await this.inner.delete(key);
    this.calls.push({ op: 'delete', key, bytes: 0 });
  }

  async list(prefix: string): Promise<string[]> {
    const keys = await this.inner.list(prefix);
    this.calls.push({ op: 'list', key: prefix, bytes: 0 });
    return keys;
  }
}

/** The trace an unchanged or fresh attach is allowed to produce: read the
 *  cursor, list the journal, and stop. Stated once, because two suites assert
 *  against it and a second copy would let one of them drift. */
export const FIXED_ATTACH_TRACE: readonly string[] = [
  `get ${KEY_CURSOR}`,
  `list ${PREFIX_JOURNAL}`,
];

/**
 * A store whose `tree/` and `blobs/` hold `count` objects, with a cursor at
 * `foldedSeq` and an EMPTY journal — the state a mature box spends its life in.
 *
 * `count` and `foldedSeq` are separate arguments so a caller can vary the tree
 * while holding the cursor fixed. They are the two things that could make an
 * attach's bytes move, and only one of them is supposed to be able to:
 * `foldedSeq` is written as a decimal, so a larger one really is a longer
 * `cursor.json`, in the log of the sequence rather than the size of the tree.
 *
 * No manifest, deliberately: attach never reads one, and a trace assertion
 * catches a read of an absent key just as loudly as a present one. A fixture
 * that built a manifest would be paying checkpoint-path costs to make a point
 * about the attach path.
 */
export async function treeHeavyStore(
  store: CasStore,
  count: number,
  foldedSeq: number,
): Promise<void> {
  for (let at = 0; at < count; at += 1) {
    const body = `object-${at}-body`;
    const bytes = new TextEncoder().encode(body);
    await store.put(`tree/dir-${at % 16}/file-${at}.txt`, bytes, { mode: 0o100644 });
    await store.put(blobKey(createHash('sha256').update(body).digest('hex')), bytes);
  }
  // Through the shipped writer, so the fixture cannot drift from the format the
  // cursor reader refuses. NOT WRITTEN AT ZERO: only a fold advances the cursor
  // and a fold always advances past at least one batch, so a store nothing has
  // folded holds no cursor object at all. Writing one would make every "fresh
  // prefix" fixture pay a control read the real fresh prefix does not have.
  if (foldedSeq > 0) await advanceCursor(store, foldedSeq);
}

/** What the egress fake holds under one key. */
export interface EgressObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/**
 * The SDK's `r2.internal` egress endpoint, in-process: the wire the runner's
 * store talks to, answered the way `r2EgressHandler` answers it. A PUT needs
 * a Content-Length it then holds the body to; the reply is `200` with R2's
 * ETag, the quoted MD5 of the body. GET is `200`/`404`, DELETE is `204`, and a
 * GET with no key lists as ListObjectsV2 XML, paged at `pageSize` so the
 * continuation loop is exercised without a thousand objects.
 *
 * `requests` is the bill: one row per HTTP request, `METHOD /path`, which is
 * what a test counting store operations per object asserts on.
 */
export class EgressFake {
  readonly objects = new Map<string, EgressObject>();
  readonly requests: string[] = [];
  /** What the next PUT answers instead of the truth, when a test wants a
   *  receipt that lies. Consumed by that PUT. */
  forgedEtag: string | undefined;
  /** The status and body the next request is refused with, the way the
   *  endpoint refuses an unmounted binding. Consumed by that request. */
  refuseNext: { readonly status: number; readonly words: string } | undefined;
  readonly #server: Server<undefined>;

  constructor(private readonly pageSize = 1000) {
    this.#server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async request => await this.#answer(request),
    });
  }

  /** The store's base URL: `http://host:port/<binding>`. */
  get url(): string {
    return `http://127.0.0.1:${String(this.#server.port)}/STORE`;
  }

  async stop(): Promise<void> {
    await this.#server.stop(true);
  }

  async #answer(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.slice('/STORE/'.length);
    this.requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (this.refuseNext !== undefined) {
      const { status, words } = this.refuseNext;
      this.refuseNext = undefined;
      await request.arrayBuffer();
      return new Response(words, { status });
    }
    if (path.length === 0 && request.method === 'GET') return this.#list(url.searchParams);
    switch (request.method) {
      case 'PUT': {
        const declared = Number(request.headers.get('content-length'));
        const body = new Uint8Array(await request.arrayBuffer());
        if (!Number.isSafeInteger(declared) || body.byteLength !== declared) {
          return new Response('Bad Request: body disagrees with Content-Length', { status: 400 });
        }
        this.objects.set(path, {
          bytes: body,
          contentType: request.headers.get('content-type') ?? 'application/octet-stream',
        });
        const etag = this.forgedEtag ?? createHash('md5').update(body).digest('hex');
        this.forgedEtag = undefined;
        return new Response(null, { status: 200, headers: { ETag: `"${etag}"` } });
      }
      case 'GET': {
        const held = this.objects.get(path);
        if (held === undefined) return new Response(null, { status: 404 });
        return new Response(held.bytes, {
          status: 200, headers: { ETag: `"${createHash('md5').update(held.bytes).digest('hex')}"` },
        });
      }
      case 'HEAD':
        return new Response(null, { status: this.objects.has(path) ? 200 : 404 });
      case 'DELETE':
        this.objects.delete(path);
        return new Response(null, { status: 204 });
      default:
        return new Response('Method Not Allowed', { status: 405 });
    }
  }

  #list(query: URLSearchParams): Response {
    const prefix = query.get('prefix') ?? '';
    const from = Number(query.get('continuation-token') ?? '0');
    const keys = [...this.objects.keys()].filter(key => key.startsWith(prefix)).sort();
    const page = keys.slice(from, from + this.pageSize);
    const truncated = from + this.pageSize < keys.length;
    const escape = (text: string): string =>
      text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n`
      + `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>STORE</Name>`
      + `<Prefix>${escape(prefix)}</Prefix><KeyCount>${String(page.length)}</KeyCount>`
      + `<MaxKeys>${String(this.pageSize)}</MaxKeys><IsTruncated>${String(truncated)}</IsTruncated>`
      + (truncated ? `<NextContinuationToken>${String(from + this.pageSize)}</NextContinuationToken>` : '')
      + page.map(key => `<Contents><Key>${escape(key)}</Key><LastModified>2026-09-02T00:00:00.000Z</LastModified>`
        + `<ETag>&quot;x&quot;</ETag><Size>${String(this.objects.get(key)!.bytes.byteLength)}</Size>`
        + `<StorageClass>STANDARD</StorageClass></Contents>`).join('')
      + '</ListBucketResult>';
    return new Response(xml, { status: 200, headers: { 'Content-Type': 'application/xml' } });
  }
}
