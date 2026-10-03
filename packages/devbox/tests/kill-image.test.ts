// 2026-10-03: a supervised stop and an untimed kill end a command by one contract, in the real image's
// shell: everything the command started is gone before either answers. The untimed kill answered once
// what it first saw was gone, so a process the command started on TERM outlived the answer.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../src/lifecycle';
import { Processes } from '../src/processes';
import { buildBlockImage, removeBlockImage } from './support/block-image';
import { Devbox, harness } from './support/devbox-harness';
import { dockerContainer, inContainer } from './support/docker-container';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';

const image = `devbox-kill-${process.pid}`;

const name = `devbox-kill-${process.pid}`;

/** The harness runs a command whose cwd names its scratch prefix on the given exec, here the container's. */
const cwd = `/tmp/${DEVBOX_SCRATCH_PREFIX}kill`;

class TestBox extends Devbox<unknown> {
  protected override get policy(): DevboxPolicy {
    return { ...DEFAULT_DEVBOX_POLICY, portWaitMs: 4, portProbeIntervalMs: 1 };
  }

  protected override get ambientCheckpoints(): boolean {
    return false;
  }
}

beforeAll(() => {
  buildBlockImage(image);
  const started = spawnSync('docker', ['run', '--detach', '--name', name, '--network=none', image], { encoding: 'utf8' });

  if (started.status !== 0) throw new Error(started.stderr);
  inContainer(name, ['mkdir', '-p', cwd]);
});

afterAll(() => {
  const removal = spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' });

  removeBlockImage(image);

  if (removal.status !== 0) throw new Error(removal.stderr);
});

/** How many processes run exactly the command line `command`. */
function running(command: string): number {
  return Number(inContainer(name, ['sh', '-c', `ps -eo args= | grep -cxF -- '${command}' || true`]).stdout.trim());
}

interface Caller {
  /** Starts `command` as `id`; resolves once it has run past `touch ready`. */
  run(command: string, id: string): Promise<void>;
  end(id: string): Promise<void>;
}

/** Awaited rather than run synchronously: an untimed command reaches the container only while this test yields. */
async function ready(id: string): Promise<void> {
  const waited = Bun.spawn(['docker', 'exec', name, 'sh', '-c', `until [ -f ${cwd}/${id}.ready ]; do sleep 0.1; done`]);

  if (await waited.exited !== 0) throw new Error(`${id} never became ready`);
}

const processes = new Processes(dockerContainer(name));

const supervised: Caller = {
  run: async (command, id) => { await processes.start(command, { cwd, processId: id }); await ready(id); },
  end: (id) => processes.kill(id),
};

async function untimedCaller(): Promise<Caller> {
  const container = dockerContainer(name);
  const { box } = harness(TestBox, undefined, (argv, options) => container.exec(argv, options));
  await box.devboxStartup();
  const runs = new Map<string, Promise<unknown>>();

  return {
    run: async (command, id) => { runs.set(id, box.execUntimed(command, { cwd, execId: id })); await ready(id); },
    end: async (id) => { await box.killUntimed(id); await Promise.allSettled([runs.get(id)]); },
  };
}

describe.each([
  { label: 'a supervised stop', tag: 'supervised', caller: () => Promise.resolve(supervised), seconds: 6100 },
  { label: 'an untimed kill', tag: 'untimed', caller: untimedCaller, seconds: 6200 },
])('$label', ({ tag, caller, seconds }) => {
  test('ends a command that ignores TERM on KILL, and answers once it is gone', async () => {
    const ending = await caller();
    const sleeper = `sleep ${String(seconds + 1)}`;
    await ending.run(`trap '' TERM; ${sleeper} & touch ${tag}-ignores.ready; wait`, `${tag}-ignores`);

    await ending.end(`${tag}-ignores`);

    expect(running(sleeper)).toBe(0);
  });

  test('ends what the command starts as TERM arrives, after the command itself has exited', async () => {
    const ending = await caller();
    const late = `sleep ${String(seconds + 2)}`;
    // On TERM the shell starts a process that ignores TERM, and exits: the process is no longer in its tree.
    await ending.run(`trap '(trap "" TERM; exec ${late}) & exit 0' TERM; sleep ${String(seconds + 3)} & touch ${tag}-late.ready; wait`, `${tag}-late`);

    await ending.end(`${tag}-late`);

    expect(running(late)).toBe(0);
  });
});
