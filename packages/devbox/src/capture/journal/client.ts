import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { resolve } from 'node:path';

import * as v from 'valibot';
import { BeneathRoot } from '../../native-openat2';

import { journalDaemonArgv, type JournalDaemonPaths } from './command';
import { issueVerifiedJournalCapture, manifestSha256 } from '../model';
import type { AuditedCapture, CapturedCutIdentity, NodeEntry, NodeKind, SealedContentReader } from '../model';

const NonEmptyString = v.pipe(v.string(), v.minLength(1));
const SafeNumber = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const Digest = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const ExtentSchema = v.strictObject({ offset: SafeNumber, length: v.pipe(SafeNumber, v.minValue(1)), sha256: Digest });
const ContentSchema = v.strictObject({ kind: v.literal('sealed'), size: SafeNumber, sourceId: NonEmptyString, extents: v.array(ExtentSchema) });
const Nanoseconds = v.pipe(v.string(), v.regex(/^(?:0|[1-9]\d*)$/));
const XattrValue = v.pipe(v.string(), v.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/));
const PosixMetadataSchema = v.strictObject({
  uid: SafeNumber,
  gid: SafeNumber,
  atimeNs: Nanoseconds,
  mtimeNs: Nanoseconds,
  ctimeNs: Nanoseconds,
  xattrs: v.record(v.string(), XattrValue),
});
const EntrySchema = v.strictObject({
  path: NonEmptyString,
  kind: v.picklist(['file', 'dir', 'symlink'] as const),
  mode: SafeNumber,
  ino: v.pipe(SafeNumber, v.minValue(1)),
  metadata: PosixMetadataSchema,
  target: v.optional(NonEmptyString),
  content: v.optional(ContentSchema),
});
const ManifestSchema = v.strictObject({ cut: SafeNumber, generation: SafeNumber, stageRoot: NonEmptyString, entries: v.array(EntrySchema) });
const ControlResponseSchema = v.strictObject({
  id: NonEmptyString,
  ok: v.boolean(),
  error: v.optional(NonEmptyString),
  cut: v.optional(SafeNumber),
  generation: v.optional(SafeNumber),
  manifestPath: v.optional(NonEmptyString),
  baseCut: v.optional(Nanoseconds),
  baseGeneration: v.optional(Nanoseconds),
  baseRoot: v.optional(Digest),
});

type ControlResponse = v.InferOutput<typeof ControlResponseSchema>;

/** The immutable published head a journal WAL starts from. */
export interface JournalBase {
  readonly cut: string;
  readonly generation: string;
  readonly root: string;
}

/** One line on the daemon's AF_UNIX control socket; `id` must echo back. */
interface ControlRequest {
  readonly id: string;
  readonly op: 'base' | 'fence';
  readonly cut?: string;
  readonly generation?: string;
  readonly root?: string;
}

export interface JournalFence {
  readonly cut: number;
  readonly generation: number;
  readonly manifestPath: string;
  readonly base: JournalBase | null;
}

export interface JournalDaemonStartOptions extends JournalDaemonPaths {
  readonly signal?: AbortSignal;
}

export interface StartedJournalDaemon {
  readonly process: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  readonly client: JournalDaemonClient;
}

function decodeEntry(entry: v.InferOutput<typeof EntrySchema>): NodeEntry {
  const kind: NodeKind = entry.kind;
  if (kind === 'file') {
    if (!entry.content || entry.target !== undefined) throw new Error(`journal file ${entry.path} has invalid metadata`);
    return { path: entry.path, kind, mode: entry.mode, ino: entry.ino, metadata: entry.metadata, content: entry.content };
  }
  if (kind === 'symlink') {
    if (entry.content !== undefined || entry.target === undefined) throw new Error(`journal symlink ${entry.path} has invalid metadata`);
    return { path: entry.path, kind, mode: entry.mode, ino: entry.ino, metadata: entry.metadata, target: entry.target };
  }
  if (entry.content !== undefined || entry.target !== undefined) throw new Error(`journal directory ${entry.path} has invalid metadata`);
  return { path: entry.path, kind, mode: entry.mode, ino: entry.ino, metadata: entry.metadata };
}

function stagedReader(stageRoot: string): SealedContentReader {
  const root = new BeneathRoot(resolve(stageRoot));
  return {
    async read(sourceId, offset, length) {
      return root.readRange(sourceId, offset, length);
    },
  };
}

async function request(socketPath: string, body: ControlRequest, signal?: AbortSignal): Promise<ControlResponse> {
  if (signal?.aborted) throw signal.reason;
  return await new Promise<ControlResponse>((resolveRequest, reject) => {
    const socket = connect(socketPath);
    let received = '';
    let settled = false;
    const settle = (resolve: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const fail = (error: Error): void => settle(() => reject(error));
    const abort = () => socket.destroy(signal?.reason instanceof Error ? signal.reason : new Error('journal request aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    socket.setEncoding('utf8');
    socket.once('error', (error) => fail(error));
    socket.on('data', (chunk: string) => {
      received += chunk;
      const newline = received.indexOf('\n');
      if (newline < 0) return;
      socket.end();
      try {
        const response = v.parse(ControlResponseSchema, JSON.parse(received.slice(0, newline)));
        settle(() => resolveRequest(response));
      } catch (error) {
        fail(new Error('journal control response is invalid', { cause: error }));
      }
    });
    socket.once('connect', () => socket.write(`${JSON.stringify(body)}\n`));
    socket.once('close', () => {
      if (!settled) fail(new Error('journal control closed before a complete response'));
    });
  });
}

export class JournalDaemonClient {
  constructor(readonly socket: string) {}

  async seed(base: JournalBase, signal?: AbortSignal): Promise<void> {
    const id = crypto.randomUUID();
    const response = await request(this.socket, { id, op: 'base', ...base }, signal);
    if (response.id !== id) throw new Error('journal control response id mismatch');
    if (!response.ok) throw new Error(`journal base seed failed: ${response.error ?? 'malformed response'}`);
  }

  async fence(signal?: AbortSignal): Promise<JournalFence> {
    const id = crypto.randomUUID();
    const response = await request(this.socket, { id, op: 'fence' }, signal);
    if (response.id !== id) throw new Error('journal control response id mismatch');
    if (!response.ok || response.cut === undefined || response.generation === undefined || response.manifestPath === undefined) {
      throw new Error(`journal fence failed: ${response.error ?? 'malformed response'}`);
    }
    const seeded = [response.baseCut, response.baseGeneration, response.baseRoot];
    if (response.baseCut === undefined) {
      if (!seeded.every((value) => value === undefined)) throw new Error('journal fence has an incomplete base identity');
      return { cut: response.cut, generation: response.generation, manifestPath: response.manifestPath, base: null };
    }
    if (response.baseGeneration === undefined || response.baseRoot === undefined) {
      throw new Error('journal fence has an incomplete base identity');
    }
    return {
      cut: response.cut,
      generation: response.generation,
      manifestPath: response.manifestPath,
      base: { cut: response.baseCut, generation: response.baseGeneration, root: response.baseRoot },
    };
  }
}

export function startJournalDaemon(options: JournalDaemonStartOptions): StartedJournalDaemon {
  const argv = [...journalDaemonArgv(options)];
  const process = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', signal: options.signal });
  return { process, client: new JournalDaemonClient(resolve(options.socket)) };
}

export async function captureFromJournalFence(fence: JournalFence, identity: CapturedCutIdentity): Promise<AuditedCapture> {
  const bytes = await readFile(fence.manifestPath);
  const manifest = v.parse(ManifestSchema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (manifest.cut !== fence.cut || manifest.generation !== fence.generation) throw new Error('journal manifest is not the fenced manifest');
  const entries = manifest.entries.map(decodeEntry);
  return issueVerifiedJournalCapture({
    cut: manifest.cut,
    generation: manifest.generation,
    entries,
    identity,
    sealedReader: stagedReader(manifest.stageRoot),
    manifestSha256: manifestSha256({ mechanism: 'mutation-journal', cut: manifest.cut, generation: manifest.generation, entries }),
  });
}
