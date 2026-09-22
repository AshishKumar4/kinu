/** Two bounded storage cells reusing the decisive bench's Worker, lifecycle, C3 writer and meter.
 *  Not a strategy ranking and not a substitute for the full G1–G10 admission matrix. */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BENCH_ACCOUNT_ID, CELL_STARTUP_MS, SANDBOX_IMAGE, boxName, boxState, checkpointOperation,
  cleanupObservationProbes, createFixtureResources, deployFixture, describeIncidentReasons, destroyBox,
  drainBucketResidue, execInBox, measureLiveC3, orphanTeardownExecutor, r2ResiduePlane, readBlockAttachMetrics, readIncidentReasons,
  readRestoreProbe, sourceRevision, startupOperation, teardownLiveArms, writeFileInBox,
  type Fixture, type IncidentReasonRow, type SourceRevision, type StartupCompletion, type StartupObservation, type StateReply,
} from './bench-devbox-strategies';
import { evaluateLiveC3, type BlockAttachMetrics, type LiveC3Observation } from '../packages/devbox/bench/c3-result';
import type { RestorePhaseStamps } from '../packages/devbox/src/durability/contracts';
import type { StartupState } from '../packages/devbox/bench/observation-schema';
import { containerAppIds, delay, deleteContainerApps, publishTeardown, runTeardownOnce, runWrangler } from './fixtures/r2-bench/deploy-substrate';
import { createManifest, recoverAbandonedRuns, replayTeardown, writeManifest, type DeleteOutcome } from './fixtures/storage-matrix/cleanup';

const REPO = new URL('..', import.meta.url).pathname;

const LARGE_BYTES = 2 * 1024 * 1024 * 1024;

export { CELL_STARTUP_MS } from './bench-devbox-strategies';

export function chunkedPublicationErrors(chain: StartupState['chain']): string[] {
  if (chain?.deltaFormat === 'chunked') return [];
  const fallback = chain?.deltaFallback;

  return [`expected deltaFormat:chunked; ${fallback === undefined ? 'fallback reason unobserved' : `${fallback.reason}: ${fallback.detail}`}`];
}

interface AttachSample {
  phases?: RestorePhaseStamps;
  blockReads?: BlockAttachMetrics | null;
}

export function storageAttachMilliseconds(phases: RestorePhaseStamps | undefined): number | null {
  const start = phases?.containerStart;
  const end = phases?.attached;

  if (start === undefined || end === undefined || end < start) return null;

  return end - start;
}

export function boundedAttachErrors(sample: AttachSample): string[] {
  const errors: string[] = [];
  const time = storageAttachMilliseconds(sample.phases);

  if (time === null) errors.push('storage attach phases were not observed');
  else if (time > 30_000) errors.push(`storage attach exceeded 30 seconds: ${time} ms`);

  if (sample.blockReads === undefined || sample.blockReads === null) errors.push('block payload counters were not observed');
  else if (sample.blockReads.payloadBytes !== 0 || sample.blockReads.indexPages !== 0) errors.push('attach read a payload or override-index page');

  return errors;
}

interface LargeObservation {
  box: string;
  bytes: number;
  representation: string;
  initial: StartupCompletion | null;
  restoration: StartupCompletion | null;
  restoreProbe: Awaited<ReturnType<typeof readRestoreProbe>> | null;
  blockReads: BlockAttachMetrics | null;
  baseline: Awaited<ReturnType<typeof checkpointOperation>> | null;
  checkpoint: Awaited<ReturnType<typeof checkpointOperation>> | null;
  fileProbe: Awaited<ReturnType<typeof execInBox>> | null;
  expectedFile: Awaited<ReturnType<typeof execInBox>> | null;
  publication: Awaited<ReturnType<typeof boxState>> | null;
  errors: string[];
}

async function measureLarge(fixture: Fixture, box: string, observe: (row: LargeObservation) => void): Promise<LargeObservation> {
  const sparseControl = process.argv.includes('--sparse-control');
  const name = `2GiB ${sparseControl ? 'sparse' : 'dense'}`;

  const row: LargeObservation = { box, bytes: LARGE_BYTES, representation: sparseControl ? 'mostly-zero whole record in chunked delta/tree' : 'random dense changed file in block-lower',
    initial: null, restoration: null, restoreProbe: null, blockReads: null, baseline: null, checkpoint: null, fileProbe: null, expectedFile: null, publication: null, errors: [] };

  const probe = `
const fs = require('fs');
const { createHash } = require('crypto');
const fd = fs.openSync('/workspace/vol/large.bin', 'r');
try {
  if (fs.fstatSync(fd).size !== ${LARGE_BYTES}) throw Error('wrong file size');
  const ranges = [0, 8388608, ${LARGE_BYTES - 65536}].map(position => {
    const bytes = Buffer.alloc(65536);
    if (fs.readSync(fd, bytes, 0, bytes.length, position) !== bytes.length) throw Error('short range at ' + position);
    return { position, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  console.log(JSON.stringify({size: ${LARGE_BYTES}, ranges}));
} finally { fs.closeSync(fd); }
`;

  const readFile = async () => {
    await writeFileInBox(fixture, box, '/tmp/block-large-probe.cjs', probe);
    const reply = await execInBox(fixture, box, 'node /tmp/block-large-probe.cjs');

    if (reply.ok !== true || reply.exitCode !== 0 || !reply.stdout?.trim()) throw new Error(`file verification failed: ${reply.error ?? reply.stderr}`);

    return reply;
  };

  observe(row);

  const command = async (text: string): Promise<void> => {
    const reply = await execInBox(fixture, box, text);

    if (reply.ok !== true || reply.exitCode !== 0) throw new Error(`large-file writer failed: ${reply.error ?? reply.stderr}`);
  };

  try {
    row.initial = await startupOperation({
      fixture,
      box,
      path: '/create',
      operation: `${name} baseline`,
      allowedKinds: ['empty'],
      bounds: { deadlineMs: CELL_STARTUP_MS },
    });
    await command(`mkdir -p /workspace/vol && ${sparseControl ? `truncate -s ${LARGE_BYTES} /workspace/vol/large.bin` : 'dd if=/dev/urandom of=/workspace/vol/large.bin bs=4M count=512 conv=fsync status=none'}`);
    row.baseline = await checkpointOperation({ fixture, box, kind: 'quiesce', what: `${name} base` });

    if (row.baseline.ok !== true || row.baseline.outcome?.kind !== 'committed') throw new Error(`large-file baseline was not committed: ${row.baseline.error ?? row.baseline.outcome?.reason}`);
    await command('dd if=/dev/urandom of=/workspace/vol/large.bin bs=16384 count=4 seek=512 conv=notrunc,fsync status=none');
    row.expectedFile = await readFile();
    row.checkpoint = await checkpointOperation({ fixture, box, kind: 'quiesce', what: `${name} edit` });

    if (row.checkpoint.ok !== true || row.checkpoint.outcome?.kind !== 'committed') throw new Error(`large-file edit was not committed: ${row.checkpoint.error ?? row.checkpoint.outcome?.reason}`);
    const before = row.publication = await boxState(fixture, box);
    const formatErrors = chunkedPublicationErrors(before.state?.chain);

    if (formatErrors.length) throw new Error(formatErrors.join('; '));
    const destroyed = await destroyBox(fixture, box);

    if (destroyed.ok !== true || destroyed.destroyed !== true) throw new Error('large-file container destruction was not proved');
    row.restoration = await startupOperation({
      fixture,
      box,
      path: '/wake',
      operation: `${name} cold restore`,
      allowedKinds: ['attached'],
      bounds: { deadlineMs: CELL_STARTUP_MS },
    });
    const boot = row.restoration.state.state?.bootId;

    if (boot === undefined || boot === before.state?.bootId) throw new Error('large-file restore was not genuinely cold');
    row.errors.push(...chunkedPublicationErrors(row.restoration.state.state?.chain));
    row.restoreProbe = await readRestoreProbe({
      fixture,
      box,
      kind: 'destroy-cold-restore',
      treeBytes: LARGE_BYTES,
      notes: row.errors,
      notBefore: row.restoration.startedAt,
    });
    row.blockReads = await readBlockAttachMetrics(fixture, box);
    observe(row);
    row.fileProbe = await readFile();

    if (row.fileProbe.stdout?.trim() !== row.expectedFile.stdout?.trim()) throw new Error('restored large-file ranges differ from the checkpointed bytes');
    row.errors.push(...boundedAttachErrors({ phases: row.restoreProbe.phases, blockReads: row.blockReads }));
  } catch (cause) {
    row.errors.push(cause instanceof Error ? cause.message : String(cause));
  }

  observe(row);

  return row;
}

/** A refused cycle keeps its observations, last state and incident reasons, and the loop
 *  continues: the hang is intermittent, so one sample is not a measurement. */
interface LifecycleCycle {
  initial: StartupCompletion | null;
  exec: Awaited<ReturnType<typeof execInBox>> | null;
  observations: StartupObservation[];
  refusal: string | null;
  lastState: StateReply | null;
  incidents: IncidentReasonRow[] | null;
}

interface RunInvocation {
  accessKeyId: string;
  secretAccessKey: string;
  revision: SourceRevision;
  lifecycleOnly: boolean;
  c3Only: boolean;
  largeOnly: boolean;
}

/** What the artifact says this run measured. A selector run admits no
 *  strategy, and the artifact has to say so where it is read. */
function measuredScope(selection: Pick<RunInvocation, 'lifecycleOnly' | 'c3Only' | 'largeOnly'>): string {
  if (selection.lifecycleOnly) return 'empty attach then first exec; lifecycle attribution only';

  if (selection.c3Only) return 'one C3 storage cell; not full strategy admission';

  if (selection.largeOnly) return 'one 2GiB storage cell; not full strategy admission';

  return 'two storage cells; not full strategy admission';
}

function runInvocation(): RunInvocation {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (accessKeyId === undefined || secretAccessKey === undefined) throw new Error('provisioned R2 cleanup credentials are required before deploying');
  const revision = sourceRevision();
  const lifecycleOnly = process.argv.includes('--lifecycle');
  const c3Only = process.argv.includes('--c3-only');
  const largeOnly = process.argv.includes('--large-only');

  if ([lifecycleOnly, c3Only, largeOnly].filter(Boolean).length > 1) throw new Error('choose only one cell selector');

  if (!lifecycleOnly && !process.argv.includes('--diagnostic') && revision.dirtyDigest !== 'clean') throw new Error('commit the measured source before running the two cells');

  return { accessKeyId, secretAccessKey, revision, lifecycleOnly, c3Only, largeOnly };
}

/** Observers write rows here as the run fills them, so a mid-measurement save of
 *  `observations.json` carries the partial row. */
interface RunObservations {
  c3: LiveC3Observation | null;
  large: LargeObservation | null;
  lifecycle: LifecycleCycle[];
}

interface CellRun {
  readonly fixture: Fixture;
  readonly box: string;
  readonly observed: RunObservations;
  readonly save: () => void;
  readonly errors: string[];
}

async function runLifecycle({ fixture, box, observed, save, errors }: CellRun): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const observations: StartupObservation[] = [];
    const cycle: LifecycleCycle = { initial: null, exec: null, observations, refusal: null, lastState: null, incidents: null };
    observed.lifecycle.push(cycle);
    await destroyBox(fixture, box);

    try {
      cycle.initial = await startupOperation({
        fixture,
        box,
        path: '/create',
        operation: `lifecycle empty baseline ${attempt + 1}`,
        allowedKinds: ['empty'],
        bounds: { deadlineMs: CELL_STARTUP_MS, observations },
      });
      cycle.exec = await execInBox(fixture, box, 'mkdir -p /tmp/devbox-first-exec-witness');
    } catch (cause) {
      cycle.refusal = cause instanceof Error ? cause.message : String(cause);
    }

    cycle.incidents = (await readIncidentReasons(fixture, box, errors)) ?? null;

    try {
      cycle.lastState = await boxState(fixture, box);
    } catch (cause) {
      errors.push(`lifecycle ${attempt + 1} final state: ${cause instanceof Error ? cause.message : String(cause)}`);
    }

    if (cycle.refusal !== null) errors.push(`lifecycle ${attempt + 1}: ${cycle.refusal}; incident reasons: ${describeIncidentReasons(cycle.incidents ?? undefined)}`);
    else if (cycle.exec?.ok !== true || cycle.exec.exitCode !== 0) errors.push(`lifecycle ${attempt + 1}: ${cycle.exec?.error ?? 'first exec failed'}`);
    save();
  }
}

interface StorageCellRun extends CellRun {
  readonly largeBox: string;
  readonly runId: string;
  readonly selection: Pick<RunInvocation, 'c3Only' | 'largeOnly'>;
}

async function runCells(
  { fixture, box, largeBox, runId, selection, observed, save, errors }: StorageCellRun,
): Promise<void> {
  const { c3Only, largeOnly } = selection;

  if (!largeOnly) {
    const c3 = await measureLiveC3({
      fixture,
      box,
      runId,
      preparation: null,
      observe: row => { observed.c3 = row; save(); },
      startupBounds: { deadlineMs: CELL_STARTUP_MS },
    });

    observed.c3 = c3;
    errors.push(...evaluateLiveC3(c3).errors, ...boundedAttachErrors({ phases: c3.restoreProbe?.phases, blockReads: c3.blockReads }));
    errors.push(...chunkedPublicationErrors(c3.beforeDestroy?.state?.chain));
  }

  if (!c3Only) {
    if (!largeOnly) errors.push(...await teardownLiveArms(fixture, [box]));
    const large = await measureLarge(fixture, largeBox, row => { observed.large = row; save(); });
    observed.large = large;
    errors.push(...large.errors);
  }
}

async function run(): Promise<number> {
  const { accessKeyId, secretAccessKey, revision, lifecycleOnly, c3Only, largeOnly } = runInvocation();
  const runId = `b${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
  const artifacts = join(REPO, 'bench-artifacts', 'block-attach', runId);
  mkdirSync(artifacts, { recursive: true });
  const resources = createFixtureResources(runId, ['snapshot-chain']);
  const names = resources.arms[0];

  if (names === undefined) throw new Error('no snapshot-chain fixture');
  const box = boxName(runId, 'snapshot-chain');
  const largeBox = largeOnly ? box : `${box}-large`;
  const boxes = lifecycleOnly || c3Only || largeOnly ? [box] : [box, largeBox];

  if (!lifecycleOnly && !c3Only && !largeOnly) {
    const kinds = ['do-state', 'alarm', 'mount'] as const;
    resources.manifest.entries.push(...createManifest(runId,
      kinds.map(kind => ({ kind, name: largeBox, detail: 'independent large-file cell' })),
    ).entries);
    writeManifest(REPO, resources.manifest);
  }

  const residue = r2ResiduePlane({ accountId: BENCH_ACCOUNT_ID, accessKeyId, secretAccessKey });
  const errors: string[] = [];
  const cleanup: string[] = [];
  let live: Awaited<ReturnType<typeof deployFixture>> | null = null;
  const observed: RunObservations = { c3: null, large: null, lifecycle: [] };
  let tail: ReturnType<typeof Bun.spawn> | undefined;
  let capture: Promise<void> | undefined;

  const scope = measuredScope({ lifecycleOnly, c3Only, largeOnly });

  const save = (): void => writeFileSync(join(artifacts, 'observations.json'), JSON.stringify({ runId, date: new Date().toISOString(),
    source: revision, image: SANDBOX_IMAGE, worker: names.worker, bucket: names.bucket, workerVersion: live?.workerVersion,
    scope, c3: observed.c3, large: observed.large, lifecycle: observed.lifecycle, cleanup, errors }, null, 2));

  const log = (message: string): void => { process.stderr.write(`[block-attach] ${message}\n`); };

  // Recover abandoned runs before this run creates anything: a driver killed mid-run leaves
  // a manifest naming a live Worker, container application and bucket only a later driver reads.
  for (const earlier of await recoverAbandonedRuns(REPO, runId, orphanTeardownExecutor(residue), log)) {
    if (earlier.failures.length > 0 || !earlier.replayed) errors.push(`earlier run ${earlier.runId} still holds resources`);
    else cleanup.push(`earlier run ${earlier.runId}: abandoned resources deleted or absent`);
  }

  const wrangle = (args: readonly string[], options: { allowFailure?: boolean } = {}): string => runWrangler(REPO, args, options);
  const deletion = (absent: boolean, name: string): DeleteOutcome => absent ? { ok: true } : { ok: false, error: `${name} is still present` };
  publishTeardown(async () => {
    if (live !== null) cleanup.push(...await teardownLiveArms(live.fixture, boxes));
    const probes = cleanupObservationProbes({ wrangler: wrangle, residue });

    const replay = await replayTeardown(REPO, resources.manifest, async (entry) => {
      if (entry.kind === 'worker') {
        if (live !== null) cleanup.push(...live.stop());
        else wrangle(['delete', '--name', names.worker, '--force'], { allowFailure: true });

        return deletion(await probes.workerAbsent(names.worker), names.worker);
      }

      if (entry.kind === 'container-app') {
        cleanup.push(...deleteContainerApps(REPO, [entry.name], log));

        return deletion(containerAppIds(REPO, [entry.name], log).length === 0, entry.name);
      }

      if (entry.kind === 'r2-bucket') {
        const drained = await drainBucketResidue(residue, entry.name);
        cleanup.push(`drained ${drained.objects} objects and ${drained.uploads} multipart uploads`);
        const remaining = await probes.bucketState(entry.name);
        resources.manifest.counters.finalResidueObjects = remaining.objects;
        resources.manifest.counters.finalResidueMultipartUploads = remaining.multipartResidue;

        if (remaining.objects !== 0 || remaining.multipartResidue !== 0) return { ok: false, error: 'bucket residue remained after draining' };
        wrangle(['r2', 'bucket', 'delete', entry.name]);

        return deletion(!(await residue.bucketExists(entry.name)), entry.name);
      }

      if (entry.kind === 'local-path') {
        resources.disposeConfig();

        return { ok: true };
      }

      return deletion(await probes.workerAbsent(names.worker), names.worker);
    });

    errors.push(...replay.failures);
    save();
  });
  save();

  try {
    wrangle(['r2', 'bucket', 'create', names.bucket]);
    live = await deployFixture(`block-${crypto.randomUUID()}`, names);
    const fixture: Fixture = { ...live.fixture, identity: { ...revision, workerVersion: live.workerVersion, image: SANDBOX_IMAGE } };

    const following = Bun.spawn(['bunx', 'wrangler', 'tail', names.worker, '--format', 'pretty'], {
      cwd: REPO, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: BENCH_ACCOUNT_ID }, stdout: 'pipe', stderr: 'ignore',
    });

    tail = following;
    const output = following.stdout;
    capture = (async () => {
      let pending = '';

      for await (const bytes of output) {
        pending += new TextDecoder().decode(bytes);
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';

        for (const line of lines) {
          // Every tailed line is kept, not only `devbox.` events: console lines explain a startup
          // that never settles.
          appendFileSync(join(artifacts, 'tail.log'), line + '\n');
          const begin = line.indexOf('{"event":"devbox.');

          if (begin >= 0) appendFileSync(join(artifacts, 'lifecycle.jsonl'), line.slice(begin) + '\n');
        }
      }
    })();
    await delay(2500);

    if (lifecycleOnly) await runLifecycle({ fixture, box, observed, save, errors });
    else await runCells({ fixture, box, largeBox, runId, selection: { c3Only, largeOnly }, observed, save, errors });
  } catch (cause) {
    errors.push(cause instanceof Error ? cause.message : String(cause));
  } finally {
    await delay(2000);
    tail?.kill();

    try {
      await capture;
    } finally {
      await runTeardownOnce();
      writeManifest(REPO, resources.manifest);
    }
  }

  save();
  process.stdout.write(JSON.stringify({ artifact: join(artifacts, 'observations.json'),
    c3AttachMs: storageAttachMilliseconds(observed.c3?.restoreProbe?.phases), largeAttachMs: storageAttachMilliseconds(observed.large?.restoreProbe?.phases), errors }) + '\n');

  return errors.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await run();
