import { AsyncLocalStorage } from 'node:async_hooks';
import * as v from 'valibot';
import { describeThrown, type LateStartFailure } from '../src/lifecycle';
import type { PublicationAttempt, PublicationOperation } from './publication-meter';

export type PublicationFinish = Pick<PublicationAttempt, 'bytes' | 'observedBytes' | 'outcome' | 'error' | 'bodyError'>;

export interface PublicationMeterSink {
  begin(key: string, operation: PublicationOperation, uploadId: string | null): Promise<string | null>;
  finish(id: string, result: PublicationFinish): Promise<void>;
}

interface BodyObservation {
  observedBytes: number | null;
  complete: boolean;
  error: string | null;
  done: Promise<void>;
  stop: () => void;
}

const incomingBody = new AsyncLocalStorage<BodyObservation>();

/** A FixedLengthStream preserves the R2 binding's required length guarantee. */
export async function observePublicationRequest(
  request: Request,
  forward: (request: Request) => Promise<Response>,
): Promise<Response> {
  if (request.method !== 'PUT' || request.body === null) return await forward(request);
  const header = request.headers.get('content-length');
  const length = header === null ? null : Number(header);

  if (length === null || !Number.isSafeInteger(length) || length < 0) {
    const unknown = bodyObservation(null, 'the incoming PUT has no observed fixed body length');

    return await incomingBody.run(unknown, async () => await forward(request));
  }

  const stop = new AbortController();
  const observation = bodyObservation(0, null);
  observation.complete = false;
  observation.stop = () => stop.abort();
  let received = 0;

  const counted = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      observation.observedBytes = received;
      controller.enqueue(chunk);
    },
  });

  const fixed = new FixedLengthStream(length);
  observation.done = request.body.pipeThrough(counted).pipeTo(fixed.writable, { signal: stop.signal }).then(
    () => {
      observation.complete = received === length;

      if (!observation.complete) observation.error = 'the observed PUT length disagrees with its content length';
    },
    (cause: LateStartFailure['cause']) => { observation.error = describeThrown({ cause }); },
  );

  try {
    const forwarded = new Request(request, { method: 'PUT', body: fixed.readable });

    return await incomingBody.run(observation, async () => await forward(forwarded));
  } finally {
    if (!observation.complete) observation.stop();
    await observation.done;
  }
}

function bodyObservation(bytes: number | null, error: string | null): BodyObservation {
  return { observedBytes: bytes, complete: bytes !== null, error, done: Promise.resolve(), stop: () => {} };
}

type UploadValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob;

function observeBody(value: UploadValue): BodyObservation {
  if (value instanceof ReadableStream) {
    return incomingBody.getStore() ?? bodyObservation(null, 'the binding stream has no transport body observation');
  }

  if (value === null) return bodyObservation(0, null);

  if (v.is(v.string(), value)) return bodyObservation(new TextEncoder().encode(value).byteLength, null);

  if (value instanceof Blob) return bodyObservation(value.size, null);

  return bodyObservation(value.byteLength, null);
}

/** Record attempts before the write, including failures after a fully read body. */
export function meterPublicationBucket(bucket: R2Bucket, sink: PublicationMeterSink): R2Bucket {
  const measure = async <Result>(
    key: string, operation: PublicationOperation, uploadId: string | null,
    value: UploadValue, run: () => Promise<Result>,
  ): Promise<Result> => {
    const id = await sink.begin(key, operation, uploadId);

    if (id === null) return await run();
    const body = observeBody(value);
    let outcome: 'returned' | 'threw' = 'returned';
    let error: string | null = null;

    try {
      const result = await run();

      if (result === null && !body.complete) body.stop();

      return result;
    } catch (cause) {
      outcome = 'threw';
      error = describeThrown({ cause });

      if (!body.complete) body.stop();
      throw cause;
    } finally {
      await body.done;
      await sink.finish(id, {
        bytes: body.complete ? body.observedBytes : null,
        observedBytes: body.observedBytes, bodyError: body.error, outcome, error,
      });
    }
  };

  const multipart = (upload: R2MultipartUpload): R2MultipartUpload => ({
    key: upload.key,
    uploadId: upload.uploadId,
    uploadPart: async (part, value, options) => await measure(upload.key, 'uploadPart', upload.uploadId, value,
      async () => await upload.uploadPart(part, value, options)),
    complete: async (parts) => await measure(upload.key, 'complete', upload.uploadId, null,
      async () => await upload.complete(parts)),
    abort: async () => await upload.abort(),
  });

  const delegate: R2Bucket = Object.create(bucket);

  return Object.assign(delegate, {
    put: async (key: string, value: UploadValue, options?: R2PutOptions) =>
      await measure(key, 'put', null, value, async () => await bucket.put(key, value, options)),
    createMultipartUpload: async (key: string, options?: R2MultipartOptions) => multipart(await bucket.createMultipartUpload(key, options)),
    resumeMultipartUpload: (key: string, uploadId: string) => multipart(bucket.resumeMultipartUpload(key, uploadId)),
  });
}
