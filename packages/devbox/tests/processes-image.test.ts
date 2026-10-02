// Review 3f6, 2026-09-30: the process scripts in the image's own shell, which the harness only
// imitates. A stop sent TERM and waited for the pid forever, so a process that ignores TERM held
// every quiesce; and a launch whose exec never ran left `starting` for good, so a retry reported a
// start it never made and a stop waited forever for a pid. Every wait here ends on the condition it
// names, inside the container: a stop that never returns is this suite never finishing.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { Processes } from '../src/processes';
import { buildBlockImage, removeBlockImage } from './support/block-image';
import { dockerContainer, inContainer, type ExecFault } from './support/docker-container';

const image = `devbox-processes-${process.pid}`;

const name = `devbox-processes-${process.pid}`;

const ROOT = '/var/tmp/devbox/processes';

const faults = new Map<string, ExecFault>();

/** The next launch of an id in `faults` meets its fault; every other exec runs. */
const processes = new Processes(dockerContainer(name, (argv) => {
  const id = argv[3] === 'devbox-process' ? argv[4]?.split('/').at(-1) : undefined;
  const fault = id === undefined ? undefined : faults.get(id);

  if (id !== undefined) faults.delete(id);

  return fault;
}));

beforeAll(() => {
  buildBlockImage(image);
  const started = spawnSync('docker', ['run', '--detach', '--name', name, '--network=none', image], { encoding: 'utf8' });

  if (started.status !== 0) throw new Error(started.stderr);
});

afterAll(() => {
  const removal = spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' });

  removeBlockImage(image);

  if (removal.status !== 0) throw new Error(removal.stderr);
});

/** Returns once the shell test `condition` holds in the container; `$d` is the process's directory. */
function awaitHolds(id: string, condition: string): void {
  const waited = inContainer(name, ['sh', '-c', `d=${ROOT}/${id}; until ${condition}; do sleep 0.1; done`]);

  if (waited.status !== 0) throw new Error(waited.stderr);
}

/** `command` runs as its own process: the wrapper wrote its pid and the shell became the command. */
const runs = (command: string): string => `ps -eo args= | grep -qxF -- '${command}'`;

/** How many processes run exactly the command line `command`. */
function running(command: string): number {
  return Number(inContainer(name, ['sh', '-c', `ps -eo args= | grep -cxF -- '${command}' || true`]).stdout.trim());
}

test('a stop escalates past an ignored TERM and returns once the process group has exited', async () => {
  await processes.start(`trap '' TERM; touch /tmp/ignoring-term; while :; do sleep 1; done`, { cwd: '/', processId: 'ignores-term' });
  awaitHolds('ignores-term', '[ -f /tmp/ignoring-term ]');
  const group = inContainer(name, ['cat', `${ROOT}/ignores-term/pid`]).stdout.trim().split(' ')[0];

  await processes.kill('ignores-term');
  awaitHolds('ignores-term', '[ -f "$d/exit" ]');

  expect({
    groupAlive: inContainer(name, ['sh', '-c', `kill -s 0 -- -${group}`]).status === 0,
    record: await processes.get('ignores-term'),
  }).toEqual({
    groupAlive: false,
    // 137: the group ended on KILL, once the grace had passed.
    record: expect.objectContaining({ status: 'failed', exitCode: 137 }),
  });
});

test('a stop of a process that ends on TERM sends no KILL', async () => {
  await processes.start('sleep 7001', { cwd: '/', processId: 'obeys-term' });
  awaitHolds('obeys-term', runs('sleep 7001'));

  await processes.kill('obeys-term');
  awaitHolds('obeys-term', '[ -f "$d/exit" ]');

  // 143: TERM ended it.
  expect(await processes.get('obeys-term')).toMatchObject({ status: 'failed', exitCode: 143 });
});

test('a launch into a missing cwd records its failure; the retry launches, and a stop returns', async () => {
  const [first] = await Promise.allSettled([processes.start('sleep 7002', { cwd: '/tmp/made-later', processId: 'late-cwd' })]);
  expect(first).toMatchObject({ status: 'fulfilled' });
  awaitHolds('late-cwd', '[ -f "$d/exit" ]');

  const failed = {
    recorded: await processes.get('late-cwd'),
    reason: inContainer(name, ['cat', `${ROOT}/late-cwd/stderr.log`]).stdout,
  };

  expect(failed).toEqual({
    recorded: expect.objectContaining({ status: 'failed', exitCode: 1 }),
    reason: "Failed to change directory to '/tmp/made-later'\n",
  });

  expect(inContainer(name, ['mkdir', '-p', '/tmp/made-later']).status).toBe(0);
  await processes.start('sleep 7002', { cwd: '/tmp/made-later', processId: 'late-cwd' });
  awaitHolds('late-cwd', runs('sleep 7002'));
  const launched = running('sleep 7002');
  await processes.kill('late-cwd');

  expect(launched).toBe(1);
});

test('an exec the runtime refuses leaves a launch that never ran; the retry launches, and a stop returns', async () => {
  faults.set('refused-exec', { kind: 'refuse', error: new Error('the runtime refused this exec') });

  const [first] = await Promise.allSettled([processes.start('sleep 7003', { cwd: '/', processId: 'refused-exec' })]);

  expect({ first, recorded: await processes.get('refused-exec') }).toEqual({
    first: { status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('the runtime refused this exec') }) },
    recorded: expect.objectContaining({ status: 'failed', exitCode: undefined }),
  });

  await processes.start('sleep 7003', { cwd: '/', processId: 'refused-exec' });
  awaitHolds('refused-exec', runs('sleep 7003'));
  const launched = running('sleep 7003');
  await processes.kill('refused-exec');

  expect(launched).toBe(1);
});

test('an exec whose answer was lost after the spawn runs once, however the retry finds it', async () => {
  faults.set('lost-answer', { kind: 'lose', error: new Error('the answer to this exec was lost') });
  const [first] = await Promise.allSettled([processes.start('sleep 7004', { cwd: '/', processId: 'lost-answer' })]);

  // Adopted if its wrapper claimed the launch first, relaunched if the claim went to nobody; a wrapper
  // that loses the claim exits before it runs anything.
  const retried = await processes.start('sleep 7004', { cwd: '/', processId: 'lost-answer' });
  awaitHolds('lost-answer', runs('sleep 7004'));
  const launched = running('sleep 7004');
  await processes.kill('lost-answer');

  expect({ first, retried: retried.id, launched }).toEqual({
    first: { status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('the answer to this exec was lost') }) },
    retried: 'lost-answer', launched: 1,
  });
});

test('a launched process records the boot it runs in, and reads as running in that boot', async () => {
  await processes.start('sleep 7101', { cwd: '/', processId: 'this-boot' });
  awaitHolds('this-boot', runs('sleep 7101'));
  const boot = inContainer(name, ['cat', '/proc/sys/kernel/random/boot_id']).stdout.trim();

  expect({
    recorded: inContainer(name, ['cat', `${ROOT}/this-boot/pid`]).stdout.trim().split(' ')[1],
    status: (await processes.get('this-boot'))?.status,
  }).toEqual({ recorded: boot, status: 'running' });

  await processes.kill('this-boot');
});

test('a record from another boot naming a live pid reads lost, and a stop never signals that pid', async () => {
  // PID 1 lives in every boot: a pid file older than the boot, one naming another boot, and an old-form one from now.
  const restored = inContainer(name, ['sh', '-c', `for id in restored foreign current; do mkdir -p ${ROOT}/$id; `
    + `printf '{"id":"%s","command":"sleep 1","cwd":"/"}' $id > ${ROOT}/$id/process.json; ln -sf launched ${ROOT}/$id/launch; done; `
    + `echo 1 > ${ROOT}/restored/pid; touch -d '2020-01-01' ${ROOT}/restored/pid; `
    + `echo "1 00000000-0000-0000-0000-000000000000" > ${ROOT}/foreign/pid; echo 1 > ${ROOT}/current/pid`]);

  if (restored.status !== 0) throw new Error(restored.stderr);
  await processes.kill('restored');
  await processes.kill('foreign');

  const current = await processes.get('current');
  inContainer(name, ['rm', '-rf', `${ROOT}/current`]);

  expect({
    restored: (await processes.get('restored'))?.status,
    foreign: (await processes.get('foreign'))?.status,
    current: current?.status,
    init: inContainer(name, ['kill', '-0', '1']).status,
  }).toEqual({ restored: 'failed', foreign: 'failed', current: 'running', init: 0 });
});
