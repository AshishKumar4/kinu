// Behaviour of POST /api/feedback: how much of a body it will read, what it
// refuses, what it stores, and what it cleans up when the store and the row
// disagree.
//
// The policy is driven through its injected effects rather than through a
// Worker, so every arm — including "R2 took the bytes and the row write then
// failed", which no live deployment will reproduce on demand — is reachable.
import { describe, test, expect, afterEach } from 'bun:test';
import * as v from 'valibot';
import { deflateSync } from 'node:zlib';
import { createRecordingLogger, setDiagnosticsSink, type RecordedLog } from '@kinu.run/core/obs';
import type { AuthIdentity } from '../src/auth/session';
import { routeFeedback, type FeedbackDeps } from '../src/feedback/submit';
import { handleFeedbackRequest, type FeedbackEnv } from '../src/feedback/routes';
import type { UserCaller } from '../src/user/workspace-capability';
import type { FeedbackMarker } from '../src/analytics/feedback-marker';
import {
  FEEDBACK_ENDPOINT,
  FEEDBACK_FIELDS,
  FEEDBACK_MAX_NOTE_CHARS,
  FEEDBACK_MAX_REQUEST_BYTES,
  FEEDBACK_MAX_SCREENSHOT_BYTES,
  type FeedbackRecord,
} from '../src/feedback/contract';

const ME: AuthIdentity = { userId: 'user-7', email: 'me@example.com', sub: 'sub-7' };
const URL_ = `https://kinu.run${FEEDBACK_ENDPOINT}`;

// ── a real PNG, built rather than pasted ───────────────────────────────────
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let bit = 0; bit < 8; bit += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
function be32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}
function chunk(type: string, data: readonly number[]): number[] {
  const typed = [...type].map((ch) => ch.charCodeAt(0));
  return [...be32(data.length), ...typed, ...data, ...be32(crc32(new Uint8Array([...typed, ...data])))];
}

/** A decodable 2x2 image, optionally carrying metadata chunks to be stripped. */
function realPng(extra: number[][] = []): Uint8Array<ArrayBuffer> {
  const raw: number[] = [];
  for (let y = 0; y < 2; y += 1) {
    raw.push(0);
    for (let x = 0; x < 2; x += 1) raw.push(0x20, 0x30, 0x40, 0xff);
  }
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [...be32(2), ...be32(2), 8, 6, 0, 0, 0]),
    ...extra.flat(),
    ...chunk('IDAT', [...deflateSync(Buffer.from(raw))]),
    ...chunk('IEND', []),
  ]);
}

// ── the injected effects ───────────────────────────────────────────────────
interface Recorder {
  deps: FeedbackDeps;
  objects: Map<string, Uint8Array>;
  deleted: string[];
  rows: FeedbackRecord[];
  marks: FeedbackMarker[];
  /** Every question put to the ownership authority, in order. Empty is a claim
   *  in itself: a report that names no workspace must ask nothing. */
  asked: { userId: string; workspace: string }[];
}

function recorder(options: {
  bucket?: boolean;
  rowError?: string;
  deleteThrows?: boolean;
  putThrows?: boolean;
  /** The workspaces this reporter owns. Absent means every name they send is
   *  theirs, so a test that is not about attribution reads as it did before the
   *  gate existed; a test that IS about it names the registry it wants. */
  owns?: readonly string[];
  /** The authority could not answer at all. */
  authorityDown?: string;
} = {}): Recorder {
  const objects = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  const rows: FeedbackRecord[] = [];
  const marks: FeedbackMarker[] = [];
  const asked: { userId: string; workspace: string }[] = [];
  let minted = 0;
  const deps: FeedbackDeps = {
    store: options.bucket === false ? null : {
      async put(key, bytes) {
        if (options.putThrows === true) throw new Error('R2 refused the write');
        objects.set(key, bytes);
        await Promise.resolve();
      },
      async delete(key) {
        deleted.push(key);
        if (options.deleteThrows === true) throw new Error('R2 refused the delete');
        objects.delete(key);
        await Promise.resolve();
      },
    },
    record: async (row) => {
      rows.push(row);
      await Promise.resolve();
      return options.rowError === undefined ? { id: row.id } : { error: options.rowError };
    },
    attributeWorkspace: async (userId, workspace) => {
      asked.push({ userId, workspace });
      await Promise.resolve();
      if (options.authorityDown !== undefined) {
        return { kind: 'unavailable', error: options.authorityDown };
      }
      return options.owns === undefined || options.owns.includes(workspace)
        ? { kind: 'owned', workspace }
        : { kind: 'refused' };
    },
    mark: (marker) => { marks.push(marker); },
    newId: () => { minted += 1; return `id-${String(minted)}`; },
    now: () => 1_700_000_000_000,
  };
  return { deps, objects, deleted, rows, marks, asked };
}

/** What `POST /api/feedback` answers with, parsed rather than asserted. */
const ReplySchema = v.object({ id: v.optional(v.string()), error: v.optional(v.string()) });

function submit(fields: {
  note?: string;
  route?: string;
  workspace?: string;
  annotated?: string;
  screenshot?: Blob;
  /** A STRING sent under the screenshot field's name — a caller putting
   *  something other than a file where the file goes. Separate from
   *  `screenshot` so neither case has to be told apart at runtime. */
  screenshotText?: string;
  /** The part's filename. Load-bearing, not decoration: the multipart parser
   *  derives `File.type` from this extension rather than from the part's own
   *  Content-Type header (measured 2026-08-24), which is exactly why the
   *  byte-level check and not the declared type is the gate. */
  filename?: string;
  headers?: Record<string, string>;
}): Request {
  const form = new FormData();
  if (fields.note !== undefined) form.set(FEEDBACK_FIELDS.note, fields.note);
  if (fields.route !== undefined) form.set(FEEDBACK_FIELDS.route, fields.route);
  if (fields.workspace !== undefined) form.set(FEEDBACK_FIELDS.workspace, fields.workspace);
  if (fields.annotated !== undefined) form.set(FEEDBACK_FIELDS.annotated, fields.annotated);
  if (fields.screenshotText !== undefined) {
    form.set(FEEDBACK_FIELDS.screenshot, fields.screenshotText);
  }
  if (fields.screenshot !== undefined) {
    form.set(
      FEEDBACK_FIELDS.screenshot,
      new File([fields.screenshot], fields.filename ?? 'shot.png', { type: fields.screenshot.type }),
    );
  }
  return new Request(URL_, { method: 'POST', body: form, headers: fields.headers });
}

function pngPart(bytes: Uint8Array<ArrayBuffer>): Blob {
  return new Blob([bytes], { type: 'image/png' });
}

/**
 * One multipart body as BYTES, padded to exactly `total`.
 *
 * Assembled by hand rather than through `FormData`, because these tests are
 * about the SIZE of a body and a body assembled for you is one whose length you
 * can only measure afterwards. Every byte here is ASCII, so the encoded length
 * is the string length and `total` means what it says.
 */
function rawMultipart(total: number) {
  const boundary = '----kinuFeedbackBound';
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="${FEEDBACK_FIELDS.note}"\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const padding = total - head.length - tail.length;
  if (padding < 1) throw new Error(`${String(total)} bytes cannot hold this body's own framing`);
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    bytes: new TextEncoder().encode(`${head}${'n'.repeat(padding)}${tail}`),
  };
}

/** What the producer of a chunked body saw. `reachedEnd` is the load-bearing
 *  one: a bound that answers only after EOF has measured an upload rather than
 *  refused it. */
interface BodySource {
  pulls: number;
  delivered: number;
  reachedEnd: boolean;
  cancelled: boolean;
}

/**
 * A body that ARRIVES in `chunk`-sized pieces, with the producer's own pulls and
 * cancellation observable. A request built over this declares no length, which
 * is the shape a chunked or HTTP/2 upload actually has.
 *
 * `highWaterMark: 0` so `pulls` counts what the CONSUMER asked for. The default
 * strategy pre-fills one chunk the moment the stream is constructed, which reads
 * as the handler having touched a body it never opened.
 */
function chunked(bytes: Uint8Array, chunk: number) {
  const source: BodySource = { pulls: 0, delivered: 0, reachedEnd: false, cancelled: false };
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      source.pulls += 1;
      if (at >= bytes.length) {
        source.reachedEnd = true;
        controller.close();
        return;
      }
      const slice = bytes.slice(at, Math.min(at + chunk, bytes.length));
      at += slice.length;
      source.delivered += slice.length;
      controller.enqueue(slice);
    },
    cancel() { source.cancelled = true; },
  }, { highWaterMark: 0 });
  return { body, source };
}

async function replyOf(response: Response): Promise<v.InferOutput<typeof ReplySchema>> {
  return v.parse(ReplySchema, await response.json());
}

afterEach(() => { setDiagnosticsSink(createRecordingLogger()); });

describe('routing', () => {
  test('another path is not this module’s business', async () => {
    const { deps } = recorder();
    expect(await routeFeedback(new Request('https://kinu.run/api/user/profile'), ME, deps)).toBeNull();
  });

  test('the endpoint answers 405 for a method that is not POST', async () => {
    const { deps } = recorder();
    const response = await routeFeedback(new Request(URL_), ME, deps);
    expect(response?.status).toBe(405);
  });
});

describe('what the endpoint refuses', () => {
  test('no identity is a 401, and nothing is stored or recorded', async () => {
    const rec = recorder();
    const response = await routeFeedback(submit({ note: 'broken' }), null, rec.deps);
    expect(response?.status).toBe(401);
    expect(rec.rows).toEqual([]);
    expect(rec.objects.size).toBe(0);
    expect(rec.marks[0]).toMatchObject({ outcome: 'rejected', rejectReason: 'unauthenticated' });
  });

  test('a body that is not multipart is a 415', async () => {
    const rec = recorder();
    const response = await routeFeedback(new Request(URL_, {
      method: 'POST',
      body: JSON.stringify({ note: 'hi' }),
      headers: { 'content-type': 'application/json' },
    }), ME, rec.deps);
    expect(response?.status).toBe(415);
    expect(rec.marks[0]?.rejectReason).toBe('bad_content_type');
  });

  test('a declared length too big for one screenshot is refused BEFORE the body is read', async () => {
    const rec = recorder();
    // The body is a VALID submission that would be accepted on its own, and the
    // only thing wrong with the request is the stated length. So a 201 here
    // would mean the handler parsed the body first, and the 413 is the proof it
    // did not: a header refusal is the difference between rejecting an 8 MiB
    // upload and buffering it.
    const honest = submit({ note: 'this would be accepted' });
    // Read the header BEFORE consuming the body: the multipart content type is
    // derived from the FormData, and it does not survive being read inside the
    // same object literal that consumes it.
    const contentType = honest.headers.get('content-type') ?? '';
    const bytes = await honest.arrayBuffer();
    const response = await routeFeedback(new Request(URL_, {
      method: 'POST',
      body: bytes,
      headers: { 'content-type': contentType, 'content-length': String(FEEDBACK_MAX_REQUEST_BYTES + 1) },
    }), ME, rec.deps);
    expect(response?.status).toBe(413);
    expect(rec.rows).toEqual([]);
    expect(rec.marks[0]?.rejectReason).toBe('too_large');
  });

  test('a screenshot over the limit is a 413 that names the size and offers the note alone', async () => {
    const rec = recorder();
    const huge = pngPart(new Uint8Array(FEEDBACK_MAX_SCREENSHOT_BYTES + 1024));
    const response = await routeFeedback(submit({ note: 'see image', screenshot: huge }), ME, rec.deps);
    expect(response?.status).toBe(413);
    expect((await replyOf(response!)).error).toContain('note');
    expect(rec.objects.size).toBe(0);
    expect(rec.rows).toEqual([]);
    expect(rec.marks[0]).toMatchObject({ rejectReason: 'too_large', screenshotBytes: FEEDBACK_MAX_SCREENSHOT_BYTES + 1024 });
  });

  test('a part NAMED as something other than a PNG is a 415 before its bytes are read', async () => {
    const rec = recorder();
    // Genuine PNG bytes under the filename `screenshot.jpg`. The parser derives
    // `File.type` from that extension, so this is the reachable form of the
    // declared-type refusal — and the courtesy it buys is a clear message
    // instead of "those bytes are corrupt".
    const response = await routeFeedback(
      submit({ note: 'x', screenshot: pngPart(realPng()), filename: 'screenshot.jpg' }), ME, rec.deps);
    expect(response?.status).toBe(415);
    expect(rec.objects.size).toBe(0);
    expect(rec.marks[0]?.rejectReason).toBe('bad_content_type');
  });

  test('the declared type is NOT what protects us — a .png name over JPEG bytes still fails', async () => {
    // The measured fact this endpoint is built around: a part sent with
    // `Content-Type: image/jpeg` and the filename `shot.png` comes back from the
    // multipart parser reporting `image/png`. The declaration is therefore
    // caller-controlled, and the only thing standing between a forged upload and
    // storage is the byte-level walk.
    const rec = recorder();
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Array.from({ length: 200 }, () => 0x37)]);
    const request = submit({ note: 'x', screenshot: new Blob([jpegBytes], { type: 'image/jpeg' }), filename: 'shot.png' });
    const part = (await request.clone().formData()).get(FEEDBACK_FIELDS.screenshot);
    expect(part instanceof Blob ? part.type : '').toBe('image/png');

    const response = await routeFeedback(request, ME, rec.deps);
    expect(response?.status).toBe(400);
    expect(rec.objects.size).toBe(0);
    expect(rec.rows).toEqual([]);
    expect(rec.marks[0]?.rejectReason).toBe('malformed');
  });

  test('a forged screenshot — declared PNG, bytes are not — is a 400 and never reaches R2', async () => {
    const rec = recorder();
    const forged = pngPart(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 128 }, () => 0x41)]));
    const response = await routeFeedback(submit({ note: 'x', screenshot: forged }), ME, rec.deps);
    expect(response?.status).toBe(400);
    expect(rec.objects.size).toBe(0);
    expect(rec.rows).toEqual([]);
    expect(rec.marks[0]?.rejectReason).toBe('malformed');
  });

  test('a real PNG with one byte corrupted is refused on its checksum', async () => {
    const rec = recorder();
    const bytes = realPng();
    bytes[bytes.length - 20] = bytes[bytes.length - 20] ^ 0xff;
    const response = await routeFeedback(submit({ note: 'x', screenshot: pngPart(bytes) }), ME, rec.deps);
    expect(response?.status).toBe(400);
    expect(rec.marks[0]?.rejectReason).toBe('malformed');
  });

  test('a string sent under the screenshot field name is a 415, not a silent skip', async () => {
    const rec = recorder();
    const response = await routeFeedback(submit({ note: 'x', screenshotText: 'not a file' }), ME, rec.deps);
    expect(response?.status).toBe(415);
    expect(rec.marks[0]?.rejectReason).toBe('bad_content_type');
  });

  test('an empty submission is a 400 of its own kind, not "malformed"', async () => {
    const rec = recorder();
    const response = await routeFeedback(submit({ note: '   ' }), ME, rec.deps);
    expect(response?.status).toBe(400);
    expect(rec.rows).toEqual([]);
    expect(rec.marks[0]?.rejectReason).toBe('no_content');
  });

  test('with no bucket bound a screenshot is a 503 that blames the deployment', async () => {
    const rec = recorder({ bucket: false });
    const response = await routeFeedback(
      submit({ note: 'x', screenshot: pngPart(realPng()) }), ME, rec.deps);
    expect(response?.status).toBe(503);
    expect((await replyOf(response!)).error).toContain('note');
    expect(rec.marks[0]?.rejectReason).toBe('storage_unavailable');
  });
});

describe('how much of a body it will read', () => {
  test('a body at exactly the limit is accepted, and no declared length admitted it', async () => {
    const rec = recorder();
    const { contentType, bytes } = rawMultipart(FEEDBACK_MAX_REQUEST_BYTES);
    const request = new Request(URL_, { method: 'POST', headers: { 'content-type': contentType }, body: bytes });
    // The boundary only means something if the header path is not what let it
    // through: a byte body carries no `content-length` for a handler to read.
    expect(request.headers.get('content-length')).toBeNull();

    const response = await routeFeedback(request, ME, rec.deps);
    expect(response?.status).toBe(201);
    expect(rec.rows).toHaveLength(1);
    expect(rec.marks.at(-1)).toMatchObject({ outcome: 'accepted', rejectReason: '' });
  });

  test('one byte past the limit, with nothing declaring a length, is refused', async () => {
    const rec = recorder();
    const { contentType, bytes } = rawMultipart(FEEDBACK_MAX_REQUEST_BYTES + 1);
    const response = await routeFeedback(
      new Request(URL_, { method: 'POST', headers: { 'content-type': contentType }, body: bytes }), ME, rec.deps);
    expect(response?.status).toBe(413);
    expect(rec.rows).toEqual([]);
    expect(rec.marks).toHaveLength(1);
    expect(rec.marks[0]?.rejectReason).toBe('too_large');
  });

  test('a chunked oversize body is abandoned mid-upload: cancelled, never read to EOF, nothing written', async () => {
    const rec = recorder();
    const chunk = 64 * 1024;
    const { contentType, bytes } = rawMultipart(FEEDBACK_MAX_REQUEST_BYTES + chunk * 8);
    const { body, source } = chunked(bytes, chunk);

    const response = await routeFeedback(
      new Request(URL_, { method: 'POST', headers: { 'content-type': contentType }, body }), ME, rec.deps);

    expect(response?.status).toBe(413);
    // The whole point. The upload was STOPPED, not measured: EOF never arrived,
    // the producer was cancelled, and the bytes it never sent are the difference
    // between refusing an 8 MiB upload and buffering one.
    expect(source.cancelled).toBe(true);
    expect(source.reachedEnd).toBe(false);
    expect(source.delivered).toBeLessThan(bytes.length);
    // At most the chunk carrying the first excess byte, and no more.
    expect(source.delivered).toBeLessThanOrEqual(FEEDBACK_MAX_REQUEST_BYTES + chunk);
    // And nothing downstream ran: no object, no row, exactly one marker.
    expect(rec.objects.size).toBe(0);
    expect(rec.rows).toEqual([]);
    expect(rec.marks).toHaveLength(1);
    expect(rec.marks[0]?.rejectReason).toBe('too_large');
  });

  test('a chunked body at the limit still succeeds, so the bound counts bytes and not chunks', async () => {
    const rec = recorder();
    const { contentType, bytes } = rawMultipart(FEEDBACK_MAX_REQUEST_BYTES);
    const { body, source } = chunked(bytes, 64 * 1024);
    const response = await routeFeedback(
      new Request(URL_, { method: 'POST', headers: { 'content-type': contentType }, body }), ME, rec.deps);
    expect(response?.status).toBe(201);
    expect(source.reachedEnd).toBe(true);
    expect(source.cancelled).toBe(false);
  });

  test('a declared length still short-circuits, so the header stays an optimisation', async () => {
    const rec = recorder();
    const { contentType, bytes } = rawMultipart(4096);
    const { body, source } = chunked(bytes, 1024);
    const response = await routeFeedback(new Request(URL_, {
      method: 'POST',
      headers: { 'content-type': contentType, 'content-length': String(FEEDBACK_MAX_REQUEST_BYTES + 1) },
      body,
    }), ME, rec.deps);
    expect(response?.status).toBe(413);
    // Not one pull: a refusal that reads nothing is why the header is checked at all.
    expect(source.pulls).toBe(0);
  });

  test('a body that is not the multipart it declared is a 400, never a throw', async () => {
    const recording = createRecordingLogger();
    setDiagnosticsSink(recording);
    const rec = recorder();
    const body = new TextEncoder().encode('plain bytes, no parts, no final boundary');
    const response = await routeFeedback(new Request(URL_, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=nothing-like-this' },
      body,
    }), ME, rec.deps);
    expect(response?.status).toBe(400);
    expect(rec.marks).toHaveLength(1);
    expect(rec.marks[0]?.rejectReason).toBe('malformed');

    // The parse failure is RECORDED, and recorded as the caller's. Returned as
    // `null` it read exactly like an absent form, and it was filed under
    // `unavailable` — a class that says the platform broke, which would put a
    // malformed upload into every query for our own outages.
    const line = recording.emitted.find((emitted) => emitted.event === 'feedback.body_unparseable');
    expect(line).toBeDefined();
    expect(line?.code).toBe('bad_input');
    expect(line?.cause).toContain('parsing a feedback submission as multipart/form-data');
    expect(line?.fields).toMatchObject({ bytes: body.byteLength });
  });
});

describe('what the endpoint stores', () => {
  test('a note-only report is a first-class row with every screenshot column null', async () => {
    const rec = recorder();
    const response = await routeFeedback(submit({
      note: '  the exploration tab is blank  ',
      route: '/workspace/checkout-fixes',
      workspace: 'checkout-fixes',
    }), ME, rec.deps);

    expect(response?.status).toBe(201);
    expect(await replyOf(response!)).toEqual({ id: 'id-1' });
    expect(rec.objects.size).toBe(0);
    expect(rec.rows).toEqual([{
      id: 'id-1',
      createdAt: 1_700_000_000_000,
      userId: 'user-7',
      email: 'me@example.com',
      note: 'the exploration tab is blank',
      route: '/workspace/checkout-fixes',
      workspace: 'checkout-fixes',
      objectKey: null,
      contentType: null,
      bytes: null,
      userAgent: null,
    }]);
  });

  test('a screenshot report writes R2 under the user’s prefix, then the row that points at it', async () => {
    const rec = recorder();
    const request = submit({ note: 'here', route: '/mcts/checkout-fixes', workspace: 'checkout-fixes', screenshot: pngPart(realPng()) });
    request.headers.set('user-agent', 'Mozilla/5.0 (probe)');
    const response = await routeFeedback(request, ME, rec.deps);

    expect(response?.status).toBe(201);
    const key = 'feedback/user-7/id-1.png';
    expect([...rec.objects.keys()]).toEqual([key]);
    expect(rec.rows[0]).toMatchObject({
      objectKey: key,
      contentType: 'image/png',
      bytes: rec.objects.get(key)?.length,
      userAgent: 'Mozilla/5.0 (probe)',
      workspace: 'checkout-fixes',
    });
  });

  test('metadata chunks are gone from the bytes that reach storage', async () => {
    const rec = recorder();
    const secret = [...'lat 51.5 lon -0.1'].map((ch) => ch.charCodeAt(0));
    const withExif = realPng([chunk('eXIf', secret), chunk('tEXt', secret)]);
    // Present going in, so the assertion below is about the strip and not about
    // a fixture that never carried anything.
    expect(Buffer.from(withExif).includes(Buffer.from(secret))).toBe(true);

    await routeFeedback(submit({ note: 'x', screenshot: pngPart(withExif) }), ME, rec.deps);
    const stored = rec.objects.get('feedback/user-7/id-1.png');
    expect(stored).toBeDefined();
    expect(Buffer.from(stored!).includes(Buffer.from(secret))).toBe(false);
    expect(stored!.length).toBeLessThan(withExif.length);
  });

  test('over-long text is clamped at the edge, not rejected', async () => {
    const rec = recorder();
    const request = submit({ note: 'n'.repeat(FEEDBACK_MAX_NOTE_CHARS + 500), route: `/workspace/${'s'.repeat(900)}` });
    request.headers.set('user-agent', 'u'.repeat(900));
    await routeFeedback(request, ME, rec.deps);
    expect(rec.rows[0]?.note.length).toBe(FEEDBACK_MAX_NOTE_CHARS);
    expect(rec.rows[0]?.route.length).toBe(512);
    expect(rec.rows[0]?.userAgent?.length).toBe(512);
  });

  test('an absent workspace field is null rather than an empty string', async () => {
    const rec = recorder();
    await routeFeedback(submit({ note: 'x', route: '/' }), ME, rec.deps);
    expect(rec.rows[0]?.workspace).toBeNull();
  });
});

describe('when the row write fails, the object does not survive it', () => {
  test('the orphan is deleted and the answer is a 500 named as our failure', async () => {
    const rec = recorder({ rowError: 'control plane unreachable' });
    const response = await routeFeedback(
      submit({ note: 'x', screenshot: pngPart(realPng()) }), ME, rec.deps);

    expect(response?.status).toBe(500);
    expect(rec.deleted).toEqual(['feedback/user-7/id-1.png']);
    expect(rec.objects.size).toBe(0);
    expect(rec.marks.at(-1)?.rejectReason).toBe('row_write_failed');
  });

  test('a note-only failure deletes nothing, because there was nothing to orphan', async () => {
    const rec = recorder({ rowError: 'control plane unreachable' });
    const response = await routeFeedback(submit({ note: 'x' }), ME, rec.deps);
    expect(response?.status).toBe(500);
    expect(rec.deleted).toEqual([]);
  });

  test('a failing delete still answers 500 and records the key so the leftover is findable', async () => {
    const logs: RecordedLog[] = [];
    const recording = createRecordingLogger();
    setDiagnosticsSink(recording);
    const rec = recorder({ rowError: 'control plane unreachable', deleteThrows: true });
    const response = await routeFeedback(
      submit({ note: 'x', screenshot: pngPart(realPng()) }), ME, rec.deps);

    expect(response?.status).toBe(500);
    logs.push(...recording.emitted);
    const retained = logs.find((line) => line.event === 'feedback.orphan_retained');
    expect(retained).toBeDefined();
    expect(retained?.fields).toMatchObject({ objectKey: 'feedback/user-7/id-1.png' });
    // The delete failure must not become the reported cause: the reporter is
    // told the report was not saved, which is the fact that matters to them.
    expect(rec.marks.at(-1)?.rejectReason).toBe('row_write_failed');
  });
});

describe('when the object store refuses the write', () => {
  test('the answer is a 503 naming the outage, and no row is written', async () => {
    const recording = createRecordingLogger();
    setDiagnosticsSink(recording);
    const rec = recorder({ putThrows: true });
    const response = await routeFeedback(
      submit({ note: 'x', screenshot: pngPart(realPng()) }), ME, rec.deps);

    // NOT a throw. Uncaught, this was a platform 500 with no marker and no row —
    // a lost report invisible to the rate that exists to count lost reports.
    expect(response?.status).toBe(503);
    expect((await replyOf(response!)).error).toContain('note');
    expect(rec.rows).toEqual([]);
    expect(rec.objects.size).toBe(0);
    // Nothing to orphan: the object was never written, so nothing is deleted.
    expect(rec.deleted).toEqual([]);
    expect(rec.marks).toHaveLength(1);
    expect(rec.marks[0]).toMatchObject({
      outcome: 'rejected',
      rejectReason: 'storage_unavailable',
      hasScreenshot: true,
    });
    expect(rec.marks[0]?.screenshotBytes).toBeGreaterThan(0);
    // The key is recorded, because a failed write is the one thing an operator
    // needs to be able to look for.
    const failed = recording.emitted.find((line) => line.event === 'feedback.screenshot_store_failed');
    expect(failed?.fields).toMatchObject({ objectKey: 'feedback/user-7/id-1.png' });
  });
});

describe('the analytics marker', () => {
  test('an accepted report carries counts and flags, and no text', async () => {
    const rec = recorder();
    await routeFeedback(submit({
      note: 'twelve chars',
      route: '/workspace/secret-project-name',
      workspace: 'secret-project-name',
      annotated: '1',
      screenshot: pngPart(realPng()),
    }), ME, rec.deps);

    const mark = rec.marks.at(-1)!;
    expect(mark).toMatchObject({
      outcome: 'accepted',
      rejectReason: '',
      routeFamily: 'workspace',
      hasScreenshot: true,
      noteLength: 12,
      annotated: true,
    });
    // The workspace slug is user-authored text. It must not be anywhere in the
    // datapoint, under any field.
    expect(JSON.stringify(mark)).not.toContain('secret-project-name');
    expect(JSON.stringify(mark)).not.toContain('twelve chars');
    expect(JSON.stringify(mark)).not.toContain(ME.email);
  });

  test('each route becomes its family and nothing finer', async () => {
    const seen: string[] = [];
    // A distinctive slug, so the last assertion is about the slug and not about
    // a letter that happens to occur in a family name.
    const slug = 'zzslugzz';
    for (const route of ['/', `/workspace/${slug}`, `/mcts/${slug}`, `/settings/${slug}`, '/user/settings', `/triggers/${slug}`]) {
      const rec = recorder();
      await routeFeedback(submit({ note: 'x', route }), ME, rec.deps);
      seen.push(rec.marks.at(-1)!.routeFamily);
    }
    // Families, never slugs: `/settings/:agent` and `/user/settings` are both
    // the settings surface, and `/triggers/:agent` has its own family rather
    // than falling into the bucket that means "we do not know".
    expect(seen).toEqual(['home', 'workspace', 'explore', 'settings', 'settings', 'triggers']);
    // The one that matters: no agent name reached the datapoint.
    expect(seen.join(' ')).not.toContain(slug);
  });

  test('exactly one datapoint per request, on every path', async () => {
    for (const request of [
      submit({ note: 'ok' }),
      submit({ note: '' }),
      submit({ note: 'x', screenshotText: 'not a file' }),
    ]) {
      const rec = recorder();
      await routeFeedback(request, ME, rec.deps);
      expect(rec.marks).toHaveLength(1);
    }
  });

  test('a screenshot-refusal marker says a screenshot was carried, and how big the part was', async () => {
    // Every arm that refuses a submission WHICH HAD a screenshot. All of them
    // used to report `hasScreenshot: false` and zero bytes, because the flag was
    // derived from a byte count set only on the accept path — so the screenshot
    // dimensions under-counted exactly the population they describe.
    const png = realPng();
    const forged = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 128 }, () => 0x41)]);
    const arms: { request: Request; reason: FeedbackMarker['rejectReason']; bytes: number }[] = [
      // Named as something else.
      { request: submit({ note: 'x', screenshot: pngPart(png), filename: 'shot.jpg' }), reason: 'bad_content_type', bytes: png.length },
      // Declared PNG, bytes are not.
      { request: submit({ note: 'x', screenshot: pngPart(forged) }), reason: 'malformed', bytes: forged.length },
    ];
    for (const arm of arms) {
      const rec = recorder();
      await routeFeedback(arm.request, ME, rec.deps);
      expect(rec.marks).toHaveLength(1);
      expect(rec.marks[0]).toMatchObject({
        rejectReason: arm.reason, hasScreenshot: true, screenshotBytes: arm.bytes,
      });
    }
    // And the arm that is the deployment's fault rather than the reporter's.
    const noBucket = recorder({ bucket: false });
    await routeFeedback(submit({ note: 'x', screenshot: pngPart(png) }), ME, noBucket.deps);
    expect(noBucket.marks[0]).toMatchObject({
      rejectReason: 'storage_unavailable', hasScreenshot: true, screenshotBytes: png.length,
    });
  });

  test('a note-only report is not credited with a screenshot', async () => {
    const rec = recorder();
    await routeFeedback(submit({ note: 'no image here' }), ME, rec.deps);
    expect(rec.marks[0]).toMatchObject({ outcome: 'accepted', hasScreenshot: false, screenshotBytes: 0 });
  });

  test('a string under the screenshot field name is not a screenshot', async () => {
    const rec = recorder();
    await routeFeedback(submit({ note: 'x', screenshotText: 'not a file' }), ME, rec.deps);
    expect(rec.marks[0]).toMatchObject({
      rejectReason: 'bad_content_type', hasScreenshot: false, screenshotBytes: 0,
    });
  });
});

/**
 * Who a report is ABOUT.
 *
 * The workspace field is a name the browser read off a URL, so it is a caller's
 * string like any other. A report filed against somebody else's workspace is not
 * an access breach — it grants nothing — it is a false row in the one record
 * triage reads to decide whose problem this is, and an audit trail that says an
 * account filed something it never filed.
 *
 * Every arm below asserts the two things that must be true of a refusal: nothing
 * was STORED, and nothing was DISPATCHED — no object, no row, and a marker that
 * says refused rather than accepted.
 */
describe('the workspace a report claims to be about', () => {
  test('a workspace the reporter owns is accepted, and the row carries the authority’s answer', async () => {
    const rec = recorder({ owns: ['checkout-fixes'] });
    const response = await routeFeedback(submit({
      note: 'the exploration tab is blank',
      route: '/workspace/checkout-fixes',
      workspace: 'checkout-fixes',
    }), ME, rec.deps);

    expect(response?.status).toBe(201);
    expect(rec.asked).toEqual([{ userId: ME.userId, workspace: 'checkout-fixes' }]);
    expect(rec.rows[0]?.workspace).toBe('checkout-fixes');
    expect(rec.marks[0]).toMatchObject({ outcome: 'accepted', rejectReason: '' });
  });

  test('a workspace somebody else owns is refused, and nothing is stored or recorded', async () => {
    const rec = recorder({ owns: ['checkout-fixes'] });
    const response = await routeFeedback(submit({
      note: 'filing this against a workspace that is not mine',
      route: '/workspace/someone-elses',
      workspace: 'someone-elses',
      screenshot: pngPart(realPng()),
    }), ME, rec.deps);

    expect(response?.status).toBe(403);
    expect((await replyOf(response!)).error).toMatch(/not one of yours/u);
    expect(rec.rows).toEqual([]);
    // The gate runs BEFORE the bytes are stored, so a refused report never pays
    // for an object that would then have to be cleaned up.
    expect(rec.objects.size).toBe(0);
    expect(rec.deleted).toEqual([]);
    expect(rec.marks).toHaveLength(1);
    expect(rec.marks[0]).toMatchObject({
      outcome: 'rejected',
      rejectReason: 'unowned_workspace',
      // The refusal still says a screenshot was carried, and how big it was.
      hasScreenshot: true,
    });
  });

  test('a refused attribution is answered before the screenshot is even read', async () => {
    const rec = recorder({ owns: [], putThrows: true });
    // The store would THROW if it were reached. It is not: the gate runs before
    // the bytes, so this arm's answer is the attribution refusal rather than the
    // 503 an unreachable bucket produces.
    const response = await routeFeedback(submit({
      note: 'x', route: '/workspace/theirs', workspace: 'theirs', screenshot: pngPart(realPng()),
    }), ME, rec.deps);
    expect(response?.status).toBe(403);
    expect(rec.marks[0]?.rejectReason).toBe('unowned_workspace');
  });

  test('an authority that cannot answer is our outage, said as one, and the report is not filed', async () => {
    const recording = createRecordingLogger();
    setDiagnosticsSink(recording);
    const rec = recorder({ authorityDown: 'the registry did not answer' });
    const response = await routeFeedback(submit({
      note: 'x', route: '/workspace/checkout-fixes', workspace: 'checkout-fixes',
    }), ME, rec.deps);

    // 503 and not 403: the reporter did nothing wrong, and the report is worth
    // sending again in a moment.
    expect(response?.status).toBe(503);
    expect((await replyOf(response!)).error).toMatch(/could not be confirmed/u);
    expect(rec.rows).toEqual([]);
    expect(rec.objects.size).toBe(0);
    expect(rec.marks[0]).toMatchObject({ outcome: 'rejected', rejectReason: 'workspace_unverified' });
    // Recorded with the cause, because an outage nobody can see is an outage
    // that reads as reporters getting their attribution wrong.
    const failure = recording.emitted.find((line) => line.event === 'feedback.workspace_unverified');
    expect(failure?.cause).toContain('the registry did not answer');
  });

  test('a report that names no workspace asks nothing and is filed as it always was', async () => {
    const rec = recorder({ owns: [] });
    const response = await routeFeedback(submit({ note: 'the sign-in page is broken', route: '/' }), ME, rec.deps);

    expect(response?.status).toBe(201);
    // The authority is not asked at all: general feedback is not a claim about
    // anything, and a reporter with no workspaces can still file it.
    expect(rec.asked).toEqual([]);
    expect(rec.rows[0]?.workspace).toBeNull();
    expect(rec.marks[0]).toMatchObject({ outcome: 'accepted', rejectReason: '' });
  });

  test('an empty workspace field is the same as no workspace field', async () => {
    const rec = recorder({ owns: [] });
    const response = await routeFeedback(submit({ note: 'x', route: '/', workspace: '   ' }), ME, rec.deps);
    expect(response?.status).toBe(201);
    expect(rec.asked).toEqual([]);
    expect(rec.rows[0]?.workspace).toBeNull();
  });
});

/**
 * The seam itself: the adapter in `feedback/routes.ts` that turns the policy's
 * question into a read of the reporter's own registry.
 *
 * Driven through `handleFeedbackRequest` rather than by exporting the adapter,
 * because the thing worth holding is that a REQUEST reaches the registry and
 * that a refusal never gets past it. The deployment here has no control plane,
 * so an accepted attribution ends at the row write — which is exactly how this
 * suite tells "got past the gate" from "was refused by it".
 */
interface RegistryStub {
  hasWorkspace(caller: UserCaller, name: string): Promise<boolean>;
}

function registryEnv(options: { owns?: readonly string[]; throws?: string; secret?: boolean }) {
  const asked: { caller: UserCaller; workspace: string }[] = [];
  const ids: string[] = [];
  const stub: RegistryStub = {
    hasWorkspace: async (caller, name) => {
      asked.push({ caller, workspace: name });
      await Promise.resolve();
      if (options.throws !== undefined) throw new Error(options.throws);
      return options.owns?.includes(name) ?? false;
    },
  };
  const env: Partial<FeedbackEnv> = {};
  Object.assign(env, {
    UserDO: {
      idFromName(name: string) { ids.push(name); return name; },
      get() { return stub; },
    },
  });
  // A deployment without the root secret is a real state, and the one that
  // proves an unanswerable question is answered as an outage.
  if (options.secret !== false) env.CREDENTIAL_ENCRYPTION_KEY = 'test-root-secret';
  // SAFETY: this function CONSTRUCTED every member the endpoint reads.
  // `UserDO.idFromName` and `get().hasWorkspace` are the stub above;
  // `CREDENTIAL_ENCRYPTION_KEY` is set on the line above unless the test is
  // about its absence. `FEEDBACK_BUCKET` and `FEEDBACK_MARKERS` are optional and
  // absent by construction — a note-only, analytics-free deployment — and the
  // control-plane binding is absent by construction too, which is what makes
  // `hasControlPlane` refuse the row write the assertions below rely on.
  return { env: env as FeedbackEnv, asked, ids };
}

async function fileAgainst(env: FeedbackEnv, workspace: string): Promise<Response> {
  const response = await handleFeedbackRequest(
    submit({ note: 'x', route: `/workspace/${workspace}`, workspace }), env, ME);
  if (response === null) throw new Error('the feedback endpoint did not answer its own path');
  return response;
}

describe('asking the reporter’s own registry', () => {
  test('a workspace in the registry gets past the gate, asked as the owner', async () => {
    const { env, asked, ids } = registryEnv({ owns: ['checkout-fixes'] });
    const response = await fileAgainst(env, 'checkout-fixes');

    expect(asked.map((one) => one.workspace)).toEqual(['checkout-fixes']);
    // The reporter's OWN registry: the namespace is addressed by their user id,
    // so a name a stranger sends can only ever reach their own rows.
    expect(ids).toEqual([ME.userId]);
    // The OWNER capability and not a workspace token: `UserCaller` is one or the
    // other, and which one it is decides what the registry will answer at all.
    expect(Object.keys(asked[0]?.caller ?? {})).toEqual(['ownerToken']);
    // Past the gate and into the commit point, which this deployment has no
    // control plane for. Not a 403 and not a 503 is the claim.
    expect(response.status).toBe(500);
  });

  test('a name the registry does not hold is refused, whoever else holds it', async () => {
    const { env, asked } = registryEnv({ owns: ['checkout-fixes'] });
    const absent = await fileAgainst(env, 'no-such-workspace');
    // The read is scoped to the reporter's own registry, so "somebody else's"
    // and "nobody's" are not two answers here — they are the same missing row,
    // and the endpoint therefore enumerates nothing for a caller sending names.
    const theirs = await fileAgainst(env, 'owned-by-another');
    expect([absent.status, theirs.status]).toEqual([403, 403]);
    expect(await replyOf(absent)).toEqual(await replyOf(theirs));
    expect(asked.map((one) => one.workspace)).toEqual(['no-such-workspace', 'owned-by-another']);
  });

  test('a name the registry could never hold is refused without asking it', async () => {
    const { env, asked } = registryEnv({ owns: ['checkout-fixes'] });
    // Path traversal, spaces, and a name past the 64-character bound: none of
    // these is a workspace name, and `hasWorkspace` THROWS on each. Asking would
    // turn a caller's typo into something no caller can tell from an outage.
    for (const name of ['../secrets', 'has spaces', 'w'.repeat(65), 'semi;colon']) {
      expect((await fileAgainst(env, name)).status).toBe(403);
    }
    expect(asked).toEqual([]);
  });

  test('a registry that throws is an outage, not a refusal', async () => {
    const { env } = registryEnv({ owns: ['checkout-fixes'], throws: 'the durable object is not there' });
    const response = await fileAgainst(env, 'checkout-fixes');
    expect(response.status).toBe(503);
    expect((await replyOf(response)).error).toMatch(/could not be confirmed/u);
  });

  test('a deployment with no owner capability cannot ask, and says so', async () => {
    const { env, asked } = registryEnv({ owns: ['checkout-fixes'], secret: false });
    const response = await fileAgainst(env, 'checkout-fixes');
    // The registry is never reached: there is no capability to ask with. That is
    // our configuration, so it is a 503 and not the reporter's 403.
    expect(response.status).toBe(503);
    expect(asked).toEqual([]);
  });

  test('a report naming no workspace is answered without the registry at all', async () => {
    const { env, asked, ids } = registryEnv({ owns: [] });
    const response = await handleFeedbackRequest(
      submit({ note: 'the sign-in page is broken', route: '/' }), env, ME);
    // Past the gate, into the same absent control plane.
    expect(response?.status).toBe(500);
    expect(asked).toEqual([]);
    expect(ids).toEqual([]);
  });
});
