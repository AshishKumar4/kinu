import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';

import { captureFromJournalFence, JournalDaemonClient } from '../src/capture/journal/client';
import { sha256Hex } from '../src/cas/hash';
import { readCaptureRange, requireAuditedCapture } from '../src/capture/model';

const dirs: string[] = [];

const metadata = () => ({ uid: 1000, gid: 1000, atimeNs: '1', mtimeNs: '2', ctimeNs: '3', xattrs: {} });
afterEach(async () => await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function fixture(): Promise<{ dir: string; socket: string; manifest: string; stage: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'journal-client-'));
  dirs.push(dir);
  const stage = join(dir, 'stage');
  return { dir, socket: join(dir, 'control.sock'), manifest: join(dir, 'fence-7.json'), stage };
}

const ControlRequestSchema = v.strictObject({ id: v.string(), op: v.string() });

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
    const close = await control(socket, (request) => ({ id: request.id, ok: true, cut: 7, generation: 3, manifestPath: manifest }));
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
    const close = await control(socket, (request) => ({ id: request.id, ok: true, cut: 8, generation: 3, manifestPath: manifest }));
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
    const close = await control(socket, (request) => ({ id: request.id, ok: true, cut: 8, generation: 3, manifestPath: manifest }));
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
    const close = await control(socket, (request) => ({ id: request.id, ok: true, cut: 9, generation: 3, manifestPath: manifest }));
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
    const close = await control(socket, (request) => ({ id: request.id, ok: true, cut: 2, generation: 1, manifestPath: manifest }));
    try {
      const capture = await captureFromJournalFence(await new JournalDaemonClient(socket).fence(), { captureId: 'capture-2', epoch: '1', baseRevision: '1', stableStageHandle: 'fence-2' });
      await expect(readCaptureRange(capture, capture.entries[0]!, 0, 1)).rejects.toThrow('non-relative path');
    } finally {
      await close();
    }
  });
});
