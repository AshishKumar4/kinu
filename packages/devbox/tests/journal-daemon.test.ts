import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';

import { captureFromJournalFence, JournalDaemonClient, readJournalDelta } from '../src/capture/journal/client';
import type { JournalFence } from '../src/capture/journal/client';
import { sha256Hex } from '../src/cas/hash';
import { readCaptureRange, requireAuditedCapture } from '../src/capture/model';

const dirs: string[] = [];

const metadata = () => ({ uid: 1000, gid: 1000, atimeNs: '1', mtimeNs: '2', ctimeNs: '3', xattrs: {} });
/** What a v2 fence answers with; the client refuses a reply without it. */
const NO_WORK = { bytesStaged: 0, bytesChunked: 0, chunksHashed: 0, nodesRewritten: 0, wholeFiles: 0 };
afterEach(async () => await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function fixture(): Promise<{ dir: string; socket: string; manifest: string; stage: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'journal-client-'));
  dirs.push(dir);
  const stage = join(dir, 'stage');
  return { dir, socket: join(dir, 'control.sock'), manifest: join(dir, 'fence-7.json'), stage };
}

const ControlRequestSchema = v.strictObject({ id: v.string(), op: v.string() });
/**
 * A boundary hand-back as the wire carries it. The request-shape tests are
 * about these exact fields, so the schema is the contract they assert against
 * rather than an untyped dictionary.
 */
const SentBoundariesSchema = v.object({
  id: v.string(),
  op: v.string(),
  cut: v.optional(v.string()),
  generation: v.optional(v.string()),
  root: v.optional(v.string()),
  maxChunkBytes: v.optional(v.number()),
  files: v.optional(v.array(v.object({
    ino: v.string(),
    path: v.string(),
    size: v.number(),
    boundaries: v.array(v.number()),
  }))),
  removed: v.optional(v.array(v.string())),
});
type SentBoundaries = v.InferOutput<typeof SentBoundariesSchema>;

async function control(socket: string, reply: (request: { id: string; op: string }) => object): Promise<() => Promise<void>> {
  const server = createServer((connection) => {
    let text = '';
    connection.setEncoding('utf8');
    connection.on('data', (chunk: string) => {
      text += chunk;
      const newline = text.indexOf('\n');
      if (newline >= 0) connection.end(`${JSON.stringify(reply(v.parse(ControlRequestSchema, JSON.parse(text.slice(0, newline)))))}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(socket, resolve));
  return async () => await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

/** A control server that records what it was sent, for the request-shape tests. */
async function recording(socket: string, reply: (request: SentBoundaries) => object): Promise<{
  close: () => Promise<void>;
  seen: () => readonly SentBoundaries[];
}> {
  const requests: SentBoundaries[] = [];
  const server = createServer((connection) => {
    let text = '';
    connection.setEncoding('utf8');
    connection.on('data', (chunk: string) => {
      text += chunk;
      const newline = text.indexOf('\n');
      if (newline < 0) return;
      const parsed = v.parse(SentBoundariesSchema, JSON.parse(text.slice(0, newline)));
      requests.push(parsed);
      connection.end(`${JSON.stringify(reply(parsed))}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(socket, resolve));
  return {
    close: async () => await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
    seen: () => requests,
  };
}

describe('JournalDaemonClient', () => {
  test('issues a sealed capture and streams only its requested range', async () => {
    const { socket, manifest, stage } = await fixture();
    const bytes = new TextEncoder().encode('hello sealed journal');
    await mkdir(stage);
    await writeFile(join(stage, 'a.extent'), bytes);
    const digest = sha256Hex(bytes);
    await writeFile(manifest, JSON.stringify({
      cut: 7, generation: 3, stageRoot: stage,
      entries: [
        { path: 'dir', kind: 'dir', mode: 0o755, ino: 1, metadata: metadata() },
        { path: 'dir/a', kind: 'file', mode: 0o644, ino: 2, metadata: metadata(), content: { kind: 'sealed', size: bytes.byteLength, sourceId: 'a.extent', extents: [{ offset: 0, length: bytes.byteLength, sha256: digest }] } },
      ],
    }));
    const close = await control(socket, (request) => ({ id: request.id, ok: true, cut: 7, generation: 3, manifestPath: manifest, sealWork: NO_WORK }));
    try {
      const fence = await new JournalDaemonClient(socket).fence();
      const capture = await captureFromJournalFence(fence, { captureId: 'capture-7', epoch: '3', baseRevision: '3', stableStageHandle: 'fence-7' });
      const entry = capture.entries[1]!;
      expect(requireAuditedCapture(capture).capturedCut.cut).toBe('7');
      expect(new TextDecoder().decode(await readCaptureRange(capture, entry, 6, 6))).toBe('sealed');
    } finally {
      await close();
    }
  });

  test('refuses a journal manifest that omits POSIX metadata', async () => {
    const { socket, manifest, stage } = await fixture();
    await mkdir(stage);
    await writeFile(manifest, JSON.stringify({
      cut: 8, generation: 3, stageRoot: stage,
      entries: [{ path: 'a', kind: 'file', mode: 0o644, ino: 1, content: { kind: 'sealed', size: 0, sourceId: 'extent', extents: [] } }],
    }));
    const close = await control(socket, (request) => ({ id: request.id, ok: true, cut: 8, generation: 3, manifestPath: manifest, sealWork: NO_WORK }));
    try {
      await expect(captureFromJournalFence(await new JournalDaemonClient(socket).fence(), {
        captureId: 'capture-8', epoch: '3', baseRevision: '3', stableStageHandle: 'fence-8',
      })).rejects.toThrow();
    } finally {
      await close();
    }
  });

  test('refuses a stage extent changed after its fence manifest', async () => {
    const { socket, manifest, stage } = await fixture();
    await mkdir(stage);
    const original = new TextEncoder().encode('sealed');
    await writeFile(join(stage, 'extent'), original);
    await writeFile(manifest, JSON.stringify({
      cut: 8, generation: 3, stageRoot: stage,
      entries: [{ path: 'a', kind: 'file', mode: 0o644, ino: 1, metadata: metadata(), content: { kind: 'sealed', size: original.byteLength, sourceId: 'extent', extents: [{ offset: 0, length: original.byteLength, sha256: sha256Hex(original) }] } }],
    }));
    const close = await control(socket, (request) => ({ id: request.id, ok: true, cut: 8, generation: 3, manifestPath: manifest, sealWork: NO_WORK }));
    try {
      const capture = await captureFromJournalFence(await new JournalDaemonClient(socket).fence(), { captureId: 'capture-8', epoch: '3', baseRevision: '3', stableStageHandle: 'fence-8' });
      await writeFile(join(stage, 'extent'), 'mutated');
      await expect(readCaptureRange(capture, capture.entries[0]!, 0, original.byteLength)).rejects.toThrow('integrity verification');
    } finally {
      await close();
    }
  });

  test('refuses a stage source swapped to a symlink', async () => {
    const { socket, manifest, stage } = await fixture();
    await mkdir(stage);
    const original = new TextEncoder().encode('sealed');
    await writeFile(join(stage, 'extent'), original);
    await writeFile(manifest, JSON.stringify({
      cut: 9, generation: 3, stageRoot: stage,
      entries: [{ path: 'a', kind: 'file', mode: 0o644, ino: 1, metadata: metadata(), content: { kind: 'sealed', size: original.byteLength, sourceId: 'extent', extents: [{ offset: 0, length: original.byteLength, sha256: sha256Hex(original) }] } }],
    }));
    const close = await control(socket, (request) => ({ id: request.id, ok: true, cut: 9, generation: 3, manifestPath: manifest, sealWork: NO_WORK }));
    try {
      const capture = await captureFromJournalFence(await new JournalDaemonClient(socket).fence(), { captureId: 'capture-9', epoch: '3', baseRevision: '3', stableStageHandle: 'fence-9' });
      await rm(join(stage, 'extent'));
      await symlink('/etc/passwd', join(stage, 'extent'));
      await expect(readCaptureRange(capture, capture.entries[0]!, 0, original.byteLength)).rejects.toThrow('openat2 refused');
    } finally {
      await close();
    }
  });

  test('refuses a source path outside the sealed stage', async () => {
    const { socket, manifest, stage } = await fixture();
    await mkdir(stage);
    await writeFile(manifest, JSON.stringify({
      cut: 2, generation: 1, stageRoot: stage,
      entries: [{ path: 'a', kind: 'file', mode: 0o644, ino: 1, metadata: metadata(), content: { kind: 'sealed', size: 1, sourceId: '../escape', extents: [{ offset: 0, length: 1, sha256: '0'.repeat(64) }] } }],
    }));
    const close = await control(socket, (request) => ({ id: request.id, ok: true, cut: 2, generation: 1, manifestPath: manifest, sealWork: NO_WORK }));
    try {
      const capture = await captureFromJournalFence(await new JournalDaemonClient(socket).fence(), { captureId: 'capture-2', epoch: '1', baseRevision: '1', stableStageHandle: 'fence-2' });
      await expect(readCaptureRange(capture, capture.entries[0]!, 0, 1)).rejects.toThrow('non-relative path');
    } finally {
      await close();
    }
  });

  test('a fence reply without its seal counters is refused', async () => {
    const { socket, manifest } = await fixture();
    const close = await control(socket, (request) => ({ id: request.id, ok: true, cut: 4, generation: 1, manifestPath: manifest }));
    try {
      await expect(new JournalDaemonClient(socket).fence()).rejects.toThrow('journal fence failed');
    } finally {
      await close();
    }
  });
});

/** One delta manifest and the stage it names, as a v2 fence writes them. */
async function deltaFixture(): Promise<{ fence: JournalFence; stage: string; bytes: Uint8Array }> {
  const { manifest, stage } = await fixture();
  const bytes = new TextEncoder().encode('one delta of dirty bytes');
  await mkdir(join(stage, 'src'), { recursive: true });
  await writeFile(join(stage, 'src', 'a.txt'), bytes);
  const sealWork = { bytesStaged: bytes.byteLength, bytesChunked: 0, chunksHashed: 0, nodesRewritten: 0, wholeFiles: 1 };
  await writeFile(manifest, JSON.stringify({
    version: 2,
    cut: 11,
    generation: 2,
    stageRoot: stage,
    base: { cut: '7', generation: '1', root: 'a'.repeat(64) },
    entries: [
      { path: 'src', kind: 'dir', ino: '10', mode: 0o755, uid: 0, gid: 0, atimeNs: '1', mtimeNs: '2', ctimeNs: '3', xattrs: {} },
      {
        path: 'src/a.txt', kind: 'file', ino: '11', mode: 0o644, uid: 0, gid: 0,
        atimeNs: '1', mtimeNs: '2', ctimeNs: '3', xattrs: {},
        size: bytes.byteLength, whole: true,
        dirty: [{ offset: 0, length: bytes.byteLength }],
        ranges: [{ offset: 0, length: bytes.byteLength, sha256: sha256Hex(bytes) }],
      },
    ],
    metadataOps: [{ sequence: 9, op: 'create', path: 'src/a.txt', argument: '', result: 0 }],
    sealWork,
  }));
  return {
    fence: { cut: 11, generation: 2, manifestPath: manifest, base: { cut: '7', generation: '1', root: 'a'.repeat(64) }, sealWork },
    stage,
    bytes,
  };
}

describe('the v2 delta manifest', () => {
  test('is read with its dirty runs, its staged runs and its operations', async () => {
    const { fence, bytes } = await deltaFixture();
    const delta = await readJournalDelta(fence);
    const entry = delta.manifest.entries[1]!;
    expect(delta.manifest.version).toBe(2);
    expect(delta.manifest.base?.root).toBe('a'.repeat(64));
    expect(entry.dirty).toEqual([{ offset: 0, length: bytes.byteLength }]);
    expect(delta.manifest.metadataOps[0]?.op).toBe('create');
    expect(delta.manifest.sealWork.bytesStaged).toBe(bytes.byteLength);
    expect(new TextDecoder().decode(await delta.stage.read(entry.path, entry.ranges[0]!.offset, entry.ranges[0]!.length))).toBe('one delta of dirty bytes');
  });

  test('refuses staged bytes changed after the fence wrote them', async () => {
    const { fence, stage } = await deltaFixture();
    const delta = await readJournalDelta(fence);
    const entry = delta.manifest.entries[1]!;
    await writeFile(join(stage, 'src', 'a.txt'), 'a different delta bytes!');
    await expect(delta.stage.read(entry.path, entry.ranges[0]!.offset, entry.ranges[0]!.length)).rejects.toThrow('integrity verification');
  });

  test('refuses a manifest that is not the fence that asked for it', async () => {
    const { fence } = await deltaFixture();
    await expect(readJournalDelta({ ...fence, cut: 12 })).rejects.toThrow('not the fenced manifest');
  });

  test('is refused by name when read as a whole tree', async () => {
    const { fence } = await deltaFixture();
    await expect(captureFromJournalFence(fence, {
      captureId: 'capture-11', epoch: '2', baseRevision: '2', stableStageHandle: 'fence-11',
    })).rejects.toThrow('version 2 is a delta');
  });
});

describe('the boundary hand-back', () => {
  test('sends the published head, the CDC parameter and only the changed files', async () => {
    const { socket } = await fixture();
    const server = await recording(socket, (request) => ({ id: request.id, ok: true, boundaryFiles: 1 }));
    try {
      const merged = await new JournalDaemonClient(socket).boundaries({
        cut: '11', generation: '2', root: 'b'.repeat(64),
        maxChunkBytes: 65536,
        files: [{ ino: '11', path: 'src/a.txt', size: 24, boundaries: [0, 24] }],
        removed: ['src/gone.txt'],
      });
      expect(merged).toBe(1);
      const sent = server.seen()[0]!;
      expect(sent.op).toBe('boundaries');
      expect(sent.cut).toBe('11');
      expect(sent.generation).toBe('2');
      expect(sent.root).toBe('b'.repeat(64));
      expect(sent.maxChunkBytes).toBe(65536);
      expect(sent.files).toEqual([{ ino: '11', path: 'src/a.txt', size: 24, boundaries: [0, 24] }]);
      expect(sent.removed).toEqual(['src/gone.txt']);
    } finally {
      await server.close();
    }
  });

  test('refuses a daemon that merged a different number of files', async () => {
    const { socket } = await fixture();
    const server = await recording(socket, (request) => ({ id: request.id, ok: true, boundaryFiles: 0 }));
    try {
      await expect(new JournalDaemonClient(socket).boundaries({
        cut: '11', generation: '2', root: 'b'.repeat(64),
        maxChunkBytes: 65536,
        files: [{ ino: '11', path: 'src/a.txt', size: 24, boundaries: [0, 24] }],
        removed: [],
      })).rejects.toThrow('merged 0 boundary files, sent 1');
    } finally {
      await server.close();
    }
  });

  test('refuses a daemon that turned the hand-back down', async () => {
    const { socket } = await fixture();
    const server = await recording(socket, (request) => ({ id: request.id, ok: false, error: 'Numerical result out of range' }));
    try {
      await expect(new JournalDaemonClient(socket).boundaries({
        cut: '3', generation: '1', root: 'c'.repeat(64),
        maxChunkBytes: 65536,
        files: [],
        removed: [],
      })).rejects.toThrow('Numerical result out of range');
    } finally {
      await server.close();
    }
  });
});
