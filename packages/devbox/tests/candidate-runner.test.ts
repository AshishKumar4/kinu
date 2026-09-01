import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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
import type { CandidateRunControlV1, RangeReadIntent } from '../src/durability/contracts';
import {
  CandidateCaptureUnavailable,
  CandidateFenceRefused,
  createCandidateRestoreFile,
  publishCapturedCandidate,
  restoreCandidateRange,
  restoreMerkleTree,
  runCandidate,
} from '../bench/candidate-runner';
import type {
  CandidateCheckpointResult,
  CandidateFormat,
  CandidateRestoreResult,
  CandidateSeedResult,
} from '../bench/candidate-runner';
import { BeneathRoot } from '../src/native-openat2';
import { openMerklePack } from '../src/candidates/merkle-pack';
import type { MerklePackReader } from '../src/candidates/merkle-pack';
import { readBarrier } from './support/read-barrier';
import type { ReadBarrier } from './support/read-barrier';
import { candidateContainerStorage } from '../src/candidates/container';
import type {
  CandidateAttachmentHealth,
  CandidateContainerPorts,
  CandidateRunnerProcess,
} from '../src/candidates/container';
import type { AttachOutcome } from '../src/storage';
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
  /** A control that HAS something to restore, which is what makes a restore
   *  runner exist at all. The three tests below are about waiting for that
   *  process, joining it after a reset, and reading the reply it already
   *  wrote; with nothing published there is no runner to do any of it —
   *  see the empty-attach test that follows them.
   *
   *  REALLY PUBLISHED, through this file's own host and checkpoint helpers: an
   *  invented envelope would be a second opinion on the durable contract, and
   *  a wrong one would still make these tests pass. */
  const place = paths('attach-published');
  let publishedControl: CandidateRunControlV1;
  let attached = { kind: 'attached', detail: '' } satisfies AttachOutcome;
  let publishedResult: string;
  beforeAll(async () => {
    const host = new Host('box-attach-published', place.store);
    const journal = new MutationLog();
    await journal.perform({
      op: 'write', path: 'state.txt', content: { kind: 'dense', bytes: enc.encode('published') },
    });
    await checkpoint(host, 'bounded-layers', place, journal, 'attach-published');
    publishedControl = await host.restoreControl();
    const root = publishedControl.head?.pointer.rootEnvelopeId;
    if (root === undefined) throw new Error('the attach fixture published no head');
    publishedResult = JSON.stringify({ ok: true, rootId: root });
    attached = { kind: 'attached', detail: `restored candidate root ${root}` };
  });
  afterAll(async () => {
    await rm(join(place.workspace, '..'), { recursive: true, force: true });
  });

  test('waits for runner completion through the non-streaming process status seam', async () => {
    const fake = runnerFake({ deferred: true, control: publishedControl, result: publishedResult });
    const attaching = candidateContainerStorage(fake.ports).attach();
    await fake.waitStarted;
    expect(fake.runnerWaits()).toBe(1);
    fake.releaseWait();
    await expect(attaching).resolves.toEqual(attached);
  });

  test('joins a reset to its one deferred restore process without remounting its store', async () => {
    const fake = runnerFake({ deferred: true, control: publishedControl, result: publishedResult });
    const first = candidateContainerStorage(fake.ports).attach();
    await fake.waitStarted;
    const second = candidateContainerStorage(fake.ports).attach();
    expect(fake.starts).toHaveLength(1);
    expect(fake.mounts()).toBe(1);
    expect(fake.stops()).toBe(1);
    fake.releaseWait();
    await expect(Promise.all([first, second])).resolves.toEqual([attached, attached]);
    expect(fake.resultPaths).toHaveLength(2);
    expect(fake.stops()).toBe(2);
    expect(fake.journals()).toBe(2);
  });

  test('reads the result when the runner completed before start replied', async () => {
    const fake = runnerFake({ control: publishedControl, result: publishedResult });
    await expect(candidateContainerStorage(fake.ports).attach()).resolves.toEqual(attached);
    expect(fake.starts).toHaveLength(2);
    expect(fake.resultPaths).toHaveLength(2);
  });

  /**
   * MEASURED DEFECT THIS PINS. An empty box's cold attach started TWO runner
   * processes and waited for each — `--action restore`, which returns
   * `rootId: null` before opening anything when the control has no head, and
   * `--action seed`, which sends nothing when there is no base. Each is a
   * `bun` start over this package's module graph inside the container followed
   * by an unbounded exit poll, spent on the one path a box takes before it has
   * ever held bytes: candidate cold attach measured 15,721 ms against a
   * 25,000 ms product ceiling in `e2ecal0901002202`, and both candidate arms
   * lost cold-attach to that ceiling in `e2e20260901140445`.
   */
  test('an empty control starts NO runner: there is nothing for one to do', async () => {
    const fake = runnerFake();
    await expect(candidateContainerStorage(fake.ports).attach()).resolves.toEqual({
      kind: 'empty',
      detail: 'candidate control has no published head',
    });
    expect({
      starts: fake.starts.length,
      waits: fake.runnerWaits(),
      // And the box is still SERVING: the store is mounted for the checkpoint
      // that follows, and the daemon that serves the work directory is the one
      // this attach started rather than a previous generation's.
      mounts: fake.mounts(),
      stops: fake.stops(),
      journals: fake.journals(),
    }).toEqual({ starts: 0, waits: 0, mounts: 1, stops: 1, journals: 1 });
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

// ── the merkle restore walk ───────────────────────────────────────────────────
//
// A deployed wake lost the merkle-pack arm to `Devbox.attach exceeded its
// 300000ms budget`. The restore was serialized end to end — one stat, one
// readdir, one 512 KiB slice at a time, each an awaited round trip against a
// FUSE-mounted store — so the wake's cost was latency times the number of
// reads, and a 30 MiB tree has thousands of them. These tests pin the two
// properties the repair rests on: the walk fans out, and fanning out does not
// break the one thing a concurrent walk can break, which is a shared inode.

describe('a merkle restore walks the tree in parallel', () => {
  /** The container's own FUSE store, behind the shared group barrier: a walk
   *  that serializes its reads never assembles a group, and `widest` says so.
   *  The bytes come from real files, so this is the production reader over the
   *  production pack — only the WAITING is instrumented. */
  class HoldingStore implements MerklePackReader {
    readonly barrier: ReadBarrier;

    constructor(private readonly store: string, width: number) {
      this.barrier = readBarrier(width);
    }

    async readRange(intent: RangeReadIntent): Promise<Uint8Array> {
      await this.barrier.hold();
      const start = Number(intent.byteOffset);
      const end = start + Number(intent.byteLength);
      const bytes = Bun.file(join(this.store, intent.exactKey)).slice(start, end);
      return new Uint8Array(await bytes.arrayBuffer());
    }
  }

  /** One published tree with a hardlinked pair, a subdirectory and enough
   *  siblings for a walk to have something to overlap. */
  async function publishTree(place: { readonly workspace: string; readonly store: string; readonly journal: string }) {
    const host = new Host('box-merkle-pack', place.store);
    const journal = new MutationLog();
    await journal.perform({ op: 'mkdir', path: 'pkg' });
    await journal.perform({ op: 'mkdir', path: 'pkg/nested' });
    const shared = enc.encode('the bytes one inode holds under two names');
    await journal.perform({ op: 'write', path: 'pkg/lib.bin', content: { kind: 'dense', bytes: shared } });
    await journal.perform({ op: 'link', existingPath: 'pkg/lib.bin', newPath: 'pkg/nested/alias.bin' });
    for (let index = 0; index < 12; index++) {
      await journal.perform({
        op: 'write',
        path: `pkg/leaf-${index}.bin`,
        content: { kind: 'dense', bytes: enc.encode(`leaf ${index} `.repeat(400)) },
      });
    }
    await checkpoint(host, 'merkle-pack', place, journal, 'merkle-parallel');
    return { host, shared };
  }

  test('the walk overlaps its reads instead of taking one round trip at a time', async () => {
    const place = paths('merkle-parallel');
    try {
      await mkdir(place.workspace, { recursive: true });
      const { host, shared } = await publishTree(place);
      const head = (await host.restoreControl()).head;
      if (head === null) throw new Error('the published head did not come back');

      // The real reader over the real pack, read through the barrier.
      const store = new HoldingStore(place.store, 4);
      const manifestBytes = await store.readRange({
        operationId: 'restore-parallel', attemptId: '1', boxId: 'box-merkle-pack',
        epoch: head.envelope.epoch, exactKey: head.envelope.rootObject.key, method: 'GET',
        byteOffset: '0', byteLength: head.envelope.rootObject.byteLength,
        sha256: head.envelope.rootObject.sha256, expiresAt: String(Date.now() + 60_000),
      });
      const view = await openMerklePack({ rootId: sha256Hex(manifestBytes), manifestBytes }, store, {
        operationId: 'restore-parallel', attemptId: '1', boxId: 'box-merkle-pack',
        epoch: head.envelope.epoch, expiresAt: String(Date.now() + 60_000),
      });

      await rm(place.workspace, { recursive: true, force: true });
      await mkdir(place.workspace, { recursive: true });
      const root = new BeneathRoot(place.workspace);
      const notes: string[] = [];
      try {
        await restoreMerkleTree(view, root, notes);
      } finally {
        root.close();
      }

      expect(store.barrier.widest).toBeGreaterThanOrEqual(4);
      // The tree is all there, and the phase breakdown says where the time went.
      expect(await readFile(join(place.workspace, 'pkg/leaf-7.bin'), 'utf8'))
        .toBe('leaf 7 '.repeat(400));
      expect(await readFile(join(place.workspace, 'pkg/nested/alias.bin')))
        .toEqual(Buffer.from(shared));
      expect(notes.join(', ')).toMatch(/tree walk \(2 dirs, 13 files, 1 links\) \d+ ms/);
      expect(notes.join(', ')).toMatch(/data \(\d+ bytes\) \d+ ms/);
    } finally {
      await rm(join(place.workspace, '..'), { recursive: true, force: true });
    }
  });

  test('a wide directory never turns parallel restore into an unbounded fan-out', async () => {
    // The pool is a correctness bound, not just a speed knob: a package tree
    // can have tens of thousands of entries, and Promise.all over one such
    // directory queues a promise per child while the reader's transport gate
    // merely stops the requests. Empty files isolate the CHILD walk — there is
    // one node fetch per file and no data fetches — so this measures the pool,
    // not the codec's independent 16-fetch gate.
    const place = paths('merkle-wide-directory');
    try {
      await mkdir(place.workspace, { recursive: true });
      const host = new Host('box-merkle-wide', place.store);
      const journal = new MutationLog();
      for (let index = 0; index < 24; index++) {
        await journal.perform({
          op: 'write', path: 'empty-' + String(index) + '.bin',
          content: { kind: 'dense', bytes: new Uint8Array() },
        });
      }
      await checkpoint(host, 'merkle-pack', place, journal, 'merkle-wide-directory');
      const head = (await host.restoreControl()).head;
      if (head === null) throw new Error('the published wide-tree head did not come back');

      // More than either pool can fill: setImmediate admits the current wave,
      // then the test reads its widest wave. Without the child pool the reader
      // reaches its own 16-request gate; with it, at most 12 leaf fetches wait.
      const store = new HoldingStore(place.store, 99);
      const manifestBytes = await store.readRange({
        operationId: 'restore-wide', attemptId: '1', boxId: 'box-merkle-wide',
        epoch: head.envelope.epoch, exactKey: head.envelope.rootObject.key, method: 'GET',
        byteOffset: '0', byteLength: head.envelope.rootObject.byteLength,
        sha256: head.envelope.rootObject.sha256, expiresAt: String(Date.now() + 60_000),
      });
      const view = await openMerklePack({ rootId: sha256Hex(manifestBytes), manifestBytes }, store, {
        operationId: 'restore-wide', attemptId: '1', boxId: 'box-merkle-wide',
        epoch: head.envelope.epoch, expiresAt: String(Date.now() + 60_000),
      });
      await rm(place.workspace, { recursive: true, force: true });
      await mkdir(place.workspace, { recursive: true });
      const root = new BeneathRoot(place.workspace);
      try {
        await restoreMerkleTree(view, root);
      } finally {
        root.close();
      }

      expect(store.barrier.widest).toBeGreaterThanOrEqual(4);
      expect(store.barrier.widest).toBeLessThanOrEqual(12);
      expect(await readFile(join(place.workspace, 'empty-23.bin'))).toEqual(Buffer.alloc(0));
    } finally {
      await rm(join(place.workspace, '..'), { recursive: true, force: true });
    }
  });

  test('a hardlinked pair comes back as ONE inode, whichever occurrence wins the claim', async () => {
    // What a concurrent walk can break: two occurrences of one inode
    // discovered at once, both finding no claim, both writing a file — two
    // inodes with the same contents, and a tree that no longer matches what
    // was captured. The claim is taken between a read and a write with no
    // await in between, so exactly one occurrence writes the bytes.
    const place = paths('merkle-hardlink');
    try {
      await mkdir(place.workspace, { recursive: true });
      const { host, shared } = await publishTree(place);
      await rm(place.workspace, { recursive: true, force: true });

      const reply = restored(await runCandidate({
        ...runOptions('merkle-pack', place, await host.restoreControl()),
        action: 'restore',
      }));

      expect(reply.rootId).toMatch(/^[0-9a-f]{64}$/);
      const source = await stat(join(place.workspace, 'pkg/lib.bin'));
      const alias = await stat(join(place.workspace, 'pkg/nested/alias.bin'));
      expect({ ino: alias.ino, links: source.nlink }).toEqual({ ino: source.ino, links: 2 });
      expect(await readFile(join(place.workspace, 'pkg/lib.bin'))).toEqual(Buffer.from(shared));
      for (let index = 0; index < 12; index++) {
        expect(await readFile(join(place.workspace, `pkg/leaf-${index}.bin`), 'utf8'))
          .toBe(`leaf ${index} `.repeat(400));
      }
    } finally {
      await rm(join(place.workspace, '..'), { recursive: true, force: true });
    }
  });
});
