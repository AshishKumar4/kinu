/**
 * The sidecar's half of the daemon control socket, and the stage it reads.
 *
 * TWO OPS, BOTH AGREED WITH THE DAEMON LANE (2026-09-02): `fence` closes
 * admission, stages the dirty windows and answers the cut with the five
 * counters the fence itself measured; `boundaries` hands the chunk boundaries
 * of the files a generation rewrote BACK to the daemon after that generation's
 * head CAS, so the next fence can stage windows instead of whole files.
 *
 * WHY `boundaries` MERGES. A full boundary map is O(total extents) — one
 * 64 MiB file is about 16,000 offsets — so re-sending it per publish would put
 * an O(n) term back into the path this design just made O(k). The request
 * therefore carries only the files this generation changed plus the paths it
 * dropped; the daemon merges by ino and path and replaces only the base.
 *
 * WHY THIS IS NOT `capture/journal/client.ts`. That client is the capture
 * plane's: it fences on behalf of a Durable Object operation and hands back an
 * AuditedCapture of a whole tree. The sidecar speaks the v2 ops instead and
 * consumes a delta manifest, and the daemon lane owns the other file. One wire,
 * two consumers, and the framing below is deliberately the same shape.
 */

import { connect } from 'node:net';
import { open, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as v from 'valibot';

import { BeneathRoot } from '../../src/native-openat2';
import { SealWorkSchema } from '../../src/durability/contracts';
import { parseDeltaManifest } from '../../src/candidates/merkle-pack/delta';
import type { BoundaryHandback, DeltaManifestV2 } from '../../src/candidates/merkle-pack/delta';
import type { DeltaStage } from '../../src/candidates/merkle-pack/build-v2';

import type { SidecarDaemon, SidecarFence } from './core';

const NonEmpty = v.pipe(v.string(), v.minLength(1));
const Count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const Decimal = v.pipe(v.string(), v.regex(/^(?:0|[1-9]\d*)$/));
const Hex64 = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));

const FenceReplySchema = v.strictObject({
  id: NonEmpty,
  ok: v.literal(true),
  cut: Count,
  generation: Count,
  manifestPath: NonEmpty,
  baseCut: v.optional(Decimal),
  baseGeneration: v.optional(Decimal),
  baseRoot: v.optional(Hex64),
  sealWork: SealWorkSchema,
});
const BoundariesReplySchema = v.strictObject({
  id: NonEmpty,
  ok: v.literal(true),
  boundaryFiles: Count,
});
const RefusalSchema = v.strictObject({ id: NonEmpty, ok: v.literal(false), error: NonEmpty });

/** One NDJSON request per connection, with the id echoed back. The reply is
 *  parsed at this boundary; each reply schema below states the record it
 *  accepts, so nothing leaves here unparsed. */

/** The request wire record: an id, an op, and the op's own fields. */
const ControlRequestSchema = v.looseObject({ id: NonEmpty });
type ControlRequest = v.InferOutput<typeof ControlRequestSchema>;

async function request(socketPath: string, body: ControlRequest): Promise<ControlRequest> {
  return await new Promise<ControlRequest>((settle, refuse) => {
    const socket = connect(socketPath);
    let received = '';
    let done = false;
    const fail = (error: Error): void => {
      if (done) return;
      done = true;
      refuse(error);
    };
    socket.setEncoding('utf8');
    socket.once('error', (error: Error) => fail(error));
    socket.on('data', (chunk: string) => {
      received += chunk;
      const newline = received.indexOf('\n');
      if (newline < 0) return;
      socket.end();
      if (done) return;
      done = true;
      try {
        const parsed = v.parse(v.looseObject({ id: NonEmpty }), JSON.parse(received.slice(0, newline)));
        settle(parsed);
      } catch (error) {
        fail(new Error('journal control response is not a valid JSON record', { cause: error }));
      }
    });
    socket.once('connect', () => socket.write(`${JSON.stringify(body)}\n`));
    socket.once('close', () => fail(new Error('journal control closed before a complete response')));
  });
}

function reply<T extends { readonly id: string }>(
  schema: v.GenericSchema<unknown, T>,
  id: string,
  raw: ControlRequest,
  op: string,
): T {
  const refusal = v.safeParse(RefusalSchema, raw);
  if (refusal.success) {
    if (refusal.output.id !== id) throw new Error(`journal ${op} answered another request`);
    throw new Error(`journal ${op} failed: ${refusal.output.error}`);
  }
  const parsed = v.parse(schema, raw);
  if (parsed.id !== id) throw new Error(`journal ${op} answered another request`);
  return parsed;
}

export class SidecarDaemonClient implements SidecarDaemon {
  constructor(private readonly socketPath: string) {}

  async fence(): Promise<SidecarFence> {
    const id = crypto.randomUUID();
    const answer = reply(FenceReplySchema, id, await request(this.socketPath, { id, op: 'fence' }), 'fence');
    const seeded = [answer.baseCut, answer.baseGeneration, answer.baseRoot];
    if (seeded.some((value) => value === undefined) && seeded.some((value) => value !== undefined)) {
      throw new Error('journal fence has an incomplete base identity');
    }
    return {
      cut: answer.cut,
      generation: answer.generation,
      manifestPath: answer.manifestPath,
      base: answer.baseCut === undefined
        ? null
        : { cut: answer.baseCut, generation: answer.baseGeneration!, root: answer.baseRoot! },
      sealWork: answer.sealWork,
    };
  }

  async manifest(path: string): Promise<DeltaManifestV2> {
    return parseDeltaManifest(await readFile(path));
  }

  async boundaries(handback: BoundaryHandback): Promise<number> {
    const id = crypto.randomUUID();
    const answer = reply(
      BoundariesReplySchema,
      id,
      await request(this.socketPath, {
        id,
        op: 'boundaries',
        cut: handback.cut,
        generation: handback.generation,
        root: handback.root,
        maxChunkBytes: handback.maxChunkBytes,
        files: handback.files.map((file) => ({
          ino: file.ino,
          path: file.path,
          size: file.size,
          boundaries: [...file.boundaries],
        })),
        removed: [...handback.removed],
      }),
      'boundaries',
    );
    return answer.boundaryFiles;
  }
}

/**
 * The staged windows, read beneath the stage root. A staged file is sparse:
 * only the windows the fence copied are present, which is exactly the set the
 * manifest's ranges name, so a read outside them is a defect rather than a
 * hole to tolerate.
 */
export class SidecarStage implements DeltaStage {
  readonly #root: BeneathRoot;

  constructor(stageRoot: string) {
    this.#root = new BeneathRoot(resolve(stageRoot));
  }

  async read(path: string, offset: number, length: number): Promise<Uint8Array> {
    return this.#root.readRange(path, offset, length);
  }

  close(): void {
    this.#root.close();
  }
}

/**
 * The WAL tail, as the seal cadence reads it: how many bytes of writes the
 * daemon has recorded since the last seal. `W <ino> <path> <offset> <length>`
 * is one write, and the length is the byte count the trigger sums; every other
 * record is a metadata op and contributes nothing to the eight-MiB threshold.
 */
/** Node raises `Error` subclasses with an errno `code` on system-call
 *  failures; this narrows without an assertion. */
export interface WalProgress {
  readonly offset: number;
  readonly dirtyBytes: number;
}

export async function readWalProgress(walPath: string, fromOffset: number): Promise<WalProgress> {
  let facts: { readonly size: number } | null = null;
  try {
    facts = await stat(walPath);
  } catch (error) {
    // A WAL that does not exist yet holds no records: the daemon has not
    // written one since the mount. Anything else is a real stat failure.
    if (!(error instanceof Error && 'code' in error)) throw error;
    if (error.code !== 'ENOENT') throw error;
  }
  if (facts === null || facts.size <= fromOffset) return { offset: fromOffset, dirtyBytes: 0 };
  const handle = await open(walPath, 'r');
  try {
    const length = facts.size - fromOffset;
    const buffer = new Uint8Array(length);
    await handle.read(buffer, 0, length, fromOffset);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    // A partial trailing line belongs to the next read, so the offset advances
    // only over the lines that are complete.
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline < 0) return { offset: fromOffset, dirtyBytes: 0 };
    let dirtyBytes = 0;
    for (const line of text.slice(0, lastNewline).split('\n')) {
      const parts = line.split(' ');
      if (parts[0] !== 'W' || parts.length < 5) continue;
      const bytes = Number(parts[4]);
      if (Number.isSafeInteger(bytes) && bytes > 0) dirtyBytes += bytes;
    }
    return { offset: fromOffset + Buffer.byteLength(text.slice(0, lastNewline + 1)), dirtyBytes };
  } finally {
    await handle.close();
  }
}
