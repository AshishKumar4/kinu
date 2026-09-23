/**
 * DBX-5's deployed proof (D30): the loss window of the container's own sync, and the box's own wire
 * against the bytes that reached the store. One bench arm with the sync on at the shipped period
 * (`BENCH_PRODUCTION_SYNC=1`) on its own Worker, bucket and container application. The run first
 * sweeps what earlier runs left, and its own resources go through the strategies driver's manifest
 * and cleanup check, so an interrupted run is swept by the next.
 *
 *   loss window  a marker is written at a random point of the period; the sample runs until the
 *                box's record carries an upper fingerprint taken after the write, which a commit
 *                records only when its staging read the upper that holds the marker.
 *   wire         `devboxState().wire` (the box's container commands and sync requests) against the
 *                layer bytes the record gained, for a small write and a large one.
 *   raw disk     what a dd-style sync would need from the same container (`RAW_DISK_PROBE`).
 *
 * The supplied credentials are the operator's and outlive the run: nothing here writes, rotates
 * or deletes them, and the cleanup check that closes the run lists Workers with the API token and
 * reads every bucket with the R2 keys, so a run whose credentials were gone could not pass it.
 *
 *   set -a; . ./.dev.vars; set +a; bun scripts/bench-devbox-sync-window.ts [--samples 10] [--large-mb 64]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import type { StartupState } from '../packages/devbox/bench/observation-schema';
import {
  BENCH_ACCOUNT_ID, admittedAttachKinds, armLanes, boxState, createFixtureResources, deployFixture, execInBox,
  orphanTeardownExecutor, r2CleanupKeyRefusal, r2ResiduePlane, sourceRevision, startupOperation, teardownLanes,
  type Fixture, type LaneTeardown,
} from './bench-devbox-strategies';
import { delay, describeThrown, publishTeardown, runTeardownOnce, runWrangler } from './fixtures/r2-bench/deploy-substrate';
import { recoverAbandonedRuns } from './fixtures/storage-matrix/cleanup';

const REPO = new URL('..', import.meta.url).pathname;

const ARM = 'snapshot-chain' as const;

const POLL_MS = 250;

const log = (line: string): void => { process.stderr.write(`[sync-window] ${line}\n`); };

/** What the teardown observed, filled when it runs and read after. */
interface Closing {
  torn: LaneTeardown | null;
}

/** What a dd-style sync would need from the deployed container (DBX-8 asks for that arm or why
 *  not): its capabilities, loop and FUSE devices, the tools, and whether a loop mount of an ext4
 *  image is allowed. Everything it makes is outside the work directory and removed. */
const RAW_DISK_PROBE = [
  'grep -E "^Cap(Eff|Bnd)" /proc/self/status',
  'ls -l /dev/loop-control /dev/loop0 /dev/fuse 2>&1',
  'for tool in losetup mkfs.ext4 fuse2fs; do printf "%s: %s\\n" "$tool" "$(command -v "$tool" || echo absent)"; done',
  'grep -E "ext4|fuse|squashfs|overlay" /proc/filesystems',
  'printf "losetup -f: %s\\n" "$(losetup -f 2>&1)"',
  'image=/var/tmp/raw-disk-probe.img; mountpoint=/var/tmp/raw-disk-probe',
  'truncate -s 64M "$image" && mkfs.ext4 -q -F "$image" 2>&1 && mkdir -p "$mountpoint"',
  'printf "loop mount: %s\\n" "$(mount -o loop "$image" "$mountpoint" 2>&1 && echo mounted && umount "$mountpoint")"',
  'rm -rf "$image" "$mountpoint"; true',
].join('\n');

const MarkSchema = v.object({ ok: v.boolean(), mark: v.string(), error: v.string() });

/** The box's period and the waits that follow from it: a commit takes a period plus its own
 *  publish, so four periods without one is a stalled sync. */
interface Cadence {
  readonly periodMs: number;
  readonly commitWaitMs: number;
}

async function state(fixture: Fixture, box: string): Promise<StartupState> {
  return (await boxState(fixture, box)).state ?? {};
}

async function run(fixture: Fixture, box: string, command: string): Promise<string> {
  const reply = await execInBox(fixture, box, command);

  if (reply.exitCode !== 0) throw new Error(`${command.slice(0, 80)} exited ${String(reply.exitCode)}: ${reply.stderr ?? ''}`);

  return reply.stdout ?? '';
}

/** The fixture reads the upper's fingerprint with the gate's own command, so the mark compares
 *  with the `upperMark` a commit records. */
async function upperMark(fixture: Fixture, box: string): Promise<string> {
  const reply = await fetch(`${fixture.origin}/upper-mark?box=${box}&strategy=${ARM}`, {
    headers: { authorization: `Bearer ${fixture.token}` }, signal: AbortSignal.timeout(120_000),
  });

  const read = v.parse(MarkSchema, await reply.json());

  if (!read.ok || read.mark === '') throw new Error(`the upper's fingerprint could not be read: ${read.error}`);

  return read.mark;
}

/** Until the record carries `mark`; the time is the driver's, the one clock both ends share. */
async function awaitMark(fixture: Fixture, box: string, mark: string, cadence: Cadence): Promise<{ readonly at: number; readonly state: StartupState }> {
  const deadline = Date.now() + cadence.commitWaitMs;

  for (;;) {
    const observed = await state(fixture, box);

    if (observed.chain?.upperMark === mark) return { at: Date.now(), state: observed };

    if (Date.now() > deadline) throw new Error(`no commit carried ${mark} within ${String(cadence.commitWaitMs)} ms`);
    await delay(POLL_MS);
  }
}

/** Writes, then waits for the commit that holds the write. */
async function writeAndAwait(fixture: Fixture, box: string, write: string, cadence: Cadence) {
  const before = await state(fixture, box);
  const written = Date.now();
  await run(fixture, box, write);
  const committed = await awaitMark(fixture, box, await upperMark(fixture, box), cadence);

  return { windowMs: committed.at - written, before, after: committed.state };
}

const layerBytes = (observed: StartupState): number => (observed.chain?.base?.bytes ?? 0) + (observed.chain?.delta?.bytes ?? 0);

const wireBytes = (observed: StartupState): number => (observed.wire?.sent ?? 0) + (observed.wire?.received ?? 0);

function option(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);

  return index === -1 ? fallback : Number(process.argv[index + 1]);
}

async function measure(fixture: Fixture, box: string, samples: number, largeMb: number) {
  await startupOperation({ fixture, box, path: '/create', operation: 'cold attach', allowedKinds: admittedAttachKinds('cold attach') });
  const periodMs = (await boxState(fixture, box)).checkpointIntervalMs;

  if (periodMs === undefined) throw new Error('the fixture did not report its checkpoint period');
  const cadence: Cadence = { periodMs, commitWaitMs: 4 * periodMs + 60_000 };
  await run(fixture, box, 'mkdir -p /workspace/.sync-window');
  // The first commit publishes the base; the window is a steady-state property, so it is excluded.
  await writeAndAwait(fixture, box, 'printf seed > /workspace/.sync-window/seed', cadence);
  const windows: number[] = [];

  for (let sample = 0; sample < samples; sample += 1) {
    await delay(Math.floor(Math.random() * periodMs));
    const { windowMs } = await writeAndAwait(fixture, box, `printf %s ${String(sample)} > /workspace/.sync-window/m${String(sample)}`, cadence);
    windows.push(windowMs);
    log(`sample ${String(sample)}: ${String(windowMs)} ms`);
  }

  const wire = [];

  for (const [label, write] of [
    ['small', 'printf small > /workspace/.sync-window/small'],
    ['large', `head -c ${String(largeMb)}M /dev/urandom > /workspace/.sync-window/large`],
  ] as const) {
    const { before, after } = await writeAndAwait(fixture, box, write, cadence);
    // The meter is the object's memory; an object that restarted between the reads counted from zero.
    const restarted = wireBytes(after) < wireBytes(before);
    wire.push({
      label,
      layerBytesGained: layerBytes(after) - layerBytes(before),
      boxWireBytes: restarted ? null : wireBytes(after) - wireBytes(before),
    });
  }

  const sorted = [...windows].sort((a, b) => a - b);

  return {
    periodMs,
    windows,
    p50Ms: sorted[Math.floor(sorted.length / 2)] ?? null,
    maxMs: sorted.at(-1) ?? null,
    wire,
    rawDisk: await run(fixture, box, RAW_DISK_PROBE),
  };
}

async function main(): Promise<number> {
  const accessKeyId = process.env['R2_ACCESS_KEY_ID'] ?? '';
  const secretAccessKey = process.env['R2_SECRET_ACCESS_KEY'] ?? '';

  const keyRefusal = r2CleanupKeyRefusal({
    verifiesCleanup: true,
    accessKeyIdPresent: accessKeyId !== '',
    secretAccessKeyPresent: secretAccessKey !== '',
  });

  if (keyRefusal !== null) {
    log(keyRefusal);

    return 1;
  }

  process.env.CLOUDFLARE_ACCOUNT_ID = BENCH_ACCOUNT_ID;
  // Its own id space, so a strategies bench started in the same second never shares its names; the
  // two-digit year keeps every derived name as long as the strategies bench's, which deploy.
  const runId = `w${new Date().toISOString().replace(/[^0-9]/g, '').slice(2, 14)}`;
  const residue = r2ResiduePlane({ accountId: BENCH_ACCOUNT_ID, accessKeyId, secretAccessKey });
  await recoverAbandonedRuns(REPO, runId, orphanTeardownExecutor(residue), log);
  const fixtures = createFixtureResources(runId, [ARM]);
  const lanes = armLanes(runId, fixtures);
  const [lane] = lanes;

  if (lane === undefined) throw new Error('the fixture planned no arm');
  // A holder, not a `let`: the teardown assigns it from a callback, which narrowing cannot see.
  const closing: Closing = { torn: null };
  publishTeardown(async () => { closing.torn = await teardownLanes(fixtures, lanes, residue); });
  let result: Awaited<ReturnType<typeof measure>> | null = null;
  let failure: string | null = null;

  try {
    runWrangler(REPO, ['r2', 'bucket', 'create', lane.fixture.bucket]);
    const deployed = await deployFixture(`devbox-${crypto.randomUUID()}`, lane.fixture, { productionSync: true });
    lane.stop = deployed.stop;
    lane.live = deployed.fixture;
    lane.workerVersion = deployed.workerVersion;
    lane.rollouts = deployed.rollouts;
    result = await measure(deployed.fixture, lane.box, option('samples', 10), option('large-mb', 64));
  } catch (cause) {
    failure = describeThrown({ cause });
    log(`run failed: ${failure}`);
  } finally {
    await runTeardownOnce();
  }

  const { torn } = closing;
  failure ??= torn?.failure ?? null;
  const artifacts = join(REPO, 'bench-artifacts', 'sync-window', runId);
  mkdirSync(artifacts, { recursive: true });

  const observed = {
    runId,
    date: new Date().toISOString(),
    revision: sourceRevision(),
    workerVersion: lane.workerVersion,
    result,
    failure,
    cleanup: { passed: torn?.report?.passed ?? false, errors: torn?.errors ?? ['the teardown never ran'] },
  };

  writeFileSync(join(artifacts, 'observations.json'), `${JSON.stringify(observed, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ artifact: join(artifacts, 'observations.json'), ...observed })}\n`);

  return failure === null ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
