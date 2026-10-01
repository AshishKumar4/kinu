// D54, 2026-10-01: an object evicted 1 s into a checkpoint leaves its `sync.js flush` running in the
// container, and the successor's re-driven checkpoint starts a second one in the same stage directory.
// Live (run sbs10010327nda, image c072f8f5) both published 216 ms apart; one delta did not read as a
// squashfs, the record named it, and the box refused every start after. Here the image's own sync
// runs twice at once against a box and store served inside the container (support/flush-box.ts).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeChainState } from '../src/snapshot-chain';
import { BOOT_ID_PATH, parseSyncOutcome, syncFlushCommand, type SyncConfig } from '../src/sync';
import { DEVBOX_RUNTIME_DIR, DEVBOX_WORKDIR, type CheckpointOutcome } from '../src/storage';
import { buildBlockImage, removeBlockImage } from './support/block-image';
import { inContainer } from './support/docker-container';
import { FLUSH_BOX_CORRUPT, FLUSH_BOX_GENERATION, FLUSH_BOX_PUBLISHED, FLUSH_BOX_STATE } from './support/flush-box';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';

const image = `devbox-flush-${process.pid}`;

const name = `devbox-flush-${process.pid}`;

const config: SyncConfig = { storeRoot: 'boxes/flush/backups', binding: 'BACKUP_BUCKET', excludes: [], periodMs: 60_000 };

let scratch: string;

function run(argv: readonly string[]): string {
  const ran = inContainer(name, argv);

  if (ran.status !== 0) throw new Error(`${argv.join(' ')} exited ${String(ran.status)}: ${ran.stderr}`);

  return ran.stdout;
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), DEVBOX_SCRATCH_PREFIX));
  buildBlockImage(image);
  const bundled = await Bun.build({ entrypoints: [join(import.meta.dir, 'support/flush-box.ts')], target: 'bun', outdir: scratch });

  if (!bundled.success) throw new AggregateError(bundled.logs, 'the flush box did not build');

  const started = spawnSync('docker', [
    'run', '--detach', '--name', name, '--network=none',
    '--add-host', 'devbox.internal:127.0.0.1', '--add-host', 's3-devbox-publish.sandbox.internal:127.0.0.1', image,
  ], { encoding: 'utf8' });

  if (started.status !== 0) throw new Error(started.stderr);
  const copied = spawnSync('docker', ['cp', join(scratch, 'flush-box.js'), `${name}:/var/tmp/flush-box.js`], { encoding: 'utf8' });

  if (copied.status !== 0) throw new Error(copied.stderr);
  spawnSync('docker', ['exec', '--detach', name, 'bun', '/var/tmp/flush-box.js', config.storeRoot]);
  run(['sh', '-c', `echo ${FLUSH_BOX_GENERATION} > ${BOOT_ID_PATH}; until curl -sf http://devbox.internal/ready >/dev/null; do sleep 0.1; done`]);
});

afterAll(() => {
  spawnSync('docker', ['rm', '-f', name]);
  removeBlockImage(image);
  rmSync(scratch, { recursive: true, force: true });
});

/** A fresh box: no record, an empty store, and a workspace large enough that one pack takes seconds. */
function freshBox(): void {
  run(['sh', '-c', `rm -rf ${FLUSH_BOX_STATE} ${FLUSH_BOX_PUBLISHED} ${FLUSH_BOX_CORRUPT} /backups ${DEVBOX_RUNTIME_DIR}/stage ${DEVBOX_WORKDIR}/*; `
    + `mkdir -p /backups; head -c 50331648 /dev/urandom > ${DEVBOX_WORKDIR}/large.bin; `
    + `for i in $(seq 1 40); do echo "small $i" > ${DEVBOX_WORKDIR}/small-$i.txt; done`]);
}

/** The flush as the box runs it, read by the box's own parser. */
async function flush(): Promise<CheckpointOutcome> {
  const child = Bun.spawn(['docker', 'exec', name, 'bash', '-c', syncFlushCommand(config, 'tick')], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

  return parseSyncOutcome(stdout, stderr, exitCode);
}

/** One line per object the store completed. */
function published(): readonly string[] {
  return run(['sh', '-c', `cat ${FLUSH_BOX_PUBLISHED} 2>/dev/null || true`]).trim().split('\n').filter((line) => line !== '');
}

/** What the record names, whether that object reads back as exactly the workspace, and whether a
 *  refusal was stamped on it. */
function recordedBase() {
  const read = inContainer(name, ['cat', FLUSH_BOX_STATE]);
  const state = read.status === 0 ? normalizeChainState(JSON.parse(read.stdout)) : null;

  if (state === null) return { named: false, reads: false };
  const { base, lastFailure } = state;
  const listed = inContainer(name, ['unsquashfs', '-l', `/backups/${base.id}/data.sqsh`]);
  const archived = listed.stdout.split('\n').filter((line) => line.startsWith('squashfs-root/')).map((line) => line.slice('squashfs-root/'.length)).sort();
  const workspace = run(['find', DEVBOX_WORKDIR, '-mindepth', '1', '-printf', '%P\\n']).trim().split('\n').sort();

  return { named: true, reads: listed.status === 0 && JSON.stringify(archived) === JSON.stringify(workspace), stamped: lastFailure !== undefined };
}

// The second flush runs after the first and reads the record the first wrote. That record names a
// base and this container has no overlay over it, so the second refuses and stamps the refusal on
// that record: the stamp is the proof it read it. Two flushes that overlap both read no record, and
// the loser fails on the other's stage (an `rm` or a `mksquashfs` that will not overwrite) with
// nothing to stamp.
test('a second flush waits for the first, then reads the record it wrote and publishes nothing again', async () => {
  freshBox();

  const outcomes = await Promise.all([flush(), flush()]);
  // One small file beside the stage: the last holder's token and outcome, overwritten by every flush (D57).
  const lock = run(['cat', `${DEVBOX_RUNTIME_DIR}/stage.lock`]);
  const last = parseSyncOutcome(lock.split('\n')[1] ?? '', '', 0);

  expect({
    committed: outcomes.filter((outcome) => outcome.kind === 'committed').length,
    published: published().length,
    record: recordedBase(),
    lock: { small: lock.length < 2048, holdsAnOutcome: outcomes.some((outcome) => outcome.kind === last.kind && outcome.reason === last.reason) },
  }).toEqual({ committed: 1, published: 1, record: { named: true, reads: true, stamped: true }, lock: { small: true, holdsAnOutcome: true } });
});

test('a layer that lands unreadable is never named by the record', async () => {
  freshBox();
  run(['touch', FLUSH_BOX_CORRUPT]);

  const outcome = await flush();

  expect({ kind: outcome.kind, published: published().length, record: recordedBase().named })
    .toEqual({ kind: 'failed', published: 1, record: false });
});
