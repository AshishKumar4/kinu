import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createReadStream, watch } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

import * as v from 'valibot';

import {
  beginCandidateOperation,
  finalizeCandidateOperation,
  settleCandidateNoChange,
  settleCandidateOperation,
} from '../src/candidates/control';
import { sha256Hex } from '../src/cas/hash';
import { MutationLog, prefixState, toCapturedCut } from '../src/capture/model';
import type { AuditedCapture, Capture } from '../src/capture/model';
import type {
  CandidateRunControlV1,
  ImmutableObjectRef,
  PayloadGrant,
  RangeReadIntent,
  UploadIntent,
} from '../src/durability/contracts';
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
import { build as buildBoundedLayers } from '../src/candidates/bounded-layers';
import { stageCandidatePayload } from '../src/candidates/publication';
import { openMerklePack } from '../src/candidates/merkle-pack';
import type { MerklePackReader, PackRun } from '../src/candidates/merkle-pack';
import { CandidateRestoreBoundSchema, CandidateRestoreWorkSchema } from '../src/candidates/restore-receipt';
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
import { EgressFake } from './support/cas-cost-probe';

const RUNNER = join(import.meta.dir, '..', 'bench', 'candidate-runner.ts');
const enc = new TextEncoder();

let sequence = 0;

/** The directories one runner invocation works in. */
interface RunnerPlace {
  readonly workspace: string;
  readonly store: string;
  readonly stage: string;
  readonly journal: string;
}

function paths(label: string): RunnerPlace {
  const base = join('/tmp', `devbox-candidate-runner-${label}-${process.pid}-${sequence++}`);
  return {
    workspace: join(base, 'journal-root'),
    store: join(base, 'r2-loopback'),
    stage: join(base, 'stage'),
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
      verifyObject: this.#verifyObject,
    });
  }

  async finalize(draft: Parameters<typeof finalizeCandidateOperation>[0]['draft']) {
    return await finalizeCandidateOperation({
      draft,
      boxId: this.boxId,
      store: this.control,
      envelopes: this.envelopes,
      verifyObject: this.#verifyObject,
    });
  }

  async settle(control: CandidateRunControlV1) {
    return await settleCandidateNoChange({
      active: transferringOperation(control),
      store: this.control,
    });
  }

  async restoreControl(): Promise<CandidateRunControlV1> {
    return await settleCandidateOperation({
      store: this.control,
      envelopes: this.envelopes,
      verifyObject: this.#verifyObject,
    });
  }

  readonly #verifyObject = async (ref: ImmutableObjectRef): Promise<void> => {
    const facts = await stat(join(this.store, ref.key));
    if (String(facts.size) !== ref.byteLength) throw new Error(`candidate object metadata mismatches ${ref.key}`);
  };
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
  place: RunnerPlace,
  control: CandidateRunControlV1,
) {
  return {
    action: 'checkpoint',
    format,
    workspace: place.workspace,
    store: place.store,
    stage: place.stage,
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

/** The counted work a real fence reports beside its manifest. Staged bytes and
 *  whole files are the daemon's own; the chunk and node fields belong to the
 *  sidecar and a daemon reply leaves them at zero. */
const FENCE_SEAL_WORK = {
  bytesStaged: 0, bytesChunked: 0, chunksHashed: 0, nodesRewritten: 0, wholeFiles: 0,
} as const;

/** One delta manifest row for a file staged whole: its one range names the
 *  staged bytes with the fence's own digest, and `whole` is true because the
 *  window starts at 0 and reaches the size — the exact shape
 *  `journal_stage_plan` in journal-delta.c writes for a file it holds no
 *  boundaries for. */
/** Distinct inodes per row: the capture model reads a shared `ino` as one
 *  hardlinked inode, which two unrelated files are not. */
let deltaIno = 2;
function deltaFile(path: string, bytes: Uint8Array) {
  return {
    ino: String(deltaIno++),
    path,
    kind: 'file',
    size: bytes.byteLength,
    mode: 0o644,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    atimeNs: '1',
    mtimeNs: '2',
    ctimeNs: '3',
    xattrs: {},
    whole: true,
    dirty: [{ offset: 0, length: bytes.byteLength }],
    ranges: [{ offset: 0, length: bytes.byteLength, sha256: sha256Hex(bytes) }],
  };
}

function deltaDir(path: string) {
  return {
    ino: '1',
    path,
    kind: 'dir',
    mode: 0o755,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    atimeNs: '1',
    mtimeNs: '2',
    ctimeNs: '3',
    xattrs: {},
  };
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
      connection.end(`${JSON.stringify({
        ...fence, ...base, sealWork: FENCE_SEAL_WORK, id: request.id, ok: true,
      })}\n`);
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
  place: RunnerPlace,
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
  const runnerControls = new Map<string, string>();
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
    payloadUrl: 'http://r2.internal/BACKUP_BUCKET',
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
    writeRunnerControl: async (path, content) => {
      runnerControls.set(path, content);
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
    controls: runnerControls,
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

  test('a restore runner receives the egress endpoint, not just the mount', async () => {
    const fake = runnerFake({ control: publishedControl, result: publishedResult });
    await candidateContainerStorage(fake.ports).attach();
    expect(fake.starts[0]?.command).toContain("'--payload-url' 'http://r2.internal/BACKUP_BUCKET'");
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
    'repairs same-container %s without materializing its head, and answers what it serves',
    async (_name, health) => {
      const fake = runnerFake({ health: [health] });
      const storage = candidateContainerStorage(fake.ports);
      if (storage.repairAttached === undefined) throw new Error('candidate storage has no attached repair');

      // An empty control, so the repair answers what the cold attach answers:
      // the durable attach row a wake writes from this must say the same
      // thing a full attach of the same box would have said.
      await expect(storage.repairAttached()).resolves.toEqual({
        kind: 'empty',
        detail: 'candidate control has no published head',
      });

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

  test('reseeds a healthy daemon after a head commit without replacing its container, naming the head it serves', async () => {
    const place = paths('healthy-reseed');
    try {
      const host = new Host('box-bounded-layers', place.store);
      const journal = new MutationLog();
      await journal.perform({
        op: 'write', path: 'state.txt', content: { kind: 'dense', bytes: enc.encode('published') },
      });
      await checkpoint(host, 'bounded-layers', place, journal, 'published');
      const control = await host.restoreControl();
      const root = control.head?.pointer.rootEnvelopeId;
      if (root === undefined) throw new Error('the reseed fixture published no head');
      const fake = runnerFake({ control });
      const storage = candidateContainerStorage(fake.ports);
      if (storage.repairAttached === undefined) throw new Error('candidate storage has no attached repair');

      // THE ANSWER A WAKE WRITES DOWN. `attached`, naming the head, in the
      // same terms `attach` uses — with `repaired` where a restore would say
      // `restored`, because nothing was materialized: the tree never left the
      // instance disk. A repair that answered nothing left the durable row
      // saying whatever the last full attach found, which on the deployed
      // merkle-pack wake of run 20260902154130 was the cold attach's `empty`.
      await expect(storage.repairAttached()).resolves.toEqual({
        kind: 'attached',
        detail: `repaired candidate root ${root}`,
      });

      expect(fake.mounts()).toBe(0);
      expect(fake.stops()).toBe(0);
      expect(fake.journals()).toBe(0);
      expect(fake.restores()).toBe(1);
      expect(fake.starts).toHaveLength(1);
      expect(fake.starts[0]?.command).toContain("'--action' 'seed'");
      const controlPath = /'--control' '([^']+)'/.exec(fake.starts[0]?.command ?? '')?.[1];
      const written = controlPath === undefined ? undefined : fake.controls.get(controlPath);
      if (written === undefined) throw new Error('candidate repair omitted its control snapshot');
      expect(JSON.parse(written).head.pointer.rootEnvelopeId).toBe(root);
    } finally {
      await rm(join(place.workspace, '..'), { recursive: true, force: true });
    }
  });

  test('leaves a live checkpoint runner and healthy attachments untouched, and still answers what it serves', async () => {
    const checkpoint: CandidateRunnerProcess = {
      id: 'checkpoint-live',
      getLogs: async () => ({ stdout: '', stderr: '' }),
    };
    const fake = runnerFake({ activeCheckpoint: checkpoint });
    const storage = candidateContainerStorage(fake.ports);
    if (storage.repairAttached === undefined) throw new Error('candidate storage has no attached repair');

    await expect(storage.repairAttached()).resolves.toEqual({
      kind: 'empty',
      detail: 'candidate control has no published head',
    });

    // Nothing in the CONTAINER is touched: no mount, no daemon replaced, no
    // runner started under the one that owns the journal. The one read is
    // the durable control the answer is derived from.
    expect(fake.mounts()).toBe(0);
    expect(fake.stops()).toBe(0);
    expect(fake.journals()).toBe(0);
    expect(fake.restores()).toBe(1);
    expect(fake.starts).toHaveLength(0);
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
      // THE DAEMON SPEAKS v2: the manifest is a delta whose rows are the whole
      // tree (no boundary map yet, no base), and the stage holds the bytes
      // under the paths the rows name — the fence's own layout.
      const stage = join(place.journal, 'stage');
      await mkdir(stage, { recursive: true });
      const bytes = enc.encode('journaled bytes');
      await writeFile(join(stage, 'notes.txt'), bytes);
      const manifestPath = join(place.journal, 'fence-7.json');
      await writeFile(manifestPath, JSON.stringify({
        version: 2,
        cut: 7,
        generation: 3,
        stageRoot: stage,
        base: null,
        entries: [{
          ino: '2',
          path: 'notes.txt',
          kind: 'file',
          size: bytes.byteLength,
          mode: 0o644,
          uid: process.getuid?.() ?? 0,
          gid: process.getgid?.() ?? 0,
          atimeNs: '0',
          mtimeNs: '0',
          ctimeNs: '0',
          xattrs: {},
          whole: true,
          dirty: [{ offset: 0, length: bytes.byteLength }],
          ranges: [{ offset: 0, length: bytes.byteLength, sha256: sha256Hex(bytes) }],
        }],
        metadataOps: [],
        sealWork: FENCE_SEAL_WORK,
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
          version: 2,
          cut: 7,
          generation: 3,
          stageRoot: divergentStage,
          base: { cut: '7', generation: '3', root: publishedRoot },
          entries: [],
          metadataOps: [],
          sealWork: FENCE_SEAL_WORK,
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
        const lowerManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        lowerManifest.cut = 6;
        await writeFile(lowerManifestPath, JSON.stringify(lowerManifest));
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

  test('fences a v2 delta manifest and publishes it incrementally against the head', async () => {
    const place = paths('journal-delta');
    try {
      await mkdir(place.journal, { recursive: true });
      // The first fence's stage: the daemon seeds nothing, so its delta has no
      // base and its rows ARE the whole tree (whole-file staging for a file
      // with no boundary map — journal_stage_plan, journal-delta.c).
      const firstStage = join(place.journal, 'stage-g1-c1');
      await mkdir(firstStage, { recursive: true });
      await mkdir(join(firstStage, 'pkg'), { recursive: true });
      const keptBytes = enc.encode('the untouched generation one bytes');
      await writeFile(join(firstStage, 'pkg/kept.bin'), keptBytes);
      const changedBytes = enc.encode('generation one');
      await writeFile(join(firstStage, 'pkg/changed.bin'), changedBytes);
      const doomedBytes = enc.encode('to be removed');
      await writeFile(join(firstStage, 'pkg/doomed.bin'), doomedBytes);
      const firstManifest = join(place.journal, 'fence-c1-g1.json');
      await writeFile(firstManifest, JSON.stringify({
        version: 2,
        cut: 1,
        generation: 1,
        stageRoot: firstStage,
        base: null,
        entries: [
          deltaDir('pkg'),
          deltaFile('pkg/kept.bin', keptBytes),
          deltaFile('pkg/changed.bin', changedBytes),
          deltaFile('pkg/doomed.bin', doomedBytes),
        ],
        metadataOps: [],
        sealWork: FENCE_SEAL_WORK,
      }));
      let close = await journalControl(join(place.journal, 'control.sock'), {
        cut: 1, generation: 1, manifestPath: firstManifest,
      });
      let closed = false;
      const stopJournal = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await close();
      };
      const host = new Host('box-bounded-layers', place.store);

      try {
        // FIRST CHECKPOINT: no published head, so the delta publishes as a
        // whole-tree capture and the head lands.
        const begun = await host.begin();
        const first = staged(await runCandidate(runOptions('bounded-layers', place, begun)));
        expect(first.draft.capturedCut.cut).toBe('1');
        expect(first.movedBytes).toBeGreaterThan(0);
        const finalized = await host.finalize(first.draft);
        expect(finalized.operation?.phase).toBe('published');
        const head = finalized.head;
        if (head === null || head === undefined) throw new Error('the first checkpoint published no head');

        // SECOND FENCE: a real v2 delta — base names the published head, only
        // the touched paths appear, and the digest of every staged byte is the
        // fence's own record. The unlinked file has no row: the daemon writes
        // a row for a path present at the cut and nothing else
        // (`journal-delta.c`, `stat_touched`), so its removal is the op alone.
        await stopJournal();
        const secondStage = join(place.journal, 'stage-g2-c2');
        await mkdir(secondStage, { recursive: true });
        const nextBytes = enc.encode('generation two');
        await mkdir(join(secondStage, 'pkg'), { recursive: true });
        await writeFile(join(secondStage, 'pkg/changed.bin'), nextBytes);
        const secondManifest = join(place.journal, 'fence-c2-g2.json');
        await writeFile(secondManifest, JSON.stringify({
          version: 2,
          cut: 2,
          generation: 2,
          stageRoot: secondStage,
          base: { cut: '1', generation: '1', root: head.rootEnvelopeId },
          entries: [
            deltaDir('pkg'),
            deltaFile('pkg/changed.bin', nextBytes),
          ],
          metadataOps: [
            { sequence: 1, op: 'unlink', path: 'pkg/doomed.bin', argument: '', result: 0 },
          ],
          sealWork: FENCE_SEAL_WORK,
        }));
        close = await journalControl(join(place.journal, 'control.sock'), {
          cut: 2, generation: 2, manifestPath: secondManifest,
          base: { cut: '1', generation: '1', root: head.rootEnvelopeId },
        });

        // THE INCREMENTAL CHECKPOINT: the delta names one changed file and one
        // removal, so the second publish moves the CHANGED bytes only and holds
        // everything else from the parent. The proof is the object SET: the
        // second publish stages a fresh chunk for the changed bytes and a layer
        // document — and NOT a fresh chunk for the kept bytes, which a
        // whole-tree capture of this state would have had to stage again.
        const second = staged(await runCandidate(runOptions('bounded-layers', place, await host.begin())));
        expect(second.draft.capturedCut.cut).toBe('2');
        expect(second.movedBytes).toBeGreaterThan(0);
        // THE INCREMENTAL PROOF, on the bytes themselves: the second publish
        // staged the changed bytes and the layer document — and did NOT stage
        // the kept file's bytes again, which is what a whole-tree capture of
        // this state would have had to do.
        const stagedBytes = new Set(
          await Promise.all(second.draft.dependencyReceipts.map(async (receipt) =>
            new TextDecoder().decode(await readFile(join(place.store, receipt.key)))),
        ),
        );
        expect(stagedBytes.has('generation two')).toBe(true);
        expect(stagedBytes.has('the untouched generation one bytes')).toBe(false);
        const settled = await host.finalize(second.draft);
        expect(settled.operation?.phase).toBe('published');

        // THE MERGE, through the real restore: kept.bin survives the partial
        // capture, changed.bin is the new bytes, doomed.bin is gone.
        await stopJournal();
        const restore = await runCandidate({
          ...runOptions('bounded-layers', place, await host.restoreControl()),
          action: 'restore',
        });
        expect(restored(restore).rootId).toBe(settled.head?.rootEnvelopeId ?? null);
        expect(await readFile(join(place.workspace, 'pkg/kept.bin'), 'utf8')).toBe('the untouched generation one bytes');
        expect(await readFile(join(place.workspace, 'pkg/changed.bin'), 'utf8')).toBe('generation two');
        await expect(readFile(join(place.workspace, 'pkg/doomed.bin'))).rejects.toThrow();
      } finally {
        await stopJournal();
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

  test('the container entry point restores a 1000-file head whose control snapshot is above the argv cap', async () => {
    const place = paths('cli');
    try {
      await mkdir(place.workspace, { recursive: true });
      const host = new Host('box-cli', place.store);
      const journal = new MutationLog();
      // The bench's `small-create-1k` shape: one object per file, so the head's
      // closure alone is 1,002 refs. On argv that snapshot was refused by the
      // kernel with E2BIG (one argv string is capped at 131,072 bytes), which
      // is the size a deployed bounded-layers box reached at its first publish
      // and the reason it never restored a non-empty tree.
      await journal.perform({ op: 'mkdir', path: 'k' });
      for (let index = 0; index < 1000; index += 1) {
        await journal.perform({
          op: 'write', path: `k/f${String(index).padStart(4, '0')}.txt`, content: { kind: 'dense', bytes: enc.encode(`file ${index}`) },
        });
      }
      const published = await checkpoint(host, 'bounded-layers', place, journal, 'cli');
      const publishedRoot = published.finalized.head?.rootEnvelopeId;
      await rm(place.workspace, { recursive: true, force: true });

      const slot = join(place.workspace, '..', 'runner-slot');
      await mkdir(slot, { recursive: true });
      const controlPath = join(slot, 'control.json');
      const resultPath = join(slot, 'result.json');
      const writeControl = async (control: CandidateRunControlV1): Promise<string> => {
        const snapshot = JSON.stringify(control);
        await writeFile(controlPath, snapshot);
        return snapshot;
      };
      const argv = (action: string) => [
        'bun', RUNNER,
        '--action', action,
        '--format', 'bounded-layers',
        '--workspace', place.workspace,
        '--store', place.store,
        '--stage', place.stage,
        '--box', 'box-cli',
        '--journal-socket', join(place.journal, 'control.sock'),
        '--control', controlPath,
        '--result', resultPath,
      ];
      const snapshot = await writeControl(await host.restoreControl());
      expect(Buffer.from(snapshot, 'utf8').toString('base64').length).toBeGreaterThanOrEqual(131_072);
      const restore = Bun.spawn({ cmd: argv('restore'), stdout: 'pipe', stderr: 'pipe' });
      expect(await restore.exited).toBe(0);
      expect(await new Response(restore.stdout).text()).toBe('');
      const reply: unknown = JSON.parse(await readFile(resultPath, 'utf8'));
      expect(reply).toMatchObject({ ok: true, rootId: publishedRoot });
      const receipt = v.parse(v.object({ work: CandidateRestoreWorkSchema, bound: CandidateRestoreBoundSchema }), reply);
      expect(receipt.bound.pathsResolved).toBe(1001);
      expect(await readFile(join(place.workspace, 'k', 'f0000.txt'), 'utf8')).toBe('file 0');
      expect(await readFile(join(place.workspace, 'k', 'f0999.txt'), 'utf8')).toBe('file 999');

      // No daemon answers this container, so the checkpoint refuses instead of
      // inventing a capture, and its incomplete result never becomes visible.
      await writeControl(await host.begin());
      const checkpointRun = Bun.spawn({ cmd: argv('checkpoint'), stdout: 'pipe', stderr: 'pipe' });
      expect(await checkpointRun.exited).toBe(1);
      expect(await new Response(checkpointRun.stdout).text()).toBe('');
      expect(await new Response(checkpointRun.stderr).text()).toContain('candidate capture unavailable');
    } finally {
      await rm(join(place.workspace, '..'), { recursive: true, force: true });
    }
  });
});

// ── the publish path ──────────────────────────────────────────────────────────
//
// Run 20260905075659 spent 516 s on the bounded-layers 64 MiB quiesce and no
// decisive checkpoint settled in 25 min. Every object went through the FUSE
// mount four times: the sink wrote it there, the upload re-read it, wrote it
// to a temporary name, renamed it (an s3fs copy plus delete), and then read
// the whole object back for its digest. Through s3fs each of those is a store
// request. This test measures the two halves a local directory can show:
// what names the store ever sees, and how many bytes the process reads back.

/** Bytes this process has read through read syscalls, as Linux accounts them. */
async function bytesRead(): Promise<number> {
  const match = /^rchar: (\d+)$/m.exec(await Bun.file('/proc/self/io').text());
  if (match === null) throw new Error('/proc/self/io carries no rchar row');
  return Number(match[1]);
}

describe('the publish path moves each object once', () => {
  test('a runner sends one store PUT per object without existence probes', async () => {
    const place = paths('direct-publish');
    const egress = new EgressFake();
    try {
      const host = new Host('box-direct-publish', place.store);
      const journal = new MutationLog();
      for (let index = 0; index < 24; index += 1) {
        await journal.perform({
          op: 'write', path: `file-${index}.txt`,
          content: { kind: 'dense', bytes: enc.encode(`file ${index}`) },
        });
      }
      const begun = await host.begin();
      const operation = transferringOperation(begun);
      const options = { ...runOptions('bounded-layers', place, begun), payloadUrl: egress.url };
      const publication = await publishCapturedCandidate(options, captureFor(journal, {
        captureId: operation.operationId, epoch: operation.epoch, baseRevision: operation.baseRevision,
      }, 'direct-publish'));
      const refs = [...publication.draft.dependencyReceipts, publication.draft.rootReceipt];
      expect(egress.requests.length / refs.length).toBe(1);
      expect([...egress.requests].sort()).toEqual(refs.map(ref => `PUT /STORE/${ref.key}`).sort());
      expect(egress.requests.at(-1)).toBe(`PUT /STORE/${publication.draft.root.key}`);
      for (const ref of refs) {
        const object = egress.objects.get(ref.key);
        expect(object?.bytes.byteLength).toBe(Number(ref.byteLength));
        expect(sha256Hex(object!.bytes)).toBe(ref.sha256);
      }
    } finally {
      await egress.stop();
      await rm(join(place.workspace, '..'), { recursive: true, force: true });
    }
  });

  test('a checkpoint writes every object at its own key, once, and never reads it back', async () => {
    const place = paths('publish-path');
    const data = 8 * 1024 * 1024;
    try {
      await mkdir(place.workspace, { recursive: true });
      await mkdir(place.store, { recursive: true });
      const host = new Host('box-publish-path', place.store);
      const journal = new MutationLog();
      const bytes = new Uint8Array(data);
      for (let at = 0; at < bytes.byteLength; at += 4096) bytes[at] = (at / 4096) % 251 + 1;
      await journal.perform({ op: 'write', path: 'blob.bin', content: { kind: 'dense', bytes } });
      const begun = await host.begin();
      const operation = transferringOperation(begun);
      const names = new Set<string>();
      const watcher = watch(place.store, { recursive: true }, (_event, name) => {
        if (name !== null) names.add(String(name));
      });
      const readBefore = await bytesRead();
      const publication = await publishCapturedCandidate(
        runOptions('bounded-layers', place, begun),
        captureFor(journal, {
          captureId: operation.operationId,
          epoch: operation.epoch,
          baseRevision: operation.baseRevision,
        }, 'publish-path'),
      );
      const readAfter = await bytesRead();
      // inotify delivers on the kernel's schedule and exposes no completion
      // signal, so the only way to see the last event is to let the clock run.
      const drained = Promise.withResolvers<void>();
      setTimeout(drained.resolve, 200);
      await drained.promise;
      watcher.close();
      expect(publication.draft.dependencyReceipts.length).toBeGreaterThanOrEqual(16);
      // Every name the store saw is an object key or the directory holding one.
      const strangers = [...names].filter((name) => !/^[a-z]+(\/[0-9a-f]{64})?$/.test(name)).sort();
      expect(strangers).toEqual([]);
      // The upload streams each object from the container's own disk once; a
      // read-back for the digest would double it.
      expect(readAfter - readBefore).toBeLessThan(1.5 * data);
    } finally {
      await rm(join(place.workspace, '..'), { recursive: true, force: true });
    }
  });

  test('dependencies upload side by side, the root after all of them', async () => {
    const inFlight = { now: 0, peak: 0 };
    const order: string[] = [];
    const store = {
      issuePayloadGrant: async (intent: UploadIntent) => ({
        operationId: intent.operationId,
        attemptId: intent.attemptId,
        expiresAt: intent.expiresAt,
        opaque: intent.exactKey,
      }),
      uploadObject: async (grant: PayloadGrant, body: ReadableStream<Uint8Array>) => {
        inFlight.now += 1;
        inFlight.peak = Math.max(inFlight.peak, inFlight.now);
        // One microtask turn is enough: a pool starts its whole width before
        // any upload gets this far, and a serial loop never starts a second.
        await Promise.resolve();
        const bytes = await new Response(body).bytes();
        inFlight.now -= 1;
        order.push(grant.opaque);
        return {
          operationId: grant.operationId,
          attemptId: grant.attemptId,
          key: grant.opaque,
          byteLength: String(bytes.byteLength),
          sha256: sha256Hex(bytes),
          etag: `test-${grant.opaque.slice(-8)}`,
          verified: true as const,
        };
      },
    };
    const journal = new MutationLog();
    for (let index = 0; index < 24; index += 1) {
      await journal.perform({ op: 'write', path: `file-${index}.txt`, content: { kind: 'dense', bytes: enc.encode(`file ${index}`) } });
    }
    const capture = captureFor(journal, { captureId: 'op-parallel', epoch: '1', baseRevision: '0' }, 'parallel');
    const built = await buildBoundedLayers(capture);
    const draft = await stageCandidatePayload(built.plan, {
      operationId: 'op-parallel', attemptId: 'try-1', boxId: 'box-parallel', epoch: '1', bootId: 'boot-1', kind: 'tick', expiresAt: String(Date.now() + 60_000),
    }, store);
    expect(draft.dependencyReceipts.length).toBe(built.plan.dependencies.length);
    expect(inFlight.peak).toBeGreaterThan(1);
    expect(inFlight.peak).toBeLessThanOrEqual(16);
    expect(order.indexOf(draft.root.key)).toBe(built.plan.dependencies.length);
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

    async readRun(run: PackRun): Promise<Uint8Array> {
      await this.barrier.hold();
      const bytes = Bun.file(join(this.store, run.key)).slice(run.offset, run.offset + run.length);
      return new Uint8Array(await bytes.arrayBuffer());
    }
  }

  /** One published tree with a hardlinked pair, a subdirectory and enough
   *  siblings for a walk to have something to overlap. */
  async function publishTree(place: RunnerPlace) {
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

  test('a tree with NO files restores, rather than a pool waiting on zero work', async () => {
    // THE HYPOTHESIS THIS RETIRES. When merkle-pack cold attach hung at its
    // 25,000 ms ceiling in `e2e20260901140445`, the first suspicion was this
    // walk's materialization pool spinning up zero workers and never
    // resolving. It does not: the pool is sized `min(width, queued.length)`,
    // so an empty queue makes `Promise.all([])`, and the phase notes below
    // prove the walk ran and reached its end with no file in it.
    //
    // Worth a test rather than a reading, because "restores nothing" is a real
    // shape — a checkpoint of a tree that holds only directories — and it is
    // the one shape every other test in this file lacks.
    const place = paths('merkle-no-files');
    try {
      await mkdir(place.workspace, { recursive: true });
      const host = new Host('box-merkle-no-files', place.store);
      const journal = new MutationLog();
      await journal.perform({ op: 'mkdir', path: 'pkg' });
      await journal.perform({ op: 'mkdir', path: 'pkg/nested' });
      await checkpoint(host, 'merkle-pack', place, journal, 'merkle-no-files');
      const head = (await host.restoreControl()).head;
      if (head === null) throw new Error('the published file-less head did not come back');

      const store = new HoldingStore(place.store, 1);
      const manifestBytes = await store.readRange({
        operationId: 'restore-no-files', attemptId: '1', boxId: 'box-merkle-no-files',
        epoch: head.envelope.epoch, exactKey: head.envelope.rootObject.key, method: 'GET',
        byteOffset: '0', byteLength: head.envelope.rootObject.byteLength,
        sha256: head.envelope.rootObject.sha256, expiresAt: String(Date.now() + 60_000),
      });
      const view = await openMerklePack({ rootId: sha256Hex(manifestBytes), manifestBytes }, store, {
        operationId: 'restore-no-files', attemptId: '1', boxId: 'box-merkle-no-files',
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

      expect(notes.join(', ')).toMatch(/tree walk \(2 dirs, 0 files, 0 links\) \d+ ms/);
      // The LAST phase is the one that proves it got past the pool: a walk that
      // parked in materialization would never append this note at all.
      expect(notes.join(', ')).toMatch(/data \(0 bytes\) \d+ ms, directory metadata \d+ ms/);
      expect(await readdir(join(place.workspace, 'pkg'))).toEqual(['nested']);
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
describe('a restore counts the work it did', () => {
  const workSchema = v.object({
    serialRemoteOps: v.nullable(v.number()),
    totalRemoteOps: v.number(),
    metadataBytes: v.number(),
    payloadBytes: v.number(),
    cpuSteps: v.number(),
    replayUnits: v.number(),
  });
  const boundSchema = v.object({
    openReads: v.number(),
    layersConsulted: v.nullable(v.number()),
    maxNodeDepth: v.nullable(v.number()),
    nodeFetches: v.nullable(v.number()),
    pathsResolved: v.number(),
  });
  test.each(['bounded-layers', 'merkle-pack'] as const)(
    '%s reports measured store reads, bytes, and materialized entries',
    async (format) => {
      const place = paths(`restore-work-${format}`);
      try {
        await mkdir(place.workspace, { recursive: true });
        const host = new Host(`box-restore-work-${format}`, place.store);
        const journal = new MutationLog();
        const first = enc.encode('restore work first file');
        const second = enc.encode('second');
        await journal.perform({ op: 'write', path: 'a.txt', content: { kind: 'dense', bytes: first } });
        await journal.perform({ op: 'write', path: 'b.txt', content: { kind: 'dense', bytes: second } });
        await checkpoint(host, format, place, journal, `restore-work-${format}`);
        await rm(place.workspace, { recursive: true, force: true });
        const reply = restored(await runCandidate({
          ...runOptions(format, place, await host.restoreControl()),
          action: 'restore',
        }));
        expect(await readFile(join(place.workspace, 'a.txt'), 'utf8')).toBe('restore work first file');
        expect(await readFile(join(place.workspace, 'b.txt'), 'utf8')).toBe('second');
        if (!('work' in reply) || reply.work === undefined) {
          throw new Error(`restore reported no measured work: ${JSON.stringify(reply)}`);
        }
        const work = v.parse(workSchema, reply.work);
        if (!('bound' in reply) || reply.bound === undefined) {
          throw new Error(`restore reported no bound evidence: ${JSON.stringify(reply)}`);
        }
        const bound = v.parse(boundSchema, reply.bound);
        const fileBytes = first.byteLength + second.byteLength;
        expect(work.totalRemoteOps).toBeGreaterThanOrEqual(2);
        expect(work.metadataBytes).toBeGreaterThan(0);
        expect(work.payloadBytes).toBeGreaterThanOrEqual(fileBytes);
        expect(work.cpuSteps).toBe(2);
        expect(work.replayUnits).toBeGreaterThanOrEqual(1);
        expect(bound.pathsResolved).toBe(2);
        if (format === 'bounded-layers') {
          expect(work.serialRemoteOps).toBe(work.totalRemoteOps);
          expect(bound.layersConsulted).toBeGreaterThanOrEqual(1);
          // The root is the newest layer, so one read per layer consulted.
          expect(bound.openReads).toBe(bound.layersConsulted ?? 0);
          if (bound.layersConsulted === null) throw new Error('a bounded restore left layersConsulted null');
          expect(work.replayUnits).toBe(bound.layersConsulted);
        } else {
          // The walk pages through pools, so the critical path is shorter
          // than the total and longer than the two opening reads.
          expect(work.serialRemoteOps).toBeGreaterThan(2);
          expect(work.serialRemoteOps).toBeLessThanOrEqual(work.totalRemoteOps);
          expect(bound.maxNodeDepth).toBe(2);
          expect(bound.nodeFetches).toBeGreaterThanOrEqual(2);
          expect(bound.nodeFetches ?? 0).toBeLessThanOrEqual(bound.pathsResolved * (bound.maxNodeDepth ?? 0));
        }
      } finally {
        await rm(join(place.workspace, '..'), { recursive: true, force: true });
      }
    },
  );
});

describe('a live restore bills by tree size', () => {
  const workSchema = v.object({
    serialRemoteOps: v.nullable(v.number()),
    totalRemoteOps: v.number(),
    metadataBytes: v.number(),
    payloadBytes: v.number(),
    cpuSteps: v.number(),
    replayUnits: v.number(),
  });
  test.each(['bounded-layers', 'merkle-pack'] as const)(
    '%s charges a larger tree more: the container path materializes every byte',
    async (format) => {
      const smallPlace = paths(`restore-scale-small-${format}`);
      const largePlace = paths(`restore-scale-large-${format}`);
      try {
        const publish = async (label: string, place: RunnerPlace, files: number) => {
          await mkdir(place.workspace, { recursive: true });
          const host = new Host(`box-${label}`, place.store);
          const journal = new MutationLog();
          for (let index = 0; index < files; index += 1) {
            await journal.perform({
              op: 'write',
              path: `f-${index}.txt`,
              content: { kind: 'dense', bytes: enc.encode(`file ${index} bytes`) },
            });
          }
          await checkpoint(host, format, place, journal, label);
          return host;
        };
        const restoreWork = async (
          place: RunnerPlace,
          host: Host,
        ) => {
          await rm(place.workspace, { recursive: true, force: true });
          const reply = restored(await runCandidate({
            ...runOptions(format, place, await host.restoreControl()),
            action: 'restore',
          }));
          if (!('work' in reply) || reply.work === undefined) {
            throw new Error(`restore reported no measured work: ${JSON.stringify(reply)}`);
          }
          return v.parse(workSchema, reply.work);
        };
        const smallHost = await publish(`restore-scale-small-${format}`, smallPlace, 2);
        const small = await restoreWork(smallPlace, smallHost);
        expect(await restoreWork(smallPlace, smallHost)).toEqual(small);
        const largeHost = await publish(`restore-scale-large-${format}`, largePlace, 60);
        const large = await restoreWork(largePlace, largeHost);
        expect(large.totalRemoteOps).toBeGreaterThan(small.totalRemoteOps);
        expect(large.payloadBytes).toBeGreaterThan(small.payloadBytes);
        expect(large.cpuSteps).toBeGreaterThan(small.cpuSteps);
      } finally {
        await rm(join(smallPlace.workspace, '..'), { recursive: true, force: true });
        await rm(join(largePlace.workspace, '..'), { recursive: true, force: true });
      }
    },
  );
});
describe('a counted restore rides the attach detail', () => {
  test('a result with work serves the head with its receipt', async () => {
    const place = paths('restore-receipt');
    try {
      await mkdir(place.workspace, { recursive: true });
      const host = new Host('box-restore-receipt', place.store);
      const journal = new MutationLog();
      await journal.perform({ op: 'write', path: 'state.txt', content: { kind: 'dense', bytes: enc.encode('receipt') } });
      await checkpoint(host, 'bounded-layers', place, journal, 'restore-receipt');
      const control = await host.restoreControl();
      const root = control.head?.pointer.rootEnvelopeId;
      if (root === undefined) throw new Error('the receipt fixture published no head');
      const work = {
        serialRemoteOps: 4,
        totalRemoteOps: 4,
        metadataBytes: 585,
        payloadBytes: 7,
        cpuSteps: 1,
        replayUnits: 1,
      };
      const bound = {
        openReads: 2,
        layersConsulted: 1,
        maxNodeDepth: null,
        nodeFetches: null,
        pathsResolved: 1,
      };
      const fake = runnerFake({ control, result: JSON.stringify({ ok: true, rootId: root, work, bound }) });
      const attached = await candidateContainerStorage(fake.ports).attach();
      expect(attached.kind).toBe('attached');
      const prefix = `restored candidate root ${root} work `;
      if (!attached.detail.startsWith(prefix)) throw new Error(`attach detail carries no receipt: ${attached.detail}`);
      const parsed: unknown = JSON.parse(attached.detail.slice(prefix.length));
      expect(parsed).toEqual({ work, bound });
    } finally {
      await rm(join(place.workspace, '..'), { recursive: true, force: true });
    }
  });
});