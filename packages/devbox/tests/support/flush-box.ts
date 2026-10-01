// The box and the store as the image's `sync.js` reaches them, served inside the test's own container:
// `devbox.internal` answers the sync protocol with the shipped `serveSync` over a record kept in a
// file, and the publish route stores objects where the store mount shows them (`/backups/<key>`).
// Bundled and started by `tests/concurrent-flush-image.test.ts`; it runs nowhere else.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync, readdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { chainAdvanced } from '../../src/errors';
import { CHAIN_STORE_MOUNT, normalizeChainState, type ChainState } from '../../src/snapshot-chain';
import { serveSync, DEVBOX_SYNC_HOST, type BoxSyncPorts } from '../../src/sync';

const FLUSH_BOX_DIR = '/var/tmp/flush-box';

/** While this file exists, every object the store completes has its last 8 KiB zeroed, where
 *  mksquashfs writes the tables a mount reads: the bytes a torn publication leaves. */
export const FLUSH_BOX_CORRUPT = `${FLUSH_BOX_DIR}/corrupt`;

export const FLUSH_BOX_PUBLISHED = `${FLUSH_BOX_DIR}/published.log`;

export const FLUSH_BOX_STATE = `${FLUSH_BOX_DIR}/state.json`;

export const FLUSH_BOX_GENERATION = 'flush-box-boot';

const UPLOADS = `${FLUSH_BOX_DIR}/uploads`;

function storedState(): ChainState | null {
  return existsSync(FLUSH_BOX_STATE) ? normalizeChainState(JSON.parse(readFileSync(FLUSH_BOX_STATE, 'utf8'))) : null;
}

function landed(root: string, key: string): string {
  return join(CHAIN_STORE_MOUNT, key.slice(root.length + 1));
}

function boxPorts(root: string): BoxSyncPorts {
  return {
    storeRoot: () => root,
    readState: () => Promise.resolve(storedState()),
    writeState: (state, expectedRev) => {
      const storedRev = storedState()?.rev ?? null;

      if (storedRev !== expectedRev) return Promise.reject(chainAdvanced(expectedRev, storedRev));
      writeFileSync(FLUSH_BOX_STATE, JSON.stringify(state));

      return Promise.resolve();
    },
    checkChanges: () => Promise.resolve({ status: 'changed', version: 'flush-box' }),
    // The test's container has no s3fs: the store writes where the mount would show each object.
    mountStore: () => Promise.resolve(),
    unmountStore: () => Promise.resolve(),
    objectFacts: (key) => {
      const path = landed(root, key);

      return Promise.resolve(existsSync(path) ? { bytes: statSync(path).size, digest: undefined, objectVersion: undefined } : undefined);
    },
    deleteObjects: (keys) => {
      for (const key of keys) rmSync(landed(root, key), { force: true });

      return Promise.resolve();
    },
  };
}

const md5 = (bytes: Uint8Array): Buffer => createHash('md5').update(bytes).digest();

const md5Hex = (bytes: Uint8Array): string => createHash('md5').update(bytes).digest('hex');

/** An object becomes visible whole, as an R2 PUT or a completed multipart upload does; its etag is R2's:
 *  the bytes' MD5, or for parts the MD5 of the parts' MD5s and their count. */
function complete(target: string, bytes: Uint8Array, etag: string): void {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(`${target}.part`, bytes);

  if (existsSync(FLUSH_BOX_CORRUPT)) {
    const handle = openSync(`${target}.part`, 'r+');
    writeSync(handle, new Uint8Array(Math.min(8192, bytes.byteLength)), 0, Math.min(8192, bytes.byteLength), Math.max(0, bytes.byteLength - 8192));
    closeSync(handle);
  }

  renameSync(`${target}.part`, target);
  writeFileSync(`${target}.etag`, etag);
  appendFileSync(FLUSH_BOX_PUBLISHED, `${target} ${String(bytes.byteLength)}\n`);
}

/** The publisher's requests (devbox-publish-v2): PUT, multipart create, part, complete and abort, HEAD. */
async function store(request: Request, url: URL): Promise<Response> {
  const target = join(CHAIN_STORE_MOUNT, ...url.pathname.split('/').slice(2).map(decodeURIComponent));
  const uploadId = url.searchParams.get('uploadId');

  if (request.method === 'HEAD') {
    return existsSync(target)
      ? new Response(null, { headers: { 'content-length': String(statSync(target).size), etag: `"${readFileSync(`${target}.etag`, 'utf8')}"` } })
      : new Response(null, { status: 404 });
  }

  if (request.method === 'POST' && url.searchParams.has('uploads')) {
    const id = crypto.randomUUID();
    mkdirSync(join(UPLOADS, id), { recursive: true });

    return new Response(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
  }

  if (request.method === 'PUT' && uploadId !== null) {
    const part = url.searchParams.get('partNumber') ?? '';
    const bytes = new Uint8Array(await request.arrayBuffer());
    writeFileSync(join(UPLOADS, uploadId, part.padStart(6, '0')), bytes);

    return new Response(null, { headers: { etag: `"${md5Hex(bytes)}"` } });
  }

  if (request.method === 'POST' && uploadId !== null) {
    const parts = readdirSync(join(UPLOADS, uploadId)).sort().map((part) => readFileSync(join(UPLOADS, uploadId, part)));
    complete(target, Buffer.concat(parts), `${createHash('md5').update(Buffer.concat(parts.map(md5))).digest('hex')}-${String(parts.length)}`);
    rmSync(join(UPLOADS, uploadId), { recursive: true, force: true });

    return new Response(`<CompleteMultipartUploadResult><ETag>"${uploadId}"</ETag></CompleteMultipartUploadResult>`);
  }

  if (request.method === 'DELETE' && uploadId !== null) {
    rmSync(join(UPLOADS, uploadId), { recursive: true, force: true });

    return new Response(null, { status: 204 });
  }

  if (request.method === 'PUT') {
    const bytes = new Uint8Array(await request.arrayBuffer());
    complete(target, bytes, md5Hex(bytes));

    return new Response(null, { headers: { etag: `"${md5Hex(bytes)}"` } });
  }

  return new Response(`unmodelled ${request.method} ${url.pathname}${url.search}`, { status: 501 });
}

if (import.meta.main) {
  const root = process.argv[2] ?? '';
  const ports = boxPorts(root);
  mkdirSync(UPLOADS, { recursive: true });

  Bun.serve({
    hostname: '127.0.0.1',
    port: 80,
    fetch: async (request) => {
      const url = new URL(request.url);

      if (request.headers.get('host') === DEVBOX_SYNC_HOST) {
        if (url.pathname === '/ready') return new Response('ready');
        const answer = await serveSync({ ports, generation: () => Promise.resolve(FLUSH_BOX_GENERATION) }, await request.text());

        return new Response(answer.body, { status: answer.status });
      }

      return await store(request, url);
    },
  });
}
