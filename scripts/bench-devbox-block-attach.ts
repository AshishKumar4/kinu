/** Two bounded storage cells using the decisive bench's deployed Worker,
 * lifecycle, C3 writer and publication meter. This is not a strategy ranking
 * or a substitute for the full G1–G10 admission matrix. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BENCH_ACCOUNT_ID, SANDBOX_IMAGE, boxName, boxState, checkpointOperation,
  cleanupObservationProbes, createFixtureResources, deployFixture, destroyBox,
  drainBucketResidue, execInBox, measureLiveC3, r2ResiduePlane, readBlockAttachMetrics,
  readRestoreProbe, sourceRevision, startupOperation, teardownLiveArms, writeFileInBox,
  type Fixture, type StartupCompletion,
} from './bench-devbox-strategies';
import { evaluateLiveC3, type BlockAttachMetrics, type LiveC3Observation } from '../packages/devbox/bench/c3-result';
import type { RestorePhaseStamps } from '../packages/devbox/src/durability/contracts';
import { containerAppIds, deleteContainerApps, publishTeardown, runTeardownOnce, runWrangler } from './fixtures/r2-bench/deploy-substrate';
import { replayTeardown, writeManifest, type DeleteOutcome } from './fixtures/storage-matrix/cleanup';

const REPO = new URL('..', import.meta.url).pathname;

const SPARSE_BYTES = 2 * 1024 * 1024 * 1024;

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

interface SparseObservation {
  bytes: number;
  representation: string;
  initial: StartupCompletion | null;
  restoration: StartupCompletion | null;
  restoreProbe: Awaited<ReturnType<typeof readRestoreProbe>> | null;
  blockReads: BlockAttachMetrics | null;
  baseline: Awaited<ReturnType<typeof checkpointOperation>> | null;
  checkpoint: Awaited<ReturnType<typeof checkpointOperation>> | null;
  fileProbe: Awaited<ReturnType<typeof execInBox>> | null;
  errors: string[];
}

async function measureSparse(fixture: Fixture, box: string, observe: (row: SparseObservation) => void): Promise<SparseObservation> {
  const row: SparseObservation = { bytes: SPARSE_BYTES, representation: 'whole sparse record (>50% zero blocks), served by delta/tree',
    initial: null, restoration: null, restoreProbe: null, blockReads: null, baseline: null, checkpoint: null, fileProbe: null, errors: [] };

  observe(row);

  const command = async (text: string): Promise<void> => {
    const reply = await execInBox(fixture, box, text);

    if (reply.ok !== true || reply.exitCode !== 0) throw new Error(`sparse writer failed: ${reply.error ?? reply.stderr}`);
  };

  try {
    row.initial = await startupOperation(fixture, box, '/create', '2GiB sparse baseline', ['empty']);
    await command(`mkdir -p /workspace/vol && truncate -s ${SPARSE_BYTES} /workspace/vol/sparse.bin`);
    row.baseline = await checkpointOperation(fixture, box, 'quiesce', '2GiB sparse base');

    if (row.baseline.ok !== true || row.baseline.outcome?.kind !== 'committed') throw new Error('sparse baseline was not committed');
    await command("head -c 65536 /dev/zero | tr '\\000' B | dd of=/workspace/vol/sparse.bin bs=16384 seek=512 conv=notrunc status=none");
    row.checkpoint = await checkpointOperation(fixture, box, 'quiesce', '2GiB sparse edit');

    if (row.checkpoint.ok !== true || row.checkpoint.outcome?.kind !== 'committed') throw new Error(`sparse edit was not committed: ${row.checkpoint.error ?? row.checkpoint.outcome?.reason}`);
    const before = await boxState(fixture, box);
    const destroyed = await destroyBox(fixture, box);

    if (destroyed.ok !== true || destroyed.destroyed !== true) throw new Error('sparse container destruction was not proved');
    row.restoration = await startupOperation(fixture, box, '/wake', '2GiB sparse cold restore', ['attached']);
    const boot = row.restoration.state.state?.bootId;

    if (boot === undefined || boot === before.state?.bootId) throw new Error('sparse restore was not genuinely cold');
    row.restoreProbe = await readRestoreProbe(fixture, box, 'destroy-cold-restore', SPARSE_BYTES, row.errors, row.restoration.startedAt);
    row.blockReads = await readBlockAttachMetrics(fixture, box);
    observe(row);
    await writeFileInBox(fixture, box, '/tmp/block-sparse-probe.cjs', `
const fs = require('fs');
const fd = fs.openSync('/workspace/vol/sparse.bin', 'r');
try {
  if (fs.fstatSync(fd).size !== ${SPARSE_BYTES}) throw Error('wrong sparse size');
  for (const [position, value] of [[0, 0], [8388608, 66], [${SPARSE_BYTES - 65536}, 0]]) {
    const bytes = Buffer.alloc(65536);
    if (fs.readSync(fd, bytes, 0, bytes.length, position) !== bytes.length || !bytes.every(byte => byte === value)) throw Error('wrong sparse range at ' + position);
  }
  console.log(JSON.stringify({ size: ${SPARSE_BYTES}, ranges: 'zero, edited, zero' }));
} finally { fs.closeSync(fd); }
`);
    row.fileProbe = await execInBox(fixture, box, 'node /tmp/block-sparse-probe.cjs');

    if (row.fileProbe.ok !== true || row.fileProbe.exitCode !== 0) throw new Error(`sparse verification failed: ${row.fileProbe.error ?? row.fileProbe.stderr}`);
    row.errors.push(...boundedAttachErrors({ phases: row.restoreProbe.phases, blockReads: row.blockReads }));
  } catch (cause) {
    row.errors.push(cause instanceof Error ? cause.message : String(cause));
  }

  observe(row);

  return row;
}

async function run(): Promise<number> {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (accessKeyId === undefined || secretAccessKey === undefined) throw new Error('provisioned R2 cleanup credentials are required before deploying');
  const revision = sourceRevision();

  if (revision.dirtyDigest !== 'clean') throw new Error('commit the measured source before running the two cells');
  const runId = `b${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
  const artifacts = join(REPO, 'bench-artifacts', 'block-attach', runId);
  mkdirSync(artifacts, { recursive: true });
  const resources = createFixtureResources(runId, ['snapshot-chain']);
  const names = resources.arms[0];

  if (names === undefined) throw new Error('no snapshot-chain fixture');
  const box = boxName(runId, 'snapshot-chain');
  const residue = r2ResiduePlane({ accountId: BENCH_ACCOUNT_ID, accessKeyId, secretAccessKey });
  const errors: string[] = [];
  const cleanup: string[] = [];
  let live: Awaited<ReturnType<typeof deployFixture>> | null = null;
  let c3: LiveC3Observation | null = null;
  let sparse: SparseObservation | null = null;

  const save = (): void => writeFileSync(join(artifacts, 'observations.json'), JSON.stringify({ runId, date: new Date().toISOString(),
    source: revision, image: SANDBOX_IMAGE, worker: names.worker, bucket: names.bucket, workerVersion: live?.workerVersion,
    scope: 'two storage cells; not full strategy admission', c3, sparse, cleanup, errors }, null, 2));

  const log = (message: string): void => { process.stderr.write(`[block-attach] ${message}\n`); };

  const wrangle = (args: readonly string[], options: { allowFailure?: boolean } = {}): string => runWrangler(REPO, args, options);
  const deletion = (absent: boolean, name: string): DeleteOutcome => absent ? { ok: true } : { ok: false, error: `${name} is still present` };
  publishTeardown(async () => {
    if (live !== null) cleanup.push(...await teardownLiveArms(live.fixture, [box]));
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
    c3 = await measureLiveC3(fixture, box, runId, null, row => { c3 = row; save(); });
    errors.push(...evaluateLiveC3(c3).errors, ...boundedAttachErrors({ phases: c3.restoreProbe?.phases, blockReads: c3.blockReads }));
    const firstCleanup = await teardownLiveArms(fixture, [box]);

    if (firstCleanup.length > 0) throw new Error(firstCleanup.join('; '));
    sparse = await measureSparse(fixture, box, row => { sparse = row; save(); });
    errors.push(...sparse.errors);
  } catch (cause) {
    errors.push(cause instanceof Error ? cause.message : String(cause));
  } finally {
    await runTeardownOnce();
    writeManifest(REPO, resources.manifest);
  }

  save();
  process.stdout.write(JSON.stringify({ artifact: join(artifacts, 'observations.json'),
    c3AttachMs: storageAttachMilliseconds(c3?.restoreProbe?.phases), sparseAttachMs: storageAttachMilliseconds(sparse?.restoreProbe?.phases), errors }) + '\n');

  return errors.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await run();
