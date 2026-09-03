/**
 * The sidecar process: one per container, started beside the daemon, alive for
 * the life of the box.
 *
 * WHY A PROCESS AT ALL, and why only one. Every checkpoint used to spawn `bun`
 * inside the container to fence once and exit, and every restore spawned
 * another; at a two-second seal cadence that spawn IS the cost. This entry is
 * deliberately thin — argv, ports, loop — because everything that decides
 * anything lives in modules that run in-process under test: `sidecar/core.ts`
 * seals and publishes, `sidecar/seal-loop.ts` owns the cadence, and
 * `merkle-pack/*` owns the tree.
 *
 * WHAT IT MOVES, AND WHERE. Payload bytes go directly over the R2 HTTP
 * endpoint the SDK intercepts — one single PUT per pack, each held to the ETag
 * of the body the store took — never through the Durable Object and never
 * through the s3fs mount (measured 2026-09-02: direct HTTP moves 95–146 MiB/s
 * at 1 MiB × 16–64 in flight, s3fs 30 MiB/s at the same cell). Control travels
 * as small JSON: the DO writes the run-control snapshot, the sidecar answers
 * with a staged draft and rewrites its status file.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import * as v from 'valibot';

import { CandidateRunControlV2Schema } from '../src/durability/contracts';
import type {
  CandidateRunControlV2,
  ObjectReceipt,
  PayloadGrant,
  RangeReadIntent,
  UploadIntent,
} from '../src/durability/contracts';
import type { PackRun } from '../src/candidates/merkle-pack/view-v2';

import { SidecarCore } from './sidecar/core';
import type { SidecarPayloadStore } from './sidecar/core';
import { SidecarDaemonClient, readWalProgress } from './sidecar/daemon-client';
import { SealLoop } from './sidecar/seal-loop';

/**
 * Direct R2 over the intercepted endpoint: one PUT per pack, ranges back.
 *
 * The receipt is ETag-only by construction — the transport drops the checksum
 * headers the request sends — so `sha256` here is the digest of the bytes this
 * process sent, which is also the content address in the key, and the ETag is
 * what proves the store took exactly those bytes. See `publication.ts`
 * § `requireEtagMatchesMd5`.
 */
export class DirectR2Store implements SidecarPayloadStore {
  constructor(private readonly endpoint: string) {}

  #url(key: string): string {
    return `${this.endpoint.replace(/\/+$/u, '')}/${key}`;
  }

  async issuePayloadGrant(intent: UploadIntent): Promise<PayloadGrant> {
    return {
      operationId: intent.operationId,
      attemptId: intent.attemptId,
      expiresAt: intent.expiresAt,
      opaque: intent.exactKey,
    };
  }

  async uploadObject(grant: PayloadGrant, body: ReadableStream<Uint8Array>): Promise<ObjectReceipt> {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    const answer = await fetch(this.#url(grant.opaque), { method: 'PUT', body: bytes });
    if (!answer.ok) {
      throw new Error(`pack PUT of ${grant.opaque} answered ${answer.status}`);
    }
    const etag = answer.headers.get('etag');
    if (etag === null) throw new Error(`pack PUT of ${grant.opaque} answered no etag`);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return {
      operationId: grant.operationId,
      attemptId: grant.attemptId,
      key: grant.opaque,
      byteLength: String(bytes.byteLength),
      sha256: [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
      etag,
      verified: true,
    };
  }

  async readRange(intent: RangeReadIntent): Promise<Uint8Array> {
    const offset = Number(intent.byteOffset);
    const length = Number(intent.byteLength);
    return await this.#range(intent.exactKey, offset, length);
  }

  async readRun(run: PackRun): Promise<Uint8Array> {
    return await this.#range(run.key, run.offset, run.length);
  }

  async deleteObject(key: string): Promise<void> {
    const answer = await fetch(this.#url(key), { method: 'DELETE' });
    if (!answer.ok && answer.status !== 404) {
      throw new Error(`delete of ${key} answered ${answer.status}`);
    }
  }

  async #range(key: string, offset: number, length: number): Promise<Uint8Array> {
    const answer = await fetch(this.#url(key), {
      headers: { range: `bytes=${offset}-${offset + length - 1}` },
    });
    if (!answer.ok) throw new Error(`range read of ${key} answered ${answer.status}`);
    return new Uint8Array(await answer.arrayBuffer());
  }
}

async function atomicWrite(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    await writeFile(temp, body);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export interface SidecarCliOptions {
  readonly boxId: string;
  readonly bootId: string;
  readonly socket: string;
  readonly walPath: string;
  readonly endpoint: string;
  readonly controlPath: string;
  readonly draftPath: string;
  readonly statusPath: string;
  readonly pollMs: number;
}

export function parseSidecarArgv(argv: readonly string[]): SidecarCliOptions {
  const value = (key: string): string => {
    const at = argv.indexOf(key);
    if (at === -1 || argv[at + 1] === undefined) throw new Error(`missing ${key}`);
    return argv[at + 1]!;
  };
  const optional = (key: string, fallback: string): string => {
    const at = argv.indexOf(key);
    return at === -1 || argv[at + 1] === undefined ? fallback : argv[at + 1]!;
  };
  return {
    boxId: value('--box'),
    bootId: value('--boot'),
    socket: value('--journal-socket'),
    walPath: value('--wal'),
    endpoint: value('--store-endpoint'),
    controlPath: value('--control'),
    draftPath: value('--draft'),
    statusPath: value('--status'),
    pollMs: Number(optional('--poll-ms', '250')),
  };
}

/**
 * The loop: tail the WAL so the cadence knows what is unsealed, stage a seal
 * whenever the cadence or a control request asks for one, and keep the status
 * file current so the box can derive its attach outcome from what is really
 * running rather than from a row it wrote once.
 */
export async function runSidecar(options: SidecarCliOptions, until?: AbortSignal): Promise<void> {
  const daemon = new SidecarDaemonClient(options.socket);
  const payload = new DirectR2Store(options.endpoint);
  /** The snapshot the Durable Object writes for this container to read. */
  const snapshot = async (): Promise<CandidateRunControlV2> =>
    v.parse(CandidateRunControlV2Schema, JSON.parse(await readFile(options.controlPath, 'utf8')));
  const core = new SidecarCore({
    boxId: options.boxId,
    bootId: options.bootId,
    // NO HEAD AUTHORITY HERE, deliberately: the container stages seals and the
    // Durable Object advances the head from the draft this writes.
    snapshot,
    payload,
    daemon,
    now: () => Date.now(),
  });
  const loop = new SealLoop(
    {
      seal: async () => {
        const control = await snapshot();
        const staged = await core.stageSeal(control);
        await atomicWrite(options.draftPath, JSON.stringify(staged));
        if (staged.kind === 'no-change') {
          return { kind: 'no-change', rootEnvelopeId: control.head?.pointer.rootEnvelopeId ?? null };
        }
        // Staged, not published: the head is the Durable Object's to advance,
        // and the generation this names becomes real only after its CAS.
        return { kind: 'no-change', rootEnvelopeId: control.head?.pointer.rootEnvelopeId ?? null };
      },
      get unsealedBytes() {
        return core.unsealedBytes;
      },
      get unsealedSince() {
        return core.unsealedSince;
      },
    },
    () => Date.now(),
  );

  let walOffset = 0;
  while (until?.aborted !== true) {
    const progress = await readWalProgress(options.walPath, walOffset);
    walOffset = progress.offset;
    core.noteDirty(progress.dirtyBytes);
    await loop.pump();
    await atomicWrite(options.statusPath, JSON.stringify(core.status()));
    const sleep = Promise.withResolvers<void>();
    setTimeout(() => sleep.resolve(), options.pollMs);
    await sleep.promise;
  }
}

if (import.meta.main) {
  try {
    await runSidecar(parseSidecarArgv(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
