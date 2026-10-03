// The store as the image's publisher reaches it, served inside the test's own container: the
// publish route stores objects where the store mount shows them, the directory given as its argument.
// Bundled and started by `tests/disk-chain-image.test.ts`; it runs nowhere else.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

const UPLOADS = '/var/tmp/store-box/uploads';

const MOUNT = process.argv[2] ?? '';

const md5 = (bytes: Uint8Array): Buffer => createHash('md5').update(bytes).digest();

const md5Hex = (bytes: Uint8Array): string => createHash('md5').update(bytes).digest('hex');

/** An object becomes visible whole, as an R2 PUT or a completed multipart upload does; its etag is R2's:
 *  the bytes' MD5, or for parts the MD5 of the parts' MD5s and their count. */
function complete(target: string, bytes: Uint8Array, etag: string): void {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(`${target}.part`, bytes);
  renameSync(`${target}.part`, target);
  writeFileSync(`${target}.etag`, etag);
}

/** The publisher's requests (devbox-publish-v2): PUT, multipart create, part, complete and abort, HEAD. */
async function store(request: Request, url: URL): Promise<Response> {
  const target = join(MOUNT, ...url.pathname.split('/').slice(2).map(decodeURIComponent));
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
  mkdirSync(UPLOADS, { recursive: true });

  Bun.serve({
    hostname: '127.0.0.1',
    port: 80,
    fetch: async (request) => {
      const url = new URL(request.url);

      return url.pathname === '/ready' ? new Response('ready') : await store(request, url);
    },
  });
}
