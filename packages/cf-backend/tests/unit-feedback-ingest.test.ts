// Behaviour of POST /api/feedback: what it refuses, what it stores, and what it
// cleans up when the store and the row disagree.
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
}

function recorder(options: {
  bucket?: boolean;
  rowError?: string;
  deleteThrows?: boolean;
  putThrows?: boolean;
} = {}): Recorder {
  const objects = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  const rows: FeedbackRecord[] = [];
  const marks: FeedbackMarker[] = [];
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
    mark: (marker) => { marks.push(marker); },
    newId: () => { minted += 1; return `id-${String(minted)}`; },
    now: () => 1_700_000_000_000,
  };
  return { deps, objects, deleted, rows, marks };
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

  test('a store that refuses the write never produces a row pointing at nothing', async () => {
    const rec = recorder({ putThrows: true });
    await expect(routeFeedback(
      submit({ note: 'x', screenshot: pngPart(realPng()) }), ME, rec.deps)).rejects.toThrow('R2 refused');
    expect(rec.rows).toEqual([]);
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
});
