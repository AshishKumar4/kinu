import { describe, expect, test } from 'bun:test';
import { closeSync, fstatSync, openSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import * as v from 'valibot';

import { beginCandidateOperation, finalizeCandidateOperation, settleCandidateOperation } from '../src/candidates/control';
import { MutationLog, prefixState, toCapturedCut } from '../src/capture/model';
import type { AuditedCapture, Capture } from '../src/capture/model';
import type { CandidateRunControlV1 } from '../src/durability/contracts';
import { publishCapturedCandidate, runCandidate } from './candidate-runner';
import type {
  CandidateCheckpointResult,
  CandidateRestoreResult,
  CandidateRunOptions,
  CandidateSeedResult,
} from './candidate-runner';
import { MemoryControlStore, MemoryEnvelopeStore } from '../tests/support/candidate-control';

let sequence = 0;

/** The directories one bench runner invocation works in. */
interface BenchPlace {
  readonly base: string;
  readonly workspace: string;
  readonly store: string;
  readonly stage: string;
  readonly journal: string;
}

function paths(label: string): BenchPlace {
  const base = join('/tmp', `devbox-bench-runner-${label}-${process.pid}-${sequence++}`);
  return {
    base,
    workspace: join(base, 'workspace'),
    store: join(base, 'store'),
    stage: join(base, 'stage'),
    journal: join(base, 'journal'),
  };
}

function captureFor(
  journal: MutationLog,
  identity: { readonly captureId: string; readonly epoch: string; readonly baseRevision: string },
  handle: string,
): AuditedCapture {
  const state: Capture = {
    mechanism: 'mutation-journal',
    cut: journal.lastSeq,
    generation: journal.generation,
    entries: [...prefixState(journal.entries, journal.lastSeq).values()],
  };
  return toCapturedCut(journal.entries, state, { ...identity, stableStageHandle: handle });
}

function transferringOperation(control: CandidateRunControlV1) {
  const operation = control.operation;
  if (operation === null || operation.phase !== 'transferring') {
    throw new Error(`expected a transferring operation, got ${operation?.phase ?? 'none'}`);
  }
  return operation;
}

function runnerOptions(
  place: BenchPlace,
  control: CandidateRunControlV1,
  action: CandidateRunOptions['action'],
): CandidateRunOptions {
  return {
    action,
    format: 'bounded-layers',
    workspace: place.workspace,
    store: place.store,
    stage: place.stage,
    boxId: 'box-bench',
    journalSocket: join(place.journal, 'control.sock'),
    control,
  };
}

function verifyPlace(store: string) {
  return async (ref: { readonly key: string; readonly byteLength: string }): Promise<void> => {
    const facts = await stat(join(store, ref.key));
    if (String(facts.size) !== ref.byteLength) throw new Error(`candidate object metadata mismatches ${ref.key}`);
  };
}

function restored(
  result: CandidateRestoreResult | CandidateSeedResult | CandidateCheckpointResult,
): CandidateRestoreResult {
  if (!('rootId' in result)) throw new Error('expected a restore reply');
  return result;
}

/** A 64 KiB file, so the published root carries one boundary row for it. */
function bigBytes(): Uint8Array {
  const bytes = new Uint8Array(64 * 1024);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  return bytes;
}

interface PublishedFixture {
  readonly place: BenchPlace;
  readonly control: MemoryControlStore;
  readonly envelopes: MemoryEnvelopeStore;
  readonly journal: MutationLog;
}

async function publishOnce(label: string): Promise<PublishedFixture> {
  const place = paths(label);
  await mkdir(place.workspace, { recursive: true });
  const control = new MemoryControlStore();
  const envelopes = new MemoryEnvelopeStore();
  const journal = new MutationLog();
  await journal.perform({ op: 'write', path: 'big.bin', content: { kind: 'dense', bytes: bigBytes() } });
  const begun = await beginCandidateOperation({
    kind: 'tick',
    bootId: 'boot-1',
    store: control,
    envelopes,
    verifyObject: verifyPlace(place.store),
  });
  const operation = transferringOperation(begun);
  const publication = await publishCapturedCandidate(
    runnerOptions(place, begun, 'checkpoint'),
    captureFor(journal, {
      captureId: operation.operationId,
      epoch: operation.epoch,
      baseRevision: operation.baseRevision,
    }, `${label}-handle`),
  );
  await finalizeCandidateOperation({
    draft: publication.draft,
    boxId: 'box-bench',
    store: control,
    envelopes,
    verifyObject: verifyPlace(place.store),
  });
  return { place, control, envelopes, journal };
}

/** A seed socket that records each request op and answers what the client checks. */
async function serveSeed(socket: string, seen: string[]): Promise<() => Promise<void>> {
  await mkdir(dirname(socket), { recursive: true });
  const server = createServer((connection) => {
    let text = '';
    connection.setEncoding('utf8');
    connection.on('data', (chunk: string) => {
      text += chunk;
      const newline = text.indexOf('\n');
      if (newline < 0) return;
      const request = v.parse(
        v.object({ id: v.string(), op: v.string(), files: v.optional(v.array(v.unknown())) }),
        JSON.parse(text.slice(0, newline)),
      );
      seen.push(request.op);
      const reply = request.op === 'boundaries'
        ? { id: request.id, ok: true, boundaryFiles: request.files?.length ?? 0 }
        : { id: request.id, ok: true };
      connection.end(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  return async () => await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function handbackPath(place: BenchPlace): string {
  return join(place.stage, 'boundaries.json');
}

describe('candidate restore handback', () => {
  test('a bounded restore hands the daemon the live inodes', async () => {
    const fixture = await publishOnce('restore-live-ino');
    const { place, control, envelopes } = fixture;
    try {
      const restoreControl = await settleCandidateOperation({ store: control, envelopes, verifyObject: verifyPlace(place.store) });
      const head = restoreControl.head;
      if (head === null) throw new Error('the restore fixture published no head');
      await rm(place.workspace, { recursive: true, force: true });
      const reply = restored(await runCandidate(runnerOptions(place, restoreControl, 'restore')));
      expect(reply.rootId).toBe(head.pointer.rootEnvelopeId);

      const handback = JSON.parse(await readFile(handbackPath(place), 'utf8'));
      expect(handback.rootSha256).toBe(head.envelope.rootObject.sha256);
      expect(handback.maxChunkBytes).toBe(16384);
      expect(handback.files).toHaveLength(1);
      const row = handback.files[0];
      expect(row.path).toBe('big.bin');
      expect(row.size).toBe(64 * 1024);
      expect(row.boundaries).toEqual([0, 16384, 32768, 49152]);
      const fd = openSync(join(place.workspace, 'big.bin'), 'r');
      try {
        expect(row.ino).toBe(String(fstatSync(fd).ino));
      } finally {
        closeSync(fd);
      }
    } finally {
      await rm(place.base, { recursive: true, force: true });
    }
  });

  test('a seed sends boundaries only for the published root', async () => {
    const fixture = await publishOnce('seed-guards');
    const { place, control, envelopes } = fixture;
    try {
      const restoreControl = await settleCandidateOperation({ store: control, envelopes, verifyObject: verifyPlace(place.store) });
      if (restoreControl.head === null) throw new Error('the seed fixture published no head');
      await rm(place.workspace, { recursive: true, force: true });
      await runCandidate(runnerOptions(place, restoreControl, 'restore'));

      const socket = join(place.journal, 'control.sock');
      const seen: string[] = [];
      const close = await serveSeed(socket, seen);
      try {
        const seedControl = await settleCandidateOperation({ store: control, envelopes, verifyObject: verifyPlace(place.store) });
        await runCandidate(runnerOptions(place, seedControl, 'seed'));
        expect(seen).toEqual(['boundaries']);

        const held = JSON.parse(await readFile(handbackPath(place), 'utf8'));
        await writeFile(handbackPath(place), JSON.stringify({ ...held, rootSha256: 'f'.repeat(64) }));
        await runCandidate(runnerOptions(place, seedControl, 'seed'));
        expect(seen).toEqual(['boundaries', 'base']);

        await rm(handbackPath(place), { force: true });
        await runCandidate(runnerOptions(place, seedControl, 'seed'));
        expect(seen).toEqual(['boundaries', 'base', 'base']);
      } finally {
        await close();
      }
    } finally {
      await rm(place.base, { recursive: true, force: true });
    }
  });

  test('a seed leaves an unpublished checkpoint handback alone', async () => {
    const fixture = await publishOnce('seed-unpublished');
    const { place, control, envelopes, journal } = fixture;
    try {
      // A checkpoint that never reached its CAS: its rows describe a root the
      // head does not name, so the next fence must stage whole files.
      const begun = await beginCandidateOperation({
        kind: 'tick',
        bootId: 'boot-1',
        store: control,
        envelopes,
        verifyObject: verifyPlace(place.store),
      });
      const operation = transferringOperation(begun);
      await journal.perform({ op: 'write', path: 'extra.txt', content: { kind: 'dense', bytes: new TextEncoder().encode('unpublished') } });
      await publishCapturedCandidate(
        runnerOptions(place, begun, 'checkpoint'),
        captureFor(journal, {
          captureId: operation.operationId,
          epoch: operation.epoch,
          baseRevision: operation.baseRevision,
        }, 'seed-unpublished-handle'),
      );

      const socket = join(place.journal, 'control.sock');
      const seen: string[] = [];
      const close = await serveSeed(socket, seen);
      try {
        await runCandidate(runnerOptions(place, await settleCandidateOperation({ store: control, envelopes, verifyObject: verifyPlace(place.store) }), 'seed'));
        expect(seen).toEqual(['base']);
      } finally {
        await close();
      }
    } finally {
      await rm(place.base, { recursive: true, force: true });
    }
  });
});
