// D37: an untimed command runs on `ctx.container.exec`, and ending it ends everything it started. Here the
// runtime's exec is a real local process, so the output, the exit code and the process tree are real.
import { TestDevbox } from './support/test-devbox';
import { afterAll, describe, expect, setSystemTime, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_DEVBOX_POLICY } from '../src/lifecycle';
import { devboxFailure } from '../src/errors';
import { collectExecRecords } from '../src/exec-stream';
import { CONTAINER_TRUST_ENV } from '../src/processes';
import { gate, harness } from './support/devbox-harness';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';
import { pipeExec as localExec } from './support/native-process';

const root = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}untimed-exec-`));

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

class TestBox extends TestDevbox<unknown> {

  protected override get ambientCheckpoints(): boolean {
    return false;
  }
}


/** Alive: present and not a zombie, as the kill reads it. */
function alive(pid: number): boolean {
  const status = join('/proc', String(pid), 'status');

  return existsSync(status) && !/^State:\s*Z/mu.test(readFileSync(status, 'utf8'));
}

async function readyBox(exec: Container['exec'] = localExec) {
  const { box } = harness(TestBox, undefined, exec);
  await box.devboxStartup();

  return box;
}

describe('an untimed command on the runtime\'s exec', () => {
  test('returns its own output and exit code', async () => {
    const box = await readyBox();
    const cwd = mkdtempSync(join(root, 'output-'));

    expect(await box.execUntimed('pwd; echo out; echo err >&2; exit 7', { cwd, execId: 'one' }))
      .toEqual({ stdout: `${cwd}\nout\n`, stderr: 'err\n', exitCode: 7 });
  });

  // 2026-10-03: an untimed exec forced the trust env over the caller's; a raw one did not.
  test('runs with the box\'s trust environment under the caller\'s own, as a raw exec does', async () => {
    const box = await readyBox();
    const cwd = mkdtempSync(join(root, 'env-'));
    const env = { REQUESTS_CA_BUNDLE: join(cwd, 'bundle.pem') };

    expect(await box.execUntimed('printf "%s %s" "$REQUESTS_CA_BUNDLE" "$NODE_EXTRA_CA_CERTS"', { cwd, execId: 'env', env }))
      .toEqual({ stdout: `${env.REQUESTS_CA_BUNDLE} ${CONTAINER_TRUST_ENV.NODE_EXTRA_CA_CERTS}`, stderr: '', exitCode: 0 });
  });

  test('ending it ends what it started, and a command already gone is not ended again', async () => {
    const box = await readyBox();
    const cwd = mkdtempSync(join(root, 'kill-'));
    // A FIFO: the read below returns once the command has started its child and written the child's pid.
    const started = join(cwd, 'started');
    Bun.spawnSync(['mkfifo', started]);
    const ran = box.execUntimed(`sleep 60 & echo $! > ${started}; wait`, { cwd, execId: 'held' });
    const child = Number((await Bun.file(started).text()).trim());

    expect(await box.killUntimed('held')).toBe(true);
    expect((await ran).exitCode).not.toBe(0);
    expect(alive(child)).toBe(false);
    expect(await box.killUntimed('held')).toBe(false);
  });

  test('a kill that arrives while the command is still starting ends it once it has started', async () => {
    // The runtime's exec holds its answer until released, so the kill lands before the process has a pid.
    const starting = gate();

    const box = await readyBox(async (argv, options) => {
      starting.enter();
      await starting.promise;

      return await localExec(argv, options);
    });

    const cwd = mkdtempSync(join(root, 'starting-'));
    // Left alone it answers exit 0 a minute later, past the test's own bound.
    const ran = box.execUntimed('exec sleep 60', { cwd, execId: 'starting' });
    await starting.reached;

    const killed = box.killUntimed('starting');
    starting.release();

    expect(await killed).toBe(true);
    expect((await ran).exitCode).not.toBe(0);
  });
  test('a cancellation during readiness prevents the command from ever starting', async () => {
    const { box, container } = harness(TestBox, undefined, localExec);
    const admission = gate();
    container.containerStartGate = admission;
    const cwd = mkdtempSync(join(root, 'pre-admission-'));
    const marker = join(cwd, 'must-not-exist');

    const ran = Promise.allSettled([box.execUntimed(`sleep 10; touch '${marker}'`, { cwd, execId: 'cancel-before-ready' })]);

    try {
      await admission.reached;
      const cancelled = await box.killUntimed('cancel-before-ready');
      admission.release();
      const [outcome] = await ran;
      const kind = outcome.status === 'rejected' ? devboxFailure({ cause: outcome.reason })?.code : 'completed';

      expect({ cancelled, outcome: kind, wrote: existsSync(marker) })
        .toEqual({ cancelled: true, outcome: 'cancelled', wrote: false });
      expect(await box.killUntimed('cancel-before-ready')).toBe(false);
    } finally {
      admission.release();
      await ran;
      await box.destroy();
    }
  });
});

const decoder = new TextDecoder();

/** The box's rest decision at `at`, as its heartbeat takes it. */
async function restDecision(box: Awaited<ReturnType<typeof readyBox>>, at: number): Promise<string | undefined> {
  setSystemTime(at);
  await box.devboxHeartbeat();

  return (await box.devboxState()).lastTick?.decision;
}

/** A FIFO the command reads before it goes on: it is still running until the test writes the FIFO. */
function releaseFifo(cwd: string): string {
  const release = join(cwd, 'release');
  Bun.spawnSync(['mkfifo', release]);

  return release;
}

// 2026-10-02: a sandbox job's output reached no one until its command ended.
describe('one launch per id', () => {
  test('a repeated id reads its launch\'s answer, an id with nothing kept is never launched again, and a released id is free', async () => {
    const box = await readyBox();
    const cwd = mkdtempSync(join(root, 'once-'));
    const command = 'echo ran >> effects; echo done';
    const effects = () => readFileSync(join(cwd, 'effects'), 'utf8');

    const first = await box.execUntimed(command, { cwd, execId: 'once' });

    expect(await box.execUntimed(command, { cwd, execId: 'once' })).toEqual(first);
    expect(effects()).toBe('ran\n');

    await collectExecRecords(await box.execUntimedStream(command, { cwd, execId: 'streamed' }), () => {});
    await expect(box.execUntimed(command, { cwd, execId: 'streamed' })).rejects.toMatchObject({ code: 'indeterminate' });
    expect(effects()).toBe('ran\nran\n');

    await box.releaseUntimed('once');
    await box.execUntimed(command, { cwd, execId: 'once' });
    expect(effects()).toBe('ran\nran\nran\n');
  });
});

describe('a streamed untimed command', () => {
  test('hands over what it printed while it still runs, and its exit code ends the stream', async () => {
    const box = await readyBox();
    const cwd = mkdtempSync(join(root, 'stream-'));
    const release = releaseFifo(cwd);
    const stream = await box.execUntimedStream(`echo compiled; read line < ${release}; echo "built $line" >&2; exit 3`, { cwd, execId: 'stream' });
    const heard: string[] = [];

    // The command waits on the FIFO until its first line is heard, so it ends only if that line came while it ran.
    const result = await collectExecRecords(stream, (name, data) => {
      heard.push(`${name}: ${decoder.decode(data)}`);

      if (heard.length === 1) writeFileSync(release, 'ok\n');
    });

    expect(heard).toEqual(['stdout: compiled\n', 'stderr: built ok\n']);
    expect(result).toEqual({ stdout: 'compiled\n', stderr: 'built ok\n', exitCode: 3 });
  });

  test('cancelling the stream ends the command and what it started', async () => {
    const box = await readyBox();
    const cwd = mkdtempSync(join(root, 'stream-cancel-'));
    const started = join(cwd, 'started');
    Bun.spawnSync(['mkfifo', started]);
    const stream = await box.execUntimedStream(`sleep 60 & echo $! > ${started}; wait`, { cwd, execId: 'stream-cancel' });
    const child = Number((await Bun.file(started).text()).trim());

    await stream.cancel('the reader is gone');

    expect(alive(child)).toBe(false);
  });

  // The box counts a shell command only as a caller; a streamed one is counted until it exits, then the box can rest.
  test('holds the box while it runs, and lets it rest once it has ended', async () => {
    const start = Date.now();
    const box = await readyBox();
    const cwd = mkdtempSync(join(root, 'stream-hold-'));
    const release = releaseFifo(cwd);
    const { idleMs, quietConfirmMs } = DEFAULT_DEVBOX_POLICY;

    try {
      const stream = await box.execUntimedStream(`read line < ${release}; echo done`, { cwd, execId: 'stream-hold' });
      // Past the idle window and then through the quiet one: an uncounted command would let the box rest here.
      const idle = start + idleMs + 1_000;
      await restDecision(box, idle);
      const running = await restDecision(box, idle + quietConfirmMs);

      writeFileSync(release, 'ok\n');
      expect(await collectExecRecords(stream, () => {})).toEqual({ stdout: 'done\n', stderr: '', exitCode: 0 });
      const ended = idle + quietConfirmMs;
      await restDecision(box, ended + idleMs + 1_000);
      const after = await restDecision(box, ended + idleMs + 1_000 + quietConfirmMs);

      expect({ running, after }).toEqual({ running: 'hold', after: 'quiesce' });
    } finally {
      setSystemTime();
    }
  });

  // No one reads the exit record here: the box stops counting the command because its process exited.
  test('a cancelled stream lets the box rest, its command gone', async () => {
    const start = Date.now();
    const box = await readyBox();
    const cwd = mkdtempSync(join(root, 'stream-cancel-rest-'));
    const release = releaseFifo(cwd);
    const { idleMs, quietConfirmMs } = DEFAULT_DEVBOX_POLICY;

    try {
      const stream = await box.execUntimedStream(`read line < ${release}`, { cwd, execId: 'stream-cancel-rest' });
      await stream.cancel('the reader is gone');
      const idle = start + idleMs + 1_000;
      await restDecision(box, idle);

      expect(await restDecision(box, idle + quietConfirmMs)).toBe('quiesce');
    } finally {
      setSystemTime();
    }
  });
});
