/**
 * A file's bytes across an RPC in bounded chunks (a whole file as one argument hits `do.facet.rpc_bytes`), as the Files
 * and the Drive routes both move them: one transfer id per request, the body pumped in whole chunks and a final tail,
 * the far side told to drop its transfer however the request ends early, and every failure answered by its code's
 * status. Each route names its far side as a port, and its answers.
 */
import { Effect } from 'effect';
import { err, ERROR_STATUS, readBoundedStream } from '../http/http';
import { diagnostics, KinuError, settle, toKinuError, type LoggableFields } from '../obs/index';
import { FILE_CHUNK_BYTES } from '../types/read-models';
import { FILE_TRANSFER_MAX_BYTES } from './files';

const TRANSFER_LIMIT = `${String(Math.floor(FILE_TRANSFER_MAX_BYTES / (1024 * 1024)))} MiB transfer limit`;

/** Where an upload's chunks go, and what its last one's answer says. */
export interface UploadPort<Written, Fields> {
  /** Names the transfer in diagnostics: `files`, `drive`, with its own fields (a Files upload's executor and path). */
  readonly surface: 'files' | 'drive';
  readonly fields: Fields & LoggableFields<Fields>;
  write(transferId: string, offset: number, chunk: Uint8Array, final: boolean): Promise<Written>;
  /** A chunk before the last that the far side refused, as its failure; null for one it took. */
  refused(written: Written): KinuError | null;
  abort(transferId: string): Promise<void>;
  answer(written: Written): Response;
}

/** Where a download's chunks come from. `start` takes the file's snapshot; each read is a range of it. */
export interface DownloadPort<Opened extends { readonly size: number }> {
  start(transferId: string): Promise<Opened | KinuError>;
  read(transferId: string, offset: number, length: number): Promise<Uint8Array | KinuError>;
  abort(transferId: string): Promise<void>;
}

/** The body as whole {@link FILE_CHUNK_BYTES} chunks then one final (possibly empty) tail. A chunk the far side refuses
 *  ends the pull, the rest of the body unread. */
async function pumpChunks<Written>(
  request: Request, port: Pick<UploadPort<Written, unknown>, 'write' | 'refused'>, transferId: string,
): Promise<'too_large' | KinuError | { readonly refused: KinuError } | { readonly result: Written }> {
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let offset = 0;
  let refused: KinuError | null = null;

  const take = (want: number): Uint8Array => {
    const out = new Uint8Array(want);
    let at = 0;

    while (at < want) {
      const part = pending[0];
      const count = Math.min(part.byteLength, want - at);
      out.set(part.subarray(0, count), at);

      if (count === part.byteLength) pending.shift();
      else pending[0] = part.subarray(count);
      at += count;
    }

    pendingBytes -= want;

    return out;
  };

  const outcome = await readBoundedStream(request, FILE_TRANSFER_MAX_BYTES, async (value) => {
    pending.push(value);
    pendingBytes += value.byteLength;

    while (pendingBytes >= FILE_CHUNK_BYTES) {
      refused = port.refused(await port.write(transferId, offset, take(FILE_CHUNK_BYTES), false));

      if (refused !== null) return 'stop';
      offset += FILE_CHUNK_BYTES;
    }

    return undefined;
  });

  if (refused !== null) return { refused };

  if (outcome !== 'ok') return outcome;

  return { result: await port.write(transferId, offset, pendingBytes > 0 ? take(pendingBytes) : new Uint8Array(0), true) };
}

/** Streams `request`'s body to `port`; the bound counts bytes pulled, not the declared length, and the far side
 *  re-checks offsets and the total. */
export function serveUpload<Written, Fields>(request: Request, port: UploadPort<Written, Fields>): Promise<Response> {
  if (request.body === null) return Promise.resolve(err(ERROR_STATUS.bad_input, 'request body required'));
  const transferId = crypto.randomUUID();

  const abandon = Effect.tryPromise({
    try: () => port.abort(transferId),
    catch: (cause) => toKinuError({ doing: 'aborting a failed chunked upload', cause, otherwise: 'unavailable' }),
  }).pipe(Effect.catch((failure) => Effect.sync(() => { diagnostics.failure<Fields>(`${port.surface}.upload_abort_failed`, failure, port.fields); })));

  return settle(Effect.gen(function* () {
    const outcome = yield* Effect.tryPromise({
      try: () => pumpChunks(request, port, transferId),
      catch: (cause) => toKinuError({ doing: 'streaming an upload across its chunks', cause, otherwise: 'unavailable' }),
    });

    if (outcome !== 'too_large' && !(outcome instanceof KinuError) && 'result' in outcome) return port.answer(outcome.result);
    yield* abandon;

    if (outcome === 'too_large') return err(ERROR_STATUS.budget, `the upload exceeds the ${TRANSFER_LIMIT}`);

    if (outcome instanceof KinuError) {
      diagnostics.failure<Fields>(`${port.surface}.upload_body_unreadable`, outcome, port.fields);

      return err(ERROR_STATUS.bad_input, 'the upload stopped before the whole file arrived');
    }

    return err(ERROR_STATUS[outcome.refused.code], outcome.refused.message);
  }).pipe(
    // The far side failed rather than answered: the transfer is the server's to drop, and its failure the server's.
    Effect.catch((failure) => Effect.andThen(abandon, Effect.sync(() => {
      diagnostics.failure<Fields>(`${port.surface}.upload_failed`, failure, port.fields);

      return err(ERROR_STATUS.io, failure.message);
    }))),
  ));
}

/** The file `port` serves, streamed a chunk at a time; a far side that ends before the size it opened with errors the
 *  stream rather than truncating it. */
export async function serveDownload<Opened extends { readonly size: number }>(
  port: DownloadPort<Opened>, headers: (opened: Opened) => HeadersInit,
): Promise<Response> {
  const transferId = crypto.randomUUID();
  const opened = await port.start(transferId);

  if (opened instanceof KinuError) return err(ERROR_STATUS[opened.code], opened.message);
  let offset = 0;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= opened.size) {
        await port.abort(transferId);
        controller.close();

        return;
      }

      const chunk = await port.read(transferId, offset, Math.min(FILE_CHUNK_BYTES, opened.size - offset));

      if (chunk instanceof KinuError || chunk.byteLength === 0) {
        await port.abort(transferId);
        controller.error(chunk instanceof KinuError ? chunk : new KinuError('io', `file ended at ${String(offset)} of ${String(opened.size)} bytes`));

        return;
      }

      offset += chunk.byteLength;
      controller.enqueue(chunk);
    },
    async cancel() {
      await port.abort(transferId);
    },
  });

  return new Response(stream, { headers: headers(opened) });
}
