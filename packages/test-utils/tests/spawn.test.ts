// `killAndAwaitExit` stands between a teardown and the release of a directory a recorded process writes in, so it
// must end the process whatever it does with SIGTERM, return only once the process has exited, and never touch a
// stranger that holds the recorded pid now.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_MODE_ENV } from '../src/ambient-env';
import { present } from '../src/present';
import { scratchDir } from '../src/scratch';
import { killAndAwaitExit, recordedIn, runToExit, spawnTest } from '../src/spawn';

/** Exited: no process holds the pid, or only its zombie does. */
async function exited(pid: number): Promise<boolean> {
  const state = (await runToExit(['ps', '-o', 'stat=', '-p', String(pid)])).stdout.trim();

  return state === '' || state.startsWith('Z');
}

/** Spawns `cmd` and resolves once it prints `ready`, its sign that it is set up. */
async function started(cmd: readonly string[]): Promise<Bun.Subprocess<'ignore', 'pipe', 'inherit'>> {
  const child = spawnTest([...cmd], { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' });
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

  expect(members.some((member) => member !== leader.pid)).toBe(true);

  await killAndAwaitExit(present(recordedIn(pidfile, /^pid=(\d+)$/mu), 'the record'), { group: true });

  for (const member of members) expect(await exited(member)).toBe(true);
  await leader.exited;
});

test('with group, a recorded pid that leads no group is refused, and nothing is killed', async () => {
  const pidfile = join(scratchDir('kill-leaderless'), 'state');
  const child = await started(['sh', '-c', 'echo ready; exec sleep 30']);
  writeFileSync(pidfile, `pid=${String(child.pid)}\n`);

  const refused = killAndAwaitExit(present(recordedIn(pidfile, /^pid=(\d+)$/mu), 'the record'), { group: true });
  await expect(refused).rejects.toMatchObject({ code: 'io' });
  await expect(refused).rejects.toThrow(String(child.pid));

  expect(await exited(child.pid)).toBe(false);
  child.kill('SIGKILL');
  await child.exited;
});

test('a Bun child creates scratch under the current preload environment, not the parent launch snapshot', async () => {
  const launch = scratchDir('spawn-launch');
  const current = scratchDir('spawn-current');
  const helper = new URL('../src/spawn.ts', import.meta.url).pathname;
  const scratch = new URL('../src/scratch.ts', import.meta.url).pathname;

  const child = `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { scratchDir } from ${JSON.stringify(scratch)};
    const root = scratchDir('child-marker');
    writeFileSync(join(root, 'marker'), 'current scratch');
    console.log(root);
  `;

  const parent = `
    import { runToExit } from ${JSON.stringify(helper)};
    process.env.TMPDIR = ${JSON.stringify(current)};
    const child = await runToExit([process.execPath, '-e', ${JSON.stringify(child)}]);
    console.log(child.stdout.trim());
    process.exitCode = child.exitCode;
  `;

  const result = await runToExit([process.execPath, '-e', parent], { env: { ...process.env, TMPDIR: launch } });
  const created = result.stdout.trim();


  expect(result.exitCode, result.stderr).toBe(0);
  expect(created.startsWith(current + '/')).toBe(true);
  expect(existsSync(join(created, 'marker'))).toBe(true);
  expect(readdirSync(launch)).toEqual([]);
});

// Bun takes a caller carrying a coding agent's variable for an agent and prints no `(pass)` line, so a test that reads a
// child's report read none on an agent's machine and every one on armada (ladder.test.ts, 2026-10-19).
test('a child bun test reports its passes whoever runs this one: the agent variables never reach it', async () => {
  const dir = scratchDir('agent-mode');
  const suite = join(dir, 'one.test.ts');

  writeFileSync(suite, 'import { test } from "bun:test";\ntest("one passes", () => {});\n');
  const agent = Object.fromEntries(AGENT_MODE_ENV.map((name) => [name, '1']));

  const reports = await Promise.all([undefined, agent].map(async (extra) => {
    const run = await runToExit([process.execPath, 'test', suite], { cwd: dir, env: { ...process.env, ...extra } });

    return (run.stdout + run.stderr).match(/^\(pass\) one passes/gmu)?.length ?? 0;
  }));

  expect(reports).toEqual([1, 1]);
});
