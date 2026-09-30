/** A store mount's S3 requests, answered from the Worker's own R2 binding: no key pair exists (D41).
 *  S3Mounts runs `s3fs` in the guest with the shim's placeholder password and routes each mount's
 *  host here, as 0.12.9's R2 mount did; the SDK's `S3Gateway` would sign them for R2's S3 API. */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { S3GatewayBinding, S3MountRequest } from '@cloudflare/sandbox';
import { Effect } from 'effect';
import { DevboxError, attempt, attemptSync, settle } from './errors';
import { storeRouteHost } from './snapshot-chain';

export type StoreGatewayProps = Parameters<S3GatewayBinding>[0]['props'];

/** What S3Mounts records for a store. The bucket names the R2 binding the gateway reads; nothing
 *  contacts the endpoint and nothing checks the key pair, which S3Mounts requires to be present. */
export function storeSource(binding: string): S3MountRequest['source'] {
  return {
    type: 's3', endpoint: 'http://r2-binding.devbox.internal/', region: 'auto', bucket: binding,
    credentials: { type: 'static', accessKeyId: 'r2-binding', secretAccessKey: 'r2-binding' },
  };
}

/** One request against one route's bucket. */
interface StoreCall {
  readonly request: Request;
  readonly url: URL;
  readonly bucket: R2Bucket;
  readonly name: string;
}

const NS = 'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"';

const escapeXml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&apos;');

const xml = (body: string, status = 200): Response =>
  new Response('<?xml version="1.0" encoding="UTF-8"?>' + body, { status, headers: { 'content-type': 'application/xml' } });

const s3Error = (status: number, code: string, message: string): Response =>
  xml(`<Error><Code>${code}</Code><Message>${escapeXml(message)}</Message></Error>`, status);

/** A request this store will not serve; a failing store is not one and surfaces as a 500. */
function refused(request: Request, status: number, code: string, message: string): Response {
  console.log(JSON.stringify({ event: 'devbox.store.refused', at: Date.now(), method: request.method, status, code, message }));

  return s3Error(status, code, message);
}

function objectHeaders(stored: R2Object): Headers {
  const headers = new Headers({ etag: stored.httpEtag, 'last-modified': stored.uploaded.toUTCString(), 'accept-ranges': 'bytes' });

  stored.writeHttpMetadata(headers);
  headers.set('content-length', String(stored.size));

  return headers;
}

/** One `bytes=` range, as S3 serves it; any other value is served whole, as S3 does. */
function requestedRange(header: string | null): R2Range | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');

  if (match === null || (match[1] === '' && match[2] === '')) return undefined;

  if (match[1] === '') return { suffix: Number(match[2]) };
  const offset = Number(match[1]);

  return match[2] === '' ? { offset } : { offset, length: Number(match[2]) - offset + 1 };
}

/** R2 needs a streamed body's length, which an intercepted request carries only as a header. */
async function withSizedBody<A>(request: Request, length: number, write: (body: ReadableStream | Uint8Array) => Promise<A>): Promise<A> {
  if (length === 0 || request.body === null) return await write(new Uint8Array(0));
  const { readable, writable } = new FixedLengthStream(length);
  const [written] = await Promise.all([write(readable), request.body.pipeTo(writable)]);

  return written;
}

function serveList({ request, url, bucket, name }: StoreCall, prefix: string): Effect.Effect<Response, DevboxError> {
  return Effect.gen(function* () {
    const query = url.searchParams;
    const v2 = query.get('list-type') === '2';
    const within = query.get('prefix') ?? '';

    if (!within.startsWith(prefix)) return refused(request, 403, 'AccessDenied', 'the listing is outside this store prefix');
    const asked = Number(query.get('max-keys') ?? 1000);

    if (!Number.isSafeInteger(asked) || asked < 1) return refused(request, 400, 'InvalidArgument', 'max-keys must be a positive integer');
    const limit = Math.min(asked, 1000);
    const delimiter = query.get('delimiter') ?? '';
    const cursor = v2 ? query.get('continuation-token') ?? undefined : undefined;
    const after = query.get(v2 ? 'start-after' : 'marker') ?? undefined;

    const listed = yield* attempt('io', () => bucket.list({
      prefix: within, delimiter: delimiter === '' ? undefined : delimiter, limit, cursor, startAfter: cursor === undefined ? after : undefined,
    }), `listing ${within}`);

    const keys = listed.objects.map((o) => `<Contents><Key>${escapeXml(o.key)}</Key><LastModified>${o.uploaded.toISOString()}</LastModified>`
      + `<ETag>${escapeXml(o.httpEtag)}</ETag><Size>${o.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`);

    const prefixes = listed.delimitedPrefixes.map((p) => `<CommonPrefixes><Prefix>${escapeXml(p)}</Prefix></CommonPrefixes>`);
    let next = '';

    if (listed.truncated && v2) next = `<NextContinuationToken>${escapeXml(listed.cursor)}</NextContinuationToken>`;

    if (listed.truncated && !v2) {
      const last = [listed.objects.at(-1)?.key ?? '', listed.delimitedPrefixes.at(-1) ?? ''].sort().at(-1) ?? '';

      next = `<NextMarker>${escapeXml(last)}</NextMarker>`;
    }

    const page = v2 ? `<KeyCount>${keys.length + prefixes.length}</KeyCount>` : `<Marker>${escapeXml(after ?? '')}</Marker>`;

    return xml(`<ListBucketResult ${NS}><Name>${escapeXml(name)}</Name><Prefix>${escapeXml(within)}</Prefix>${page}`
      + `<MaxKeys>${limit}</MaxKeys>${delimiter === '' ? '' : `<Delimiter>${escapeXml(delimiter)}</Delimiter>`}`
      + `<IsTruncated>${String(listed.truncated)}</IsTruncated>${next}${keys.join('')}${prefixes.join('')}</ListBucketResult>`);
  });
}

function serveMultipart({ request, url, bucket, name }: StoreCall, key: string): Effect.Effect<Response, DevboxError> {
  return Effect.gen(function* () {
    const query = url.searchParams;
    const uploadId = query.get('uploadId');
    const partNumber = Number(query.get('partNumber'));

    if (request.method === 'POST' && query.has('uploads') && uploadId === null) {
      const upload = yield* attempt('io', () => bucket.createMultipartUpload(key, { httpMetadata: request.headers }), `opening an upload of ${key}`);

      return xml(`<InitiateMultipartUploadResult ${NS}><Bucket>${escapeXml(name)}</Bucket><Key>${escapeXml(key)}</Key>`
        + `<UploadId>${escapeXml(upload.uploadId)}</UploadId></InitiateMultipartUploadResult>`);
    }

    if (uploadId === null || uploadId === '') return refused(request, 501, 'NotImplemented', `this store serves no ${request.method} ?uploads`);
    const upload = bucket.resumeMultipartUpload(key, uploadId);

    if (request.method === 'PUT' && Number.isSafeInteger(partNumber) && partNumber >= 1) {
      const length = Number(request.headers.get('content-length') ?? Number.NaN);

      if (!Number.isSafeInteger(length) || length < 0) return refused(request, 411, 'MissingContentLength', 'a part needs its content-length');
      const part = yield* attempt('io', () => withSizedBody(request, length, (body) => upload.uploadPart(partNumber, body)), `uploading part ${partNumber} of ${key}`);

      return new Response(null, { headers: { etag: `"${part.etag}"` } });
    }

    if (request.method === 'POST' && !query.has('partNumber')) {
      const text = yield* attempt('invalid-input', () => request.text());
      const parts: R2UploadedPart[] = [];

      for (const [, number, etag = ''] of text.matchAll(/<Part>\s*<PartNumber>(\d+)<\/PartNumber>\s*<ETag>"?([^<"]+)"?<\/ETag>\s*<\/Part>/g)) {
        parts.push({ partNumber: Number(number), etag });
      }

      const done = yield* attempt('io', () => upload.complete(parts), `completing the upload of ${key}`);

      return xml(`<CompleteMultipartUploadResult ${NS}><Bucket>${escapeXml(name)}</Bucket><Key>${escapeXml(key)}</Key>`
        + `<ETag>${escapeXml(done.httpEtag)}</ETag></CompleteMultipartUploadResult>`);
    }

    if (request.method === 'DELETE' && !query.has('partNumber')) {
      yield* attempt('io', () => upload.abort(), `aborting the upload of ${key}`);

      return new Response(null, { status: 204 });
    }

    return refused(request, 501, 'NotImplemented', `this store serves no ${request.method} ?${[...query.keys()].join('&')}`);
  });
}

function serveObject({ request, bucket }: StoreCall, key: string): Effect.Effect<Response, DevboxError> {
  return Effect.gen(function* () {
    switch (request.method) {
      case 'HEAD': {
        const head = yield* attempt('io', () => bucket.head(key), `reading ${key}`);

        return head === null ? new Response(null, { status: 404 }) : new Response(null, { headers: objectHeaders(head) });
      }

      case 'GET': {
        const range = requestedRange(request.headers.get('range'));
        const body = yield* attempt('io', () => bucket.get(key, range === undefined ? {} : { range }), `reading ${key}`);

        if (body === null) return s3Error(404, 'NoSuchKey', `${key} does not exist`);
        const headers = objectHeaders(body);

        if (range === undefined) return new Response(body.body, { headers });
        const start = 'suffix' in range ? Math.max(0, body.size - range.suffix) : range.offset ?? 0;
        const end = 'suffix' in range || range.length === undefined ? body.size - 1 : Math.min(body.size - 1, start + range.length - 1);

        headers.set('content-range', `bytes ${start}-${end}/${body.size}`);
        headers.set('content-length', String(end - start + 1));

        return new Response(body.body, { status: 206, headers });
      }

      case 'PUT': {
        if (request.headers.has('x-amz-copy-source')) return refused(request, 501, 'NotImplemented', 'an R2 binding copies nothing server-side');
        const length = Number(request.headers.get('content-length') ?? Number.NaN);

        if (!Number.isSafeInteger(length) || length < 0) return refused(request, 411, 'MissingContentLength', 'a put needs its content-length');
        const put = yield* attempt('io', () => withSizedBody(request, length, (body) => bucket.put(key, body, { httpMetadata: request.headers })), `writing ${key}`);

        return new Response(null, { headers: { etag: put.httpEtag } });
      }

      case 'DELETE':
        yield* attempt('io', () => bucket.delete(key), `deleting ${key}`);

        return new Response(null, { status: 204 });
      default:
        return refused(request, 405, 'MethodNotAllowed', `this store serves no ${request.method}`);
    }
  });
}

/** Holds each route to the bucket, prefix and access S3Mounts recorded for it; a guest chooses only
 *  the path, so it reaches no other binding and no other box's keys. */
export function serveStore(request: Request, props: StoreGatewayProps, bucketOf: (name: string) => R2Bucket | undefined): Effect.Effect<Response, DevboxError> {
  return Effect.gen(function* () {
    if (props.mode === 'deny') return refused(request, 403, 'AccessDenied', 'this store route has been revoked');
    const url = new URL(request.url);

    if (url.hostname !== storeRouteHost(props.routeId)) return refused(request, 403, 'AccessDenied', 'the host is not this route');

    if (request.headers.get('x-amz-content-sha256')?.startsWith('STREAMING-') === true) {
      return refused(request, 501, 'NotImplemented', 'aws-chunked bodies are not served');
    }

    const [, bucketPart = '', ...keyParts] = url.pathname.split('/');
    const [name, key] = yield* attemptSync('invalid-input', () => [decodeURIComponent(bucketPart), decodeURIComponent(keyParts.join('/'))]);

    if (name !== props.source.bucket) return refused(request, 403, 'AccessDenied', 'the path names another bucket');
    const bucket = bucketOf(name);

    if (bucket === undefined) return yield* Effect.fail(new DevboxError('configuration', `the store's R2 binding ${name} is not configured`));
    const call: StoreCall = { request, url, bucket, name };
    const prefix = props.keyPrefix ?? '';
    const query = url.searchParams;

    if (key === '') {
      if (request.method === 'HEAD' && query.size === 0) return new Response(null);

      if (request.method !== 'GET') return refused(request, 405, 'MethodNotAllowed', `this store serves no bucket ${request.method}`);

      if (query.has('location')) return xml(`<LocationConstraint ${NS}/>`);

      return yield* serveList(call, prefix);
    }

    if (key !== prefix.slice(0, -1) && !key.startsWith(prefix)) return refused(request, 403, 'AccessDenied', 'the key is outside this store prefix');

    if (props.access === 'read-only' && request.method !== 'GET' && request.method !== 'HEAD') {
      return refused(request, 403, 'AccessDenied', 'this store mount is read-only');
    }

    if (query.has('uploads') || query.has('uploadId')) return yield* serveMultipart(call, key);

    if (query.size > 0) return refused(request, 501, 'NotImplemented', `this store serves no ${request.method} ?${[...query.keys()].join('&')}`);

    return yield* serveObject(call, key);
  });
}

/** Handed to S3Mounts as its gateway binding in place of the SDK's signing `S3Gateway`. */
export class DevboxStoreGateway extends WorkerEntrypoint<Record<string, R2Bucket | undefined>, StoreGatewayProps> {
  override fetch(request: Request): Promise<Response> {
    return settle(serveStore(request, this.ctx.props, (name) => this.env[name]));
  }
}
