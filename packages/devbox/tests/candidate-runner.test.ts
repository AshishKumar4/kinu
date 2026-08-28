import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

import * as v from 'valibot';

import {
  beginCandidateOperation,
  candidateRunControl,
  finalizeCandidateOperation,
  settleCandidateNoChange,
} from '../src/candidates/control';
import { sha256Hex } from '../src/cas/hash';
import { MutationLog, prefixState, toCapturedCut } from '../src/capture/model';
import type { AuditedCapture, Capture } from '../src/capture/model';
import type { CandidateRunControlV1 } from '../src/durability/contracts';
import {
  CandidateCaptureUnavailable,
  CandidateFenceRefused,
  createCandidateRestoreFile,
  publishCapturedCandidate,
  restoreCandidateRange,
  runCandidate,
} from '../bench/candidate-runner';
import type {
  CandidateCheckpointResult,
  CandidateFormat,
  CandidateRestoreResult,
  CandidateSeedResult,
} from '../bench/candidate-runner';
import { BeneathRoot } from '../src/native-openat2';
import { candidateContainerStorage } from '../src/candidates/container';
import type {
  CandidateAttachmentHealth,
  CandidateContainerPorts,
  CandidateRunnerProcess,
} from '../src/candidates/container';
import { MemoryControlStore, MemoryEnvelopeStore } from './support/candidate-control';

const RUNNER = join(import.meta.dir, '..', 'bench', 'candidate-runner.ts');
const enc = new TextEncoder();

let sequence = 0;

function paths(label: string) {
  const base = join('/tmp', `devbox-candidate-runner-${label}-${process.pid}-${sequence++}`);
  return {
    workspace: join(base, 'journal-root'),
    store: join(base, 'r2-loopback'),
    journal: join(base, 'journal-state'),
  };
}

/** One host: the durable control record plus the immutable envelopes it names. */
class Host {
  readonly control = new MemoryControlStore();
  readonly envelopes = new MemoryEnvelopeStore();

  constructor(
    readonly boxId: string,
    private readonly store: string,
  ) {}

  async begin(): Promise<CandidateRunControlV1> {
    return await beginCandidateOperation({
      kind: 'tick',
      bootId: 'boot-1',
      store: this.control,
      envelopes: this.envelopes,
      verifyObject: async (ref) => {
        const facts = await stat(join(this.store, ref.key));
        if (String(facts.size) !== ref.byteLength) throw new Error(`candidate object metadata mismatches ${ref.key}`);
      },
    });
  }

  async finalize(draft: Parameters<typeof finalizeCandidateOperation>[0]['draft']) {
    return await finalizeCandidateOperation({
      draft,
      boxId: this.boxId,
      store: this.control,
      envelopes: this.envelopes,
      verifyObject: async (ref) => {
        const facts = await stat(join(this.store, ref.key));
        if (String(facts.size) !== ref.byteLength) throw new Error(`candidate object metadata mismatches ${ref.key}`);
      },
    });
  }

  async settle(control: CandidateRunControlV1) {
    return await settleCandidateNoChange({
      active: transferringOperation(control),
      store: this.control,
    });
  }

  async restoreControl(): Promise<CandidateRunControlV1> {
    return await candidateRunControl(this.control, this.envelopes, async (ref) => {
      const facts = await stat(join(this.store, ref.key));
      if (String(facts.size) !== ref.byteLength) throw new Error(`candidate object metadata mismatches ${ref.key}`);
    });
  }
}

function transferringOperation(control: CandidateRunControlV1) {
  const operation = control.operation;
  if (operation === null || operation.phase !== 'transferring') {
    throw new Error(`expected a transferring operation, got ${operation?.phase ?? 'none'}`);
  }
  return operation;
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

function runOptions(
  format: CandidateFormat,
  place: { readonly workspace: string; readonly store: string; readonly journal: string },
  control: CandidateRunControlV1,
) {
  return {
    action: 'checkpoint',
    format,
    workspace: place.workspace,
    store: place.store,
    boxId: `box-${format}`,
    journalSocket: join(place.journal, 'control.sock'),
    control,
  } as const;
}

function restored(
  result: CandidateRestoreResult | CandidateSeedResult | CandidateCheckpointResult,
): CandidateRestoreResult {
  if (!('rootId' in result)) throw new Error('expected a restore reply');
  return result;
}

function staged(
  result: CandidateRestoreResult | CandidateSeedResult | CandidateCheckpointResult,
): Extract<CandidateCheckpointResult, { readonly draft: unknown }> {
  if (!('draft' in result)) throw new Error('expected a checkpoint reply');
  return result;
}

/** A control socket that answers `fence` with one prepared manifest. */
interface FenceReply {
  readonly cut: number;
  readonly generation: number;
  readonly manifestPath: string;
  readonly base?: { readonly cut: string; readonly generation: string; readonly root: string };
}

async function journalControl(socket: string, reply: FenceReply): Promise<() => Promise<void>> {
  const server = createServer((connection) => {
    let text = '';
    connection.setEncoding('utf8');
    connection.on('data', (chunk: string) => {
      text += chunk;
      const newline = text.indexOf('\n');
      if (newline < 0) return;
      const request = v.parse(v.object({ id: v.string(), op: v.string() }), JSON.parse(text.slice(0, newline)));
      const { base: seededBase, ...fence } = reply;
      const base = seededBase === undefined
        ? {}
        : { baseCut: seededBase.cut, baseGeneration: seededBase.generation, baseRoot: seededBase.root };
      connection.end(`${JSON.stringify({ ...fence, ...base, id: request.id, ok: true })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(socket, resolve));
  return async () => await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

async function checkpoint(
  host: Host,
  format: CandidateFormat,
  place: { readonly workspace: string; readonly store: string; readonly journal: string },
  journal: MutationLog,
  handle: string,
) {
  const begun = await host.begin();
  const operation = transferringOperation(begun);
  const publication = await publishCapturedCandidate(
    runOptions(format, place, begun),
    captureFor(journal, {
      captureId: operation.operationId,
      epoch: operation.epoch,
      baseRevision: operation.baseRevision,
    }, handle),
  );
  expect(publication.draft.operationId).toBe(operation.operationId);
  expect(publication.draft.attemptId).toBe(operation.attemptId);
  return { staged: publication, finalized: await host.finalize(publication.draft) };
}

const emptyRunnerControl = {
  version: 1,
  head: null,
  operation: null,
} as const satisfies CandidateRunControlV1;

interface RunnerFakeOptions {
  readonly control?: CandidateRunControlV1;
  readonly begin?: CandidateContainerPorts['begin'];
  readonly settleNoChange?: CandidateContainerPorts['settleNoChange'];
  readonly bootId?: string;
  readonly exitCode?: number;
  readonly exitCodes?: readonly number[];
  readonly logs?: { readonly stdout: string; readonly stderr: string };
  readonly result?: string;
  readonly deferred?: boolean;
  readonly health?: readonly CandidateAttachmentHealth[];
  readonly activeCheckpoint?: CandidateRunnerProcess | null;
}

function runnerFake(options: RunnerFakeOptions = {}) {
  const processes = new Map<string, CandidateRunnerProcess>();
  const starts: { command: string; processId: string }[] = [];
  let runnerWaits = 0;
  const resultPaths: string[] = [];
  const runnerResults = new Map<string, string>();
  let mounts = 0;
  let stops = 0;
  let journals = 0;
  let clearedResults = 0;
  let clearedControl = 0;
  let recordedFailure: string | undefined;
  let redrives = 0;
  let exits = 0;
  let restores = 0;
  let healthChecks = 0;
  const healthy: CandidateAttachmentHealth = {
    storeMounted: true,
    storeAccessible: true,
    journalProcess: true,
    journalSocket: true,
    journalMounted: true,
  };
  const health = options.health ?? [healthy];
  const retiredAttempts: string[] = [];
  let resolveWait = () => {};
  let resolveWaitStarted = () => {};
  const waitGate = options.deferred
    ? new Promise<void>((resolve) => {
      resolveWait = resolve;
    })
    : Promise.resolve();
  const waitStarted = new Promise<void>((resolve) => {
    resolveWaitStarted = resolve;
  });
  let control = options.control ?? emptyRunnerControl;
  const logs = options.logs ?? { stdout: '', stderr: '' };
  const result = options.result ?? JSON.stringify({ ok: true, rootId: null });
  const process = (id: string): CandidateRunnerProcess => ({
    id,
    getLogs: async () => logs,
  });
  const ports: CandidateContainerPorts = {
    format: 'bounded-layers',
    runnerPath: '/runner.ts',
    mountStore: async () => {
      mounts += 1;
    },
    unmountStore: async () => {},
    clearStore: async () => {},
    attachmentHealth: async () => health[healthChecks++] ?? healthy,
    begin: options.begin ?? (async () => control),
    finalize: async () => {
      throw new Error('runner fake does not finalize checkpoints');
    },
    settleNoChange: options.settleNoChange ?? (async () => ({
      version: 1,
      head: control.head?.pointer ?? null,
      operation: control.operation,
    })),
    restoreState: async () => {
      restores += 1;
      return control;
    },
    bootId: async () => options.bootId,
    redrive: async (run) => {
      const active = run.operation;
      if (active?.phase !== 'transferring') throw new Error('runner fake cannot redrive an inactive operation');
      redrives += 1;
      control = {
        ...control,
        operation: {
          ...active,
          epoch: String(BigInt(active.epoch) + 1n),
          attemptId: `attempt-redrive-${redrives}`,
        },
      };
      return control;
    },
    clearControl: async () => {
      clearedControl += 1;
    },
    clearRunnerResults: async () => {
      clearedResults += 1;
    },
    clearRunnerAttempt: async (resultPath) => {
      retiredAttempts.push(resultPath);
      runnerResults.delete(resultPath);
    },
    startJournal: async () => {
      journals += 1;
    },
    stopJournal: async () => {
      stops += 1;
    },
    getRunnerProcess: async (processId) => processes.get(processId) ?? null,
    activeCheckpoint: async () => options.activeCheckpoint ?? null,
    waitForRunnerExit: async () => {
      runnerWaits += 1;
      resolveWaitStarted();
      await waitGate;
      return { exitCode: options.exitCodes?.[exits++] ?? options.exitCode ?? 0 };
    },
    startRunnerProcess: async (command, processId) => {
      starts.push({ command, processId });
      const resultPath = /'--result' '([^']+)'/.exec(command)?.[1];
      const action = /'--action' '([^']+)'/.exec(command)?.[1];
      if (resultPath === undefined || action === undefined) throw new Error('runner command had no action or result path');
      resultPaths.push(resultPath);
      runnerResults.set(resultPath, action === 'seed' ? JSON.stringify({ ok: true }) : result);
      const started = process(processId);
      processes.set(processId, started);
      return started;
    },
    readRunnerResult: async (path) => runnerResults.get(path) ?? result,
    boxId: () => 'box-fake',
    recordFailure: async (reason) => {
      recordedFailure = reason;
    },
  };
  return {
    ports,
    starts,
    runnerWaits: () => runnerWaits,
    resultPaths,
    waitStarted,
    releaseWait: resolveWait,
    mounts: () => mounts,
    stops: () => stops,
    journals: () => journals,
    clearedResults: () => clearedResults,
    clearedControl: () => clearedControl,
    recordedFailure: () => recordedFailure,
    redrives: () => redrives,
    restores: () => restores,
    healthChecks: () => healthChecks,
    retiredAttempts: () => retiredAttempts,
  };
}

const checkpointRunnerControl = {
  version: 1,
  head: null,
  operation: {
    operationId: 'checkpoint-op',
    kind: 'tick',
    epoch: '1',
    bootId: 'boot-1',
    baseRevision: '0',
    expectedParent: null,
    phase: 'transferring',
    attemptId: 'attempt-1',
  },
} as const satisfies CandidateRunControlV1;

describe('candidate supervised runner', () => {
  test('waits for runner completion through the non-streaming process status seam', async () => {
    const fake = runnerFake({ deferred: true });
    const attaching = candidateContainerStorage(fake.ports).attach();
    await fake.waitStarted;
    expect(fake.runnerWaits()).toBe(1);
    fake.releaseWait();
    await expect(attaching).resolves.toEqual({
      kind: 'empty',
      detail: 'candidate control has no published head',
    });
  });

  test('joins a reset to its one deferred restore process without remounting its store', async () => {
    const fake = runnerFake({ deferred: true });
    const first = candidateContainerStorage(fake.ports).attach();
    await fake.waitStarted;
    const second = candidateContainerStorage(fake.ports).attach();
    expect(fake.starts).toHaveLength(1);
    expect(fake.mounts()).toBe(1);
    expect(fake.stops()).toBe(1);
    fake.releaseWait();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: 'empty', detail: 'candidate control has no published head' },
      { kind: 'empty', detail: 'candidate control has no published head' },
    ]);
    expect(fake.resultPaths).toHaveLength(2);
    expect(fake.stops()).toBe(2);
    expect(fake.journals()).toBe(2);
  });

  test('reads the result when the runner completed before start replied', async () => {
    const fake = runnerFake();
    await expect(candidateContainerStorage(fake.ports).attach()).resolves.toEqual({
      kind: 'empty',
      detail: 'candidate control has no published head',
    });
    expect(fake.starts).toHaveLength(2);
    expect(fake.resultPaths).toHaveLength(2);
  });

  test.each([
    ['daemon exit', { storeMounted: true, storeAccessible: true, journalProcess: false, journalSocket: true, journalMounted: true }],
    ['journal socket missing', { storeMounted: true, storeAccessible: true, journalProcess: true, journalSocket: false, journalMounted: true }],
    ['journal mount missing', { storeMounted: true, storeAccessible: true, journalProcess: true, journalSocket: true, journalMounted: false }],
  ] as const satisfies readonly (readonly [string, CandidateAttachmentHealth])[])(
    'repairs same-container %s without materializing its head',
    async (_name, health) => {
      const fake = runnerFake({ health: [health] });
      const storage = candidateContainerStorage(fake.ports);
      if (storage.repairAttached === undefined) throw new Error('candidate storage has no attached repair');

      await storage.repairAttached();

      expect(fake.stops()).toBe(1);
      expect(fake.journals()).toBe(1);
      expect(fake.mounts()).toBe(0);
      expect(fake.restores()).toBe(1);
      expect(fake.starts).toHaveLength(1);
    },
  );

  test('remounts an unreadable candidate store without materializing its head', async () => {
    const fake = runnerFake({
      health: [{
        storeMounted: true,
        storeAccessible: false,
        journalProcess: true,
        journalSocket: true,
        journalMounted: true,
      }],
    });
    const storage = candidateContainerStorage(fake.ports);
    if (storage.repairAttached === undefined) throw new Error('candidate storage has no attached repair');

    await storage.repairAttached();

    expect(fake.mounts()).toBe(1);
    expect(fake.stops()).toBe(0);
    expect(fake.journals()).toBe(0);
    expect(fake.restores()).toBe(1);
    expect(fake.starts).toHaveLength(1);
  });

  test('reseeds a healthy daemon after a head commit without replacing its container', async () => {
    const place = paths('healthy-reseed');
    try {
      const host = new Host('box-bounded-layers', place.store);
      const journal = new MutationLog();
      await journal.perform({
        op: 'write', path: 'state.txt', content: { kind: 'dense', bytes: enc.encode('published') },
      });
      await checkpoint(host, 'bounded-layers', place, journal, 'published');
      const control = await host.restoreControl();
      const fake = runnerFake({ control });
      const storage = candidateContainerStorage(fake.ports);
      if (storage.repairAttached === undefined) throw new Error('candidate storage has no attached repair');

      await storage.repairAttached();

      expect(fake.mounts()).toBe(0);
      expect(fake.stops()).toBe(0);
      expect(fake.journals()).toBe(0);
      expect(fake.restores()).toBe(1);
      expect(fake.starts).toHaveLength(1);
      expect(fake.starts[0]?.command).toContain("'--action' 'seed'");
      const encoded = /'--control-state' '([^']+)'/.exec(fake.starts[0]?.command ?? '')?.[1];
      if (encoded === undefined) throw new Error('candidate repair omitted its control snapshot');
      expect(JSON.parse(atob(encoded)).head.pointer.rootEnvelopeId).toBe(control.head?.pointer.rootEnvelopeId);
    } finally {
      await rm(join(place.workspace, '..'), { recursive: true, force: true });
    }
  });

  test('leaves a live checkpoint runner and healthy attachments untouched', async () => {
    const checkpoint: CandidateRunnerProcess = {
      id: 'checkpoint-live',
      getLogs: async () => ({ stdout: '', stderr: '' }),
    };
    const fake = runnerFake({ activeCheckpoint: checkpoint });
    const storage = candidateContainerStorage(fake.ports);
    if (storage.repairAttached === undefined) throw new Error('candidate storage has no attached repair');

    await storage.repairAttached();

    expect(fake.mounts()).toBe(0);
    expect(fake.stops()).toBe(0);
    expect(fake.journals()).toBe(0);
    expect(fake.restores()).toBe(0);
  });

  test('redrives terminal checkpoint work through the one reusable process slot', async () => {
    const fake = runnerFake({
      control: checkpointRunnerControl,
      exitCodes: [17, 0],
      logs: { stdout: '', stderr: 'runner exploded' },
    });
    await expect(candidateContainerStorage(fake.ports).checkpoint('tick')).resolves.toEqual({
      kind: 'failed',
      reason: 'candidate checkpoint failed: runner exploded',
      bytes: undefined,
      movedBytes: undefined,
    });
    await candidateContainerStorage(fake.ports).checkpoint('tick');
    expect(fake.redrives()).toBe(2);
    expect(fake.starts).toHaveLength(2);
    expect(fake.starts[1]?.processId).toBe(fake.starts[0]?.processId);
    expect(fake.recordedFailure()).toBe('Invalid type: Expected Object but received Object');
    expect(fake.clearedControl()).toBe(0);
    expect(fake.retiredAttempts()).toHaveLength(2);
  });

  test('settles a joined tick storm before a queued quiesce gets its own no-change pass', async () => {
    const quiesceControl = {
      ...checkpointRunnerControl,
      operation: {
        ...checkpointRunnerControl.operation,
        operationId: 'quiesce-op',
        kind: 'barrier',
      },
    } as const satisfies CandidateRunControlV1;
    let quiesceBegins = 0;
    const fake = runnerFake({
      result: JSON.stringify({ ok: true, noChange: true }),
      begin: async (kind) => {
        if (kind === 'tick') return checkpointRunnerControl;
        quiesceBegins += 1;
        return quiesceBegins === 1 ? checkpointRunnerControl : quiesceControl;
      },
    });
    const storage = candidateContainerStorage(fake.ports);

    await expect(Promise.all(Array.from({ length: 8 }, async () => await storage.checkpoint('tick'))))
      .resolves.toEqual(Array.from({ length: 8 }, () => ({
        kind: 'skipped',
        reason: 'candidate bounded-layers tick fenced the published manifest',
        bytes: undefined,
        movedBytes: 0,
      })));
    await expect(storage.checkpoint('quiesce')).resolves.toEqual({
      kind: 'skipped',
      reason: 'candidate bounded-layers quiesce fenced the published manifest',
      bytes: undefined,
      movedBytes: 0,
    });
    expect(quiesceBegins).toBe(2);
  });

  test('uses one checkpoint process and reply path across operation attempts', async () => {
    const first = runnerFake({ control: checkpointRunnerControl, exitCode: 1 });
    const second = runnerFake({
      control: { ...checkpointRunnerControl, operation: { ...checkpointRunnerControl.operation, bootId: 'other-boot' } },
      exitCode: 1,
    });
    await Promise.all([
      candidateContainerStorage(first.ports).checkpoint('tick'),
      candidateContainerStorage(second.ports).checkpoint('tick'),
    ]);
    expect(second.starts[0]?.processId).toBe(first.starts[0]?.processId);
    expect(second.resultPaths).toEqual(first.resultPaths);
  });

  test('cleans retained runner results when the candidate is discarded', async () => {
    const fake = runnerFake();
    await candidateContainerStorage(fake.ports).discard();
    expect(fake.clearedResults()).toBe(1);
    expect(fake.clearedControl()).toBe(1);
  });
});

describe('candidate container runner', () => {
  test.each(['bounded-layers', 'merkle-pack'] as const)(
    '%s stages through the mount, hands the host a draft, and restores the published head',
    async (format) => {
      const place = paths(format);
      try {
        await mkdir(place.workspace, { recursive: true });
        const host = new Host(`box-${format}`, place.store);
        const journal = new MutationLog();
        await journal.perform({
          op: 'write', path: 'state.txt', content: { kind: 'dense', bytes: enc.encode('old') },
        });

        const first = await checkpoint(host, format, place, journal, `${format}-old`);
        expect(first.staged.movedBytes).toBeGreaterThan(0);
        expect(first.staged.heldBytes).toBeGreaterThan(0);
        expect(first.finalized.operation?.phase).toBe('published');
        const firstRoot = first.finalized.head?.rootEnvelopeId ?? null;
        expect(firstRoot).toMatch(/^[0-9a-f]{64}$/);

        // The second checkpoint reads its parent only from the host-supplied envelope.
        await journal.perform({
          op: 'rewrite-in-place', path: 'state.txt', content: { kind: 'dense', bytes: enc.encode('new') },
        });
        const second = await checkpoint(host, format, place, journal, `${format}-new`);
        const secondRoot = second.finalized.head?.rootEnvelopeId ?? null;
        expect(second.finalized.operation?.phase).toBe('published');
        expect(secondRoot).not.toBe(firstRoot);
        expect(host.envelopes.objects.size).toBe(2);

        await rm(place.workspace, { recursive: true, force: true });
        const reply = restored(await runCandidate({
          ...runOptions(format, place, await host.restoreControl()),
          action: 'restore',
        }));
        expect(reply.rootId).toBe(secondRoot);
        expect(await readFile(join(place.workspace, 'state.txt'), 'utf8')).toBe('new');
        // No container-side control authority survives the run.
        await expect(Bun.file(join(place.store, '.candidate-control', 'head.json')).exists()).resolves.toBeFalse();
      } finally {
        await rm(join(place.workspace, '..'), { recursive: true, force: true });
      }
    },
  );

  test('fences the container journal, publishes that cut, and restores it', async () => {
    const place = paths('journal');
    try {
      await mkdir(place.journal, { recursive: true });
      const stage = join(place.journal, 'stage');
      await mkdir(stage, { recursive: true });
      const bytes = enc.encode('journaled bytes');
      await writeFile(join(stage, 'notes.extent'), bytes);
      const manifestPath = join(place.journal, 'fence-7.json');
      await writeFile(manifestPath, JSON.stringify({
        cut: 7,
        generation: 3,
        stageRoot: stage,
        entries: [{
          path: 'notes.txt',
          kind: 'file',
          mode: 0o644,
          ino: 2,
          metadata: {
            uid: process.getuid?.() ?? 0,
            gid: process.getgid?.() ?? 0,
            atimeNs: '0',
            mtimeNs: '0',
            ctimeNs: '0',
            xattrs: {},
          },
          content: {
            kind: 'sealed',
            size: bytes.byteLength,
            sourceId: 'notes.extent',
            extents: [{ offset: 0, length: bytes.byteLength, sha256: sha256Hex(bytes) }],
          },
        }],
      }));
      let close = await journalControl(join(place.journal, 'control.sock'), {
        cut: 7, generation: 3, manifestPath,
      });
      const host = new Host('box-bounded-layers', place.store);

      try {
        const begun = await host.begin();
        const publication = staged(await runCandidate(runOptions('bounded-layers', place, begun)));
        expect(publication.draft.operationId).toBe(transferringOperation(begun).operationId);
        expect(publication.draft.capturedCut.cut).toBe('7');
        expect(publication.draft.generation).toBe('3');

        const finalized = await host.finalize(publication.draft);
        expect(finalized.operation?.phase).toBe('published');
        const publishedRoot = finalized.head?.rootEnvelopeId;
        if (publishedRoot === undefined) throw new Error('candidate publication did not retain its root');

        await close();
        const divergentStage = join(place.journal, 'divergent-stage');
        await mkdir(divergentStage, { recursive: true });
        const divergentManifestPath = join(place.journal, 'fence-7-divergent.json');
        await writeFile(divergentManifestPath, JSON.stringify({
          cut: 7,
          generation: 3,
          stageRoot: divergentStage,
          entries: [],
        }));
        close = await journalControl(join(place.journal, 'control.sock'), {
          cut: 7,
          generation: 3,
          manifestPath: divergentManifestPath,
          base: { cut: '7', generation: '3', root: publishedRoot },
        });
        const unchanged = await host.begin();
        const noChange = { ok: true, noChange: true } as const;
        await expect(Promise.all(
          Array.from({ length: 8 }, async () => await runCandidate(runOptions('bounded-layers', place, unchanged))),
        )).resolves.toEqual(Array.from({ length: 8 }, () => noChange));
        await host.settle(unchanged);

        const reply = restored(await runCandidate({
          ...runOptions('bounded-layers', place, await host.restoreControl()),
          action: 'restore',
        }));
        expect(reply.rootId).toBe(finalized.head?.rootEnvelopeId ?? null);
        expect(await readFile(join(place.workspace, 'notes.txt'), 'utf8')).toBe('journaled bytes');

        await close();
        const lowerManifestPath = join(place.journal, 'fence-6.json');
        await writeFile(
          lowerManifestPath,
          (await readFile(manifestPath, 'utf8')).replace('"cut":7', '"cut":6'),
        );
        close = await journalControl(join(place.journal, 'control.sock'), {
          cut: 6,
          generation: 3,
          manifestPath: lowerManifestPath,
          base: { cut: '7', generation: '3', root: publishedRoot },
        });
        await expect(runCandidate(runOptions('bounded-layers', place, await host.begin())))
          .rejects.toBeInstanceOf(CandidateFenceRefused);
      } finally {
        await close();
      }
    } finally {
      await rm(join(place.workspace, '..'), { recursive: true, force: true });
    }
  });

  test('refuses a checkpoint when no journal daemon answers the control socket', async () => {
    const place = paths('no-journal');
    try {
      const host = new Host('box-bounded-layers', place.store);
      await expect(runCandidate(runOptions('bounded-layers', place, await host.begin())))
        .rejects.toBeInstanceOf(CandidateCaptureUnavailable);
    } finally {
      await rm(join(place.workspace, '..'), { recursive: true, force: true });
    }
  });

  test.each(['bounded-layers', 'merkle-pack'] as const)(
    '%s refuses a capture that is not bound to the host transfer grant',
    async (format) => {
      const place = paths(`${format}-grant`);
      try {
        await mkdir(place.workspace, { recursive: true });
        const host = new Host(`box-${format}`, place.store);
        const journal = new MutationLog();
        await journal.perform({
          op: 'write', path: 'state.txt', content: { kind: 'dense', bytes: enc.encode('old') },
        });
        const begun = await host.begin();
        const operation = transferringOperation(begun);

        await expect(publishCapturedCandidate(
          runOptions(format, place, begun),
          captureFor(journal, {
            captureId: 'not-the-operation',
            epoch: operation.epoch,
            baseRevision: operation.baseRevision,
          }, format),
        )).rejects.toThrow('captured cut does not belong to the host checkpoint grant');
      } finally {
        await rm(join(place.workspace, '..'), { recursive: true, force: true });
      }
    },
  );

  test('refuses a control snapshot whose envelope does not match its head pointer', async () => {
    const place = paths('tampered');
    try {
      await mkdir(place.workspace, { recursive: true });
      const host = new Host('box-tampered', place.store);
      const journal = new MutationLog();
      await journal.perform({
        op: 'write', path: 'state.txt', content: { kind: 'dense', bytes: enc.encode('old') },
      });
      await checkpoint(host, 'bounded-layers', place, journal, 'tampered');
      const published = await host.restoreControl();
      if (published.head === null) throw new Error('expected a published head');

      await expect(runCandidate({
        ...runOptions('bounded-layers', place, {
          ...published,
          head: {
            pointer: published.head.pointer,
            envelope: { ...published.head.envelope, generation: '999' },
          },
        }),
        action: 'restore',
      })).rejects.toThrow('does not match pointer');
    } finally {
      await rm(join(place.workspace, '..'), { recursive: true, force: true });
    }
  });

  test('the container entry point atomically writes its restore reply', async () => {
    const place = paths('cli');
    try {
      await mkdir(place.workspace, { recursive: true });
      const host = new Host('box-cli', place.store);
      const journal = new MutationLog();
      await journal.perform({
        op: 'write', path: 'notes.txt', content: { kind: 'dense', bytes: enc.encode('cli') },
      });
      const published = await checkpoint(host, 'bounded-layers', place, journal, 'cli');
      const publishedRoot = published.finalized.head?.rootEnvelopeId;
      await rm(place.workspace, { recursive: true, force: true });

      const encodeControl = (control: CandidateRunControlV1): string =>
        Buffer.from(JSON.stringify(control), 'utf8').toString('base64');
      const resultPath = join(place.workspace, '..', 'runner-result.json');
      const argv = (action: string, control: string) => [
        'bun', RUNNER,
        '--action', action,
        '--format', 'bounded-layers',
        '--workspace', place.workspace,
        '--store', place.store,
        '--box', 'box-cli',
        '--journal-socket', join(place.journal, 'control.sock'),
        '--control-state', control,
        '--result', resultPath,
      ];
      const restore = Bun.spawn({
        cmd: argv('restore', encodeControl(await host.restoreControl())),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await restore.exited).toBe(0);
      expect(await new Response(restore.stdout).text()).toBe('');
      expect(JSON.parse(await readFile(resultPath, 'utf8'))).toEqual({ ok: true, rootId: publishedRoot });
      expect(await readFile(join(place.workspace, 'notes.txt'), 'utf8')).toBe('cli');

      // No daemon answers this container, so the checkpoint refuses instead of
      // inventing a capture, and its incomplete result never becomes visible.
      const checkpointRun = Bun.spawn({
        cmd: argv('checkpoint', encodeControl(await host.begin())),
        stdout: 'pipe',
        stderr: 'pipe',
      });

      expect(await checkpointRun.exited).toBe(1);
      expect(await new Response(checkpointRun.stdout).text()).toBe('');
      expect(await new Response(checkpointRun.stderr).text()).toContain('candidate capture unavailable');
    } finally {
      await rm(join(place.workspace, '..'), { recursive: true, force: true });
    }
  });
});
describe('candidate bounded native restore ranges', () => {
  test('writes a >128MiB dense logical extent in bounded slices with a complete ordered digest', async () => {
    const place = paths('dense-ranges');
    const size = 129 * 1024 * 1024;
    const expected = createHash('sha256');
    let maxRead = 0;
    try {
      await mkdir(place.workspace, { recursive: true });
      const root = new BeneathRoot(place.workspace);
      try {
        createCandidateRestoreFile(root, 'dense.bin', 0o644, size);
        await restoreCandidateRange(root, 'dense.bin', 0, size, async (offset, length) => {
          maxRead = Math.max(maxRead, length);
          const bytes = new Uint8Array(length);
          bytes.fill(Math.floor(offset / (512 * 1024)) & 0xff);
          expected.update(bytes);
          return bytes;
        });
      } finally {
        root.close();
      }
      const actual = createHash('sha256');
      for await (const chunk of createReadStream(join(place.workspace, 'dense.bin'))) actual.update(chunk);
      expect(maxRead).toBeLessThanOrEqual(512 * 1024);
      expect(actual.digest('hex')).toBe(expected.digest('hex'));
    } finally {
      await rm(join(place.workspace, '..'), { recursive: true, force: true });
    }
  });

  test('creates a 1TiB logical hole without a range read or data blocks', async () => {
    const place = paths('sparse-range');
    const size = 1024 ** 4;
    try {
      await mkdir(place.workspace, { recursive: true });
      const root = new BeneathRoot(place.workspace);
      try {
        createCandidateRestoreFile(root, 'hole.bin', 0o644, size);
      } finally {
        root.close();
      }
      const result = await stat(join(place.workspace, 'hole.bin'));
      expect(result.size).toBe(size);
      expect(result.blocks).toBe(0);
    } finally {
      await rm(join(place.workspace, '..'), { recursive: true, force: true });
    }
  });
});
