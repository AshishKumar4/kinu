// Supervised process lifecycle through the real Devbox: start records the row before the
// process; stop keeps the row unless the kill is confirmed, so the row names a live process.
import { beforeEach, describe, expect, test } from 'bun:test';

import { Devbox, gate, harness, SandboxFailure, type FakeSandbox } from './support/devbox-harness';
import { handClock } from '../../test-utils/src/hand-clock';
import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy, type StartClock } from '../src/lifecycle';
import { Processes } from '../src/processes';
import { chainBox } from './support/chain-box';

const COMMAND = 'bun run server.ts';

/** The transient the caller retries on, and the one that can strike between
 *  the reservation and the process. */
const LOST = 'network connection lost';

const REPAIR_ID = 'owed-server';

class InterleavingBox extends Devbox {
  readonly clock = handClock(1_000_000);

  protected override get policy(): DevboxPolicy {
    return { ...DEFAULT_DEVBOX_POLICY, attachBudgetMs: 1_000 };
  }

  protected override get startClock(): StartClock {
    return this.clock;
  }
}

/** The real startup records a refused native start; the still-running work directory stays operable for repair. */
async function missingService() {
  const made = harness(InterleavingBox);

  made.rows.set(`devbox:proc:${REPAIR_ID}`, { processId: REPAIR_ID, command: COMMAND, cwd: '/workspace', createdAt: 1 });
  made.container.startFaults.push({ error: new Error('native server start refused'), created: false });
  await made.box.devboxStartup();
  expect((await made.box.devboxState()).restoration).toBe('repair');

  return made;
}

/** The specs the box would restore after a recycle: its own public answer, so
 *  no test needs to know a storage key. */
async function reservations(box: InstanceType<typeof Devbox>): Promise<readonly string[]> {
  return (await box.devboxState()).supervised.map(spec => spec.processId);
}

describe('starting a supervised process reserves its id before the process exists', () => {
  test('concurrent starts reserve one process identity for the same command and cwd', async () => {
    const { box, container } = harness(Devbox);

    const [first, second] = await Promise.all([
      box.startSupervised(COMMAND, '/workspace'),
      box.startSupervised(COMMAND, '/workspace'),
    ]);

    expect(second.processId).toBe(first.processId);
    expect(container.starts.map(({ processId }) => processId)).toEqual([first.processId]);
    expect(await reservations(box)).toEqual([first.processId]);
  });

  for (const entry of ['public start', 'same-container repair', 'late startup'] as const) {
    test(`${entry} / stop / successor keeps one supervised generation and fences abandoned work`, async () => {
      const { box, container, rows } = entry === 'same-container repair' ? await missingService() : harness(InterleavingBox);
      let processId = REPAIR_ID;

      if (entry === 'public start') {
        processId = (await box.startSupervised(COMMAND)).processId;
        container.processes.clear();
      } else if (entry === 'late startup') {
        rows.set(`devbox:proc:${processId}`, { processId, command: COMMAND, cwd: '/workspace', createdAt: 1 });
      }

      const nativeGet = container.getProcess.bind(container);
      const paused = gate();
      let held = true;

      container.getProcess = async (id) => {
        if (id === processId && held) {
          held = false;
          paused.enter();
          await paused.promise;
        }

        return nativeGet(id);
      };

      let launching: Promise<unknown>;

      if (entry === 'public start') launching = box.startSupervised(COMMAND);
      else if (entry === 'same-container repair') launching = box.attachNow();
      else launching = box.devboxStartup();

      await paused.reached;

      if (entry === 'late startup') {
        expect(box.clock.armed()).toBeGreaterThan(0);
        box.clock.tick();
        await launching;
        expect((await box.devboxState()).restoration).toBe('repair');
      }

      const stopping = box.stopSupervised(processId);

      await new Promise<void>((resolve) => setImmediate(resolve));
      const next = box.startSupervised(COMMAND);
      let whileHeld: readonly string[] = [];

      try {
        whileHeld = await reservations(box);
      } finally {
        paused.release();
        await Promise.all([launching, stopping, next]);
      }

      const last = await next;

      expect(last.processId).not.toBe(processId);
      expect({ whileHeld, stopped: (await stopping).stopped, supervised: await reservations(box), live: [...container.processes.keys()] })
        .toEqual({ whileHeld: [processId], stopped: true, supervised: [last.processId], live: [last.processId] });

      if (entry === 'late startup') expect(container.starts.every((started) => started.processId !== processId)).toBe(true);
    });
  }

  test('repair rechecks a reservation withdrawn after its plan snapshot before native launch', async () => {
    const { box, container, storage } = await missingService();
    const deleting = gate();

    storage.gateDeleteOn(`devbox:proc:${REPAIR_ID}`, deleting);
    const stopping = box.stopSupervised(REPAIR_ID);

    await deleting.reached;
    const repairing = box.attachNow();

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      deleting.release();
      await Promise.all([stopping, repairing]);
    }

    expect(await stopping).toEqual({ stopped: true });
    expect({ supervised: await reservations(box), live: [...container.processes.keys()] }).toEqual({ supervised: [], live: [] });
    expect((await box.devboxState()).ready).toBe(true);

    const last = await box.startSupervised(COMMAND);

    expect(last.processId).not.toBe(REPAIR_ID);
    expect({ supervised: await reservations(box), live: [...container.processes.keys()] })
      .toEqual({ supervised: [last.processId], live: [last.processId] });
  });

  test('cwd is part of the supervised command identity', async () => {
    const { box, container } = harness(Devbox);

    await box.mkdir('/workspace/other', { recursive: true });

    const [first, second] = await Promise.all([
      box.startSupervised(COMMAND, '/workspace'),
      box.startSupervised(COMMAND, '/workspace/other'),
    ]);

    expect(second.processId).not.toBe(first.processId);
    expect(new Set(container.starts.map(({ cwd }) => cwd))).toEqual(new Set(['/workspace', '/workspace/other']));
    expect(new Set(await reservations(box))).toEqual(new Set([first.processId, second.processId]));
  });

  test('the durable spec names the process the container was asked to create', async () => {
    const { box, container } = harness(Devbox);

    const { processId } = await box.startSupervised(COMMAND);

    expect(container.starts).toEqual([
      { command: COMMAND, cwd: '/workspace', processId },
    ]);
    expect(await reservations(box)).toEqual([processId]);
  });

  test('a reset between the reservation and the start never creates a second process',
    async () => {
      // The caller retries on errors that strike between the row write and the process start;
      // the row must come first so the retry reuses its id instead of starting a second copy.
      const first = harness(Devbox);
      first.container.startFaults.push({ error: new Error(LOST), created: false });
      await expect(first.box.startSupervised(COMMAND)).rejects.toThrow(LOST);
      const [reserved] = await reservations(first.box);
      expect(reserved).toBeString();

      // A NEW isolate on the same durable rows and a replaced container: the
      // reset the caller is retrying through.
      const second = harness(Devbox);

      for (const [key, value] of first.rows) second.rows.set(key, value);

      const retried = await second.box.startSupervised(COMMAND);

      expect(retried.processId).toBe(reserved);
      expect(await reservations(second.box)).toEqual([retried.processId]);
      expect([...second.container.processes.keys()]).toEqual([retried.processId]);
    });

  test('a start whose answer was lost is adopted, not repeated', async () => {
    const { box, container } = harness(Devbox);
    container.startFaults.push({ error: new Error(LOST), created: true });
    await expect(box.startSupervised(COMMAND)).rejects.toThrow(LOST);

    const retried = await box.startSupervised(COMMAND);

    expect(container.starts.map(start => start.processId)).toEqual([retried.processId]);
    expect(container.processes.size).toBe(1);
    expect(await reservations(box)).toEqual([retried.processId]);
  });

  test('a container that cannot answer refuses rather than starting a second copy', async () => {
    // Absence must be positive: a failed query says nothing about whether the process exists,
    // so starting on it would duplicate; the call refuses and the reservation stands.
    const { box, container } = harness(Devbox);
    await box.startSupervised(COMMAND);
    const reserved = await reservations(box);
    container.getFaults.push(new Error('container transport reset'));

    await expect(box.startSupervised(COMMAND)).rejects.toThrow('container transport reset');

    expect(container.starts).toHaveLength(1);
    expect(container.processes.size).toBe(1);
    expect(await reservations(box)).toEqual([...reserved]);
  });

  test('a reserved id whose process is gone is started again under that same id', async () => {
    const { box, container } = harness(Devbox);
    const { processId } = await box.startSupervised(COMMAND);
    container.processes.clear();

    const restarted = await box.startSupervised(COMMAND);

    expect(restarted.processId).toBe(processId);
    expect(container.starts.map(start => start.processId)).toEqual([processId, processId]);
    expect(await reservations(box)).toEqual([processId]);
  });
});

describe('stopping a supervised process drops its spec only on evidence', () => {
  test('a confirmed kill takes the spec with it', async () => {
    const { box, container } = harness(Devbox);
    const { processId } = await box.startSupervised(COMMAND);

    expect(await box.stopSupervised(processId)).toEqual({ stopped: true });

    expect(container.kills).toEqual([processId]);
    expect(await reservations(box)).toEqual([]);
  });

  test('a kill that failed keeps the SAME spec, so a later stop can retry it', async () => {
    // The spec alone names the process and restoration walks specs: dropping it on a failed kill
    // leaves a live server the box cannot list, stop or bring back.
    const { box, container } = harness(Devbox);
    const { processId } = await box.startSupervised(COMMAND);
    container.killFaults.push(new Error('container transport reset'));

    expect(await box.stopSupervised(processId)).toEqual({ stopped: false });

    const state = await box.devboxState();
    expect(state.supervised.map(spec => spec.processId)).toEqual([processId]);
    // The reason is durable too, so a box that keeps failing to stop stays
    // visible after the object is evicted.
    expect(state.incidents.total).toBe(1);
    expect(container.processes.has(processId)).toBe(true);

    expect(await box.stopSupervised(processId)).toEqual({ stopped: true });
    expect(container.kills).toEqual([processId, processId]);
    expect(await reservations(box)).toEqual([]);
  });

  test('a native process already gone leaves no launch record or failure incident', async () => {
    const { box, container } = harness(Devbox);
    const { processId } = await box.startSupervised(COMMAND);
    container.processes.delete(processId);
    container.files.delete(`/var/tmp/devbox/processes/${processId}/process.json`);
    await box.stopSupervised(processId);

    const state = await box.devboxState();
    expect(state.supervised).toEqual([]);
    expect(state.incidents.total).toBe(0);
  });

  test('KINU-N011: prose saying "unknown" and "not found" is NOT absence', async () => {
    // Neither fault means the process is gone: `UNKNOWN_ERROR` is unclassified by the container,
    // the bare Error is an unclassified platform/transport failure; a prose match would drop it.
    const { box, container } = harness(Devbox);
    const { processId } = await box.startSupervised(COMMAND);
    container.killFaults.push(
      new SandboxFailure({ code: 'UNKNOWN_ERROR', message: 'Unknown error' }),
      new Error('container not found for this sandbox'),
    );

    for (const attempt of [1, 2]) {
      expect(await box.stopSupervised(processId)).toEqual({ stopped: false });
      const state = await box.devboxState();
      expect(state.supervised.map(spec => spec.processId)).toEqual([processId]);
      expect(state.incidents.total).toBe(attempt);
    }

    expect(container.processes.has(processId)).toBe(true);
  });
});

// Staging rc27, 2026-10-20: a three-hour job the computer ran to its end rested with it, and the next wake ran it again
// from its first line. A finished job kept its spec, and a start restores every spec.
describe('a supervised command that finished is done; one that failed restarts cold', () => {
  /** What the next start does with a command that ended `status` before the box rested. */
  async function restartedAfter(status: 'completed' | 'failed') {
    const { box, container } = chainBox();

    try {
      await box.start();
      const { processId } = await box.startSupervised(COMMAND);
      const row = container.processes.get(processId);

      container.processes.set(processId, { id: processId, pid: row?.pid ?? 1, command: COMMAND, status });
      expect((await box.quiesce()).kind).toBe('committed');
      const before = container.starts.length;

      await box.start();

      return { specs: await reservations(box), started: container.starts.length - before };
    } finally {
      await box.destroy();
    }
  }

  test('a job seen completed is not started again by the next start', async () => {
    expect(await restartedAfter('completed')).toEqual({ specs: [], started: 0 });
  });

  test('a server that failed comes back with the next start, as D35 restores it', async () => {
    expect(await restartedAfter('failed')).toEqual({ specs: [expect.any(String)], started: 1 });
  });
});

describe('the fakes can fail, so the assertions above are not vacuous', () => {
  let container: FakeSandbox;
  beforeEach(() => {
    container = harness(Devbox).container;
  });

  test('a queued start fault applies once and the container keeps the process', async () => {
    container.startFaults.push({ error: new Error(LOST), created: true });
    await expect(container.startProcess('x', { processId: 'p1' })).rejects.toThrow('lost');
    expect(container.processes.has('p1')).toBe(true);
    await expect(container.startProcess('x', { processId: 'p2' })).resolves.toMatchObject({
      id: 'p2',
    });
  });

  test('a queued start fault that created nothing leaves the container empty', async () => {
    container.startFaults.push({ error: new Error(LOST), created: false });
    await expect(container.startProcess('x', { processId: 'p1' })).rejects.toThrow('lost');
    expect(container.processes.size).toBe(0);
  });
});

describe('queued native mutations belong to the kernel they observed', () => {
  for (const operation of ['kill', 'write-record'] as const) {
    test(`${operation} delivered after confirmed replacement leaves the successor untouched`, async () => {
      const { box, container } = harness(Devbox);

      await box.devboxStartup();
      const native = container.handle();
      const processId = 'kernel-successor';
      const record = `/var/tmp/devbox/processes/${processId}/process.json`;
      const paused = gate();
      let queued = true;
      let current = true;

      if (operation === 'kill') await new Processes(native).start('exec sleep 7121', { processId });

      const delayed = new Processes({
        get running() { return native.running; },
        exec: async (argv, options) => {
          const inner = argv[3] === 'devbox-incarnation' ? argv.slice(5) : argv;

          const selected = operation === 'kill' ? inner[3] === 'devbox-kill'
            : inner[0] === '/usr/local/bin/sandbox-shim' && inner.includes(record);

          if (queued && selected) {
            queued = false;
            paused.enter();
            await paused.promise;
          }

          return native.exec(argv, options);
        },
      });

      const obsolete = operation === 'kill' ? delayed.kill(processId, { current: () => current })
        : delayed.start('exec sleep 7121', { processId, current: () => current });

      const outcome = Promise.allSettled([obsolete]);

      await paused.reached;

      try {
        current = false;
        await container.destroy();
        await box.devboxStartup();
        await new Processes(native).start('exec sleep 7122', { processId });
      } finally {
        paused.release();
        await outcome;
      }

      expect(container.processes.get(processId)?.command).toBe('exec sleep 7122');
      expect(JSON.parse(container.files.get(record) ?? '{}').command).toBe('exec sleep 7122');
      expect(container.kills).toEqual([]);
    });
  }
});

describe("a job its owner started reads the values its agents may read at each launch, and keeps none", () => {
  /** Assembled, so no scanner reads a hardcoded password here. */
  const VALUE = ['hunter2', 'job', 'db'].join('-');

  const PLACEHOLDER = `pxs1_${'a'.repeat(43)}`;

  class RevealingBox extends Devbox {
    asked = 0;

    protected override async revealedEnv(): Promise<Readonly<Record<string, string>>> {
      this.asked += 1;

      return { DATABASE_PASSWORD: VALUE };
    }
  }

  /** Everything the box keeps: its rows and every file it wrote. */
  function kept(made: ReturnType<typeof harness<RevealingBox>>): string {
    return JSON.stringify([...made.rows.values()]) + JSON.stringify([...made.container.files.values()]);
  }

  test('the launch is handed the value in memory; the spec and the job directory hold the placeholder alone', async () => {
    const made = harness(RevealingBox);

    await made.box.startSupervised(COMMAND, '/workspace', { CLOUDFLARE_API_TOKEN: PLACEHOLDER }, { reveal: true });

    expect(made.box.asked).toBe(1);
    expect(made.container.launchEnvs.at(-1)).toMatchObject({ DATABASE_PASSWORD: VALUE, DEVBOX_REVEALED: 'DATABASE_PASSWORD' });
    expect(kept(made)).toContain(PLACEHOLDER);
    expect(kept(made)).not.toContain(VALUE);
  });

  test("the job's own variables file leaves out what it reads the value of, so the pane cannot set the placeholder back", async () => {
    const made = harness(RevealingBox);

    await made.box.startSupervised(COMMAND, '/workspace', { CLOUDFLARE_API_TOKEN: PLACEHOLDER, DATABASE_PASSWORD: `pxs1_${'d'.repeat(43)}` }, { reveal: true });
    const files = [...made.container.files].filter(([path]) => path.endsWith('/env')).map(([, content]) => content);

    expect(files).toHaveLength(1);
    expect(files[0]).toContain('CLOUDFLARE_API_TOKEN');
    expect(files[0]).not.toContain('DATABASE_PASSWORD');
  });

  test('a restore after a recycle asks again, so the job holds the value as the owner left it', async () => {
    const made = harness(RevealingBox);

    made.rows.set(`devbox:proc:${REPAIR_ID}`, { processId: REPAIR_ID, command: COMMAND, cwd: '/workspace', createdAt: 1, env: { CLOUDFLARE_API_TOKEN: PLACEHOLDER }, reveal: true });
    await made.box.devboxStartup();

    expect(made.box.asked).toBe(1);
    expect(made.container.launchEnvs.at(-1)).toMatchObject({ DATABASE_PASSWORD: VALUE });
    expect(kept(made)).not.toContain(VALUE);
  });

  class UnansweredBox extends Devbox {
    protected override async revealedEnv(): Promise<Readonly<Record<string, string>>> {
      throw new Error('account object unreachable');
    }
  }

  test('an account that does not answer fails the start with that reason, and nothing is launched short of its value', async () => {
    const made = harness(UnansweredBox);

    await expect(made.box.startSupervised(COMMAND, '/workspace', { CLOUDFLARE_API_TOKEN: PLACEHOLDER }, { reveal: true })).rejects.toThrow('the account did not answer');
    expect(made.container.launchEnvs).toEqual([]);
  });

  test('a restore whose account does not answer launches nothing, and leaves the job to be asked for again', async () => {
    const made = harness(UnansweredBox);

    made.rows.set(`devbox:proc:${REPAIR_ID}`, { processId: REPAIR_ID, command: COMMAND, cwd: '/workspace', createdAt: 1, env: { CLOUDFLARE_API_TOKEN: PLACEHOLDER }, reveal: true });
    await made.box.devboxStartup();

    expect(made.container.launchEnvs).toEqual([]);
    expect((await made.box.devboxState()).supervised.map((spec) => spec.processId)).toEqual([REPAIR_ID]);
  });

  test("a job no owner started never asks, and its launch holds no value", async () => {
    const made = harness(RevealingBox);

    await made.box.startSupervised(COMMAND, '/workspace', { CLOUDFLARE_API_TOKEN: PLACEHOLDER });

    expect(made.box.asked).toBe(0);
    expect(JSON.stringify(made.container.launchEnvs)).not.toContain(VALUE);
  });
});

// Main's decision, 2026-10-20: a computer's process started as a job is told to its workspace when it ends, on the box's
// own heartbeat (no arm of its own, no workspace polling), and a crash is not restarted on a clock: the job ends, and its
// agent decides. The box's restore after it went away is the one restart, and it is told too.
describe('a supervised process that runs as a job', () => {
  const told = (rows: Map<string, unknown>) => [...rows].filter(([key]) => key.startsWith('devbox:incident:')).map(([, row]) => row);

  test('ends told on the heartbeat, with its exit code and what it wrote last, once, and is not restarted', async () => {
    const { box, container, rows } = harness(Devbox);
    const { processId } = await box.startSupervised(COMMAND, undefined, {}, { job: 'bgjob-dev-server' });
    const dir = `/var/tmp/devbox/processes/${processId}`;

    container.files.set(`${dir}/stdout.log`, 'listening on :4100\nError: listen EADDRINUSE: address already in use :::4100\n');
    container.files.set(`${dir}/exit`, '1');
    await box.devboxHeartbeat();
    await box.devboxHeartbeat();

    expect(told(rows)).toEqual([expect.objectContaining({
      stage: 'process-ended', processId, job: 'bgjob-dev-server', exitCode: 1, reason: expect.stringContaining('EADDRINUSE'),
    })]);
    expect(await reservations(box)).toEqual([]);
  });

  test("the box's restore after it went away starts it again, and that is told", async () => {
    const { box, rows } = harness(Devbox);

    rows.set('devbox:proc:dev-server', { processId: 'dev-server', command: COMMAND, cwd: '/workspace', createdAt: 1, job: 'bgjob-dev-server' });
    await box.devboxStartup();

    expect(told(rows)).toEqual([expect.objectContaining({ stage: 'process-restored', processId: 'dev-server', job: 'bgjob-dev-server' })]);
  });

  // Review of the computer process jobs, 2026-10-21: an end with no output carried an empty reason, which the workspace's
  // incident schema refuses, so the end was never delivered.
  test('a process that wrote nothing ends told with a reason that says so', async () => {
    const { box, container, rows } = harness(Devbox);
    const { processId } = await box.startSupervised(COMMAND, undefined, {}, { job: 'bgjob-quiet' });

    container.files.set(`/var/tmp/devbox/processes/${processId}/exit`, '0');
    await box.devboxHeartbeat();

    expect(told(rows)).toEqual([expect.objectContaining({ stage: 'process-ended', job: 'bgjob-quiet', exitCode: 0, reason: 'it ended, and wrote nothing' })]);
  });

  // Review, 2026-10-21: a stop removed the spec without telling its end, so its job ran on forever.
  test('a job process the agent stops is told ended, as stopped', async () => {
    const { box, rows } = harness(Devbox);
    const { processId } = await box.startSupervised(COMMAND, undefined, {}, { job: 'bgjob-stopped' });

    expect(await box.stopSupervised(processId)).toEqual({ stopped: true });

    expect(told(rows)).toEqual([expect.objectContaining({ stage: 'process-ended', processId, job: 'bgjob-stopped', reason: expect.stringContaining('it was stopped') })]);
    expect(await reservations(box)).toEqual([]);
  });

  // Review, 2026-10-21: a start of a command that still ran took its process for a second job, and the first never
  // heard its end; a start after it ended overwrote its job before its end was told.
  test('a start of a command that still runs answers its job; one after it ended tells the earlier end first', async () => {
    const { box, container, rows } = harness(Devbox);
    const first = await box.startSupervised(COMMAND, undefined, {}, { job: 'bgjob-first' });

    expect(await box.startSupervised(COMMAND, undefined, {}, { job: 'bgjob-again' })).toEqual({ processId: first.processId, job: 'bgjob-first' });
    expect(told(rows)).toEqual([]);

    container.files.set(`/var/tmp/devbox/processes/${first.processId}/exit`, '1');
    const second = await box.startSupervised(COMMAND, undefined, {}, { job: 'bgjob-second' });

    expect(second).toEqual({ processId: first.processId, job: 'bgjob-second' });
    expect(told(rows)).toEqual([expect.objectContaining({ stage: 'process-ended', job: 'bgjob-first', exitCode: 1 })]);

    // The successor runs: a beat after it retires nothing of it, and tells nothing more.
    await box.devboxHeartbeat();
    expect(told(rows)).toHaveLength(1);
    expect(await reservations(box)).toEqual([first.processId]);
  });

  test('a process that runs as no job is not told, and keeps its spec for the restore', async () => {
    const { box, container, rows } = harness(Devbox);
    const { processId } = await box.startSupervised(COMMAND);

    container.files.set(`/var/tmp/devbox/processes/${processId}/exit`, '1');
    await box.devboxHeartbeat();

    expect(told(rows)).toEqual([]);
    expect(await reservations(box)).toEqual([processId]);
  });
});
