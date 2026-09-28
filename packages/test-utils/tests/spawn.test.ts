// `killAndAwaitExit` stands between a teardown and the release of a directory a recorded process writes in, so it
// must end the process whatever it does with SIGTERM, return only once the process has exited, and never touch a
// stranger that holds the recorded pid now.
import { expect, test } from 'bun:test';
import { utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { present } from '../src/present';
import { scratchDir } from '../src/scratch';
import { killAndAwaitExit, recordedIn, runToExit } from '../src/spawn';

/** Exited: no process holds the pid, or only its zombie does. */
async function exited(pid: number): Promise<boolean> {
  const state = (await runToExit(['ps', '-o', 'stat=', '-p', String(pid)])).stdout.trim();

  return state === '' || state.startsWith('Z');
}

/** Spawns `cmd` and resolves once it prints `ready`, its sign that it is set up. */
async function started(cmd: readonly string[]): Promise<Bun.Subprocess<'ignore', 'pipe', 'inherit'>> {
  const child = Bun.spawn([...cmd], { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' });
  const { value } = await child.stdout.getReader().read();

  expect(new TextDecoder().decode(value)).toContain('ready');

  return child;
}

test('a recorded process that ignores SIGTERM is killed, and has exited when the call settles', async () => {
  const pidfile = join(scratchDir('kill-recorded'), 'daemon.pid');
  const child = await started(['sh', '-c', "trap '' TERM; echo ready; exec sleep 30"]);
  writeFileSync(pidfile, `${String(child.pid)}\n`);

  await killAndAwaitExit(present(recordedIn(pidfile), 'the record'));

  expect(await exited(child.pid)).toBe(true);
  await child.exited;
  expect(child.signalCode).toBe('SIGKILL');
});

test('a pid held by a process that started after its record was written is left alone', async () => {
  const pidfile = join(scratchDir('kill-stranger'), 'daemon.pid');
  const stranger = await started(['sh', '-c', 'echo ready; exec sleep 30']);
  writeFileSync(pidfile, `${String(stranger.pid)}\n`);
  // The record is a minute older than the process that holds its pid now.
  const written = new Date(Date.now() - 60_000);
  utimesSync(pidfile, written, written);

  await killAndAwaitExit(present(recordedIn(pidfile), 'the record'));

  expect(await exited(stranger.pid)).toBe(false);
  stranger.kill('SIGKILL');
  await stranger.exited;
});

test('with group, every process in the recorded group has exited when the call settles', async () => {
  const pidfile = join(scratchDir('kill-group'), 'state');
  const leader = await started(['setsid', 'sh', '-c', 'sleep 30 & sleep 30 & echo ready; wait']);
  writeFileSync(pidfile, `pid=${String(leader.pid)}\n`);
  const members = (await runToExit(['pgrep', '-g', String(leader.pid)])).stdout.split('\n').filter((line) => line !== '').map(Number);

  expect(members).toHaveLength(3);

  await killAndAwaitExit(present(recordedIn(pidfile, /^pid=(\d+)$/mu), 'the record'), { group: true });

  for (const member of members) expect(await exited(member)).toBe(true);
  await leader.exited;
});

test('with group, a recorded pid that leads no group is refused, and nothing is killed', async () => {
  const pidfile = join(scratchDir('kill-leaderless'), 'state');
  const child = await started(['sh', '-c', 'echo ready; exec sleep 30']);
  writeFileSync(pidfile, `pid=${String(child.pid)}\n`);

  await expect(killAndAwaitExit(present(recordedIn(pidfile, /^pid=(\d+)$/mu), 'the record'), { group: true }))
    .rejects.toThrow(`pid ${String(child.pid)} leads no process group`);

  expect(await exited(child.pid)).toBe(false);
  child.kill('SIGKILL');
  await child.exited;
});
