// staging rc29, 2026-10-21: an exec given no stdin leaves workerd a stdin to end as a task nobody can await, and on a
// lost connection that task failed the box's request as an uncaught "Network connection lost.". Every exec the box
// sends owns its stdin (`containerExec`): a start, with its golden, trust and readiness execs, sends none without one.
import { TestDevbox } from './support/test-devbox';
import { expect, test } from 'bun:test';

import { settle } from '../src/errors';
import { resizePty } from '../src/processes';
import { chainBox } from './support/chain-box';
import { harness } from './support/devbox-harness';
import { pipeExec } from './support/native-process';

test('a box that starts sends no exec whose stdin the platform must end', async () => {
  const { box, container } = harness(TestDevbox);

  await box.devboxStartup();

  expect(container.unownedStdin).toEqual([]);
});

// The platform's `signal()` is the same task: a stop ends the container by an exec through the seam instead. Its kill's
// words are read as the box's procps reads them (the harness asks the host's): staging rc30 sent `kill -TERM -1`, which
// procps refused, and the stop never answered.
test('a box that stops ends its container by an exec, and asks the platform for no signal', async () => {
  const { box, container } = harness(TestDevbox);

  await box.devboxStartup();
  await box.stop();

  expect({ running: container.running.running, signals: container.platformSignals, unowned: container.unownedStdin })
    .toEqual({ running: false, signals: [], unowned: [] });
});

// staging rc30, 2026-10-21: the kill refused its arguments, and the stop waited on a container nothing had told to end.
test('a stop whose kill refuses fails in the kill\'s own words, and the container is still running', async () => {
  const { box, container } = harness(TestDevbox);

  await box.devboxStartup();
  container.stopKillRefusal = '/usr/bin/kill: failed to parse argument';
  const [stopped] = await Promise.allSettled([box.stop()]);

  expect({ failed: stopped.status === 'rejected' ? String(stopped.reason) : 'stopped', running: container.running.running })
    .toEqual({ failed: expect.stringContaining('kill -TERM -- -1 exited 1: /usr/bin/kill: failed to parse argument'), running: true });
});

// A golden container, 2026-10-21: the kill went with the container it ended, exit 137, and the stop read that as refused.
test('a stop whose kill ends with the container it ended answers, the container ended', async () => {
  const { box, container } = harness(TestDevbox);

  await box.devboxStartup();
  container.stopKillExit = 137;
  await box.stop();

  expect(container.running.running).toBe(false);
});

// Reviews of 977bf090f: the SDK's `Files` ran its shim on the bare container, each exec with no stdin of the box's.
test("a box's file and process calls reach its container through the seam, and every pipe the box owns is closed", async () => {
  const { box, container } = harness(TestDevbox);

  await box.devboxStartup();
  await box.mkdir('/workspace/sub', { recursive: true });
  await box.writeFile('/workspace/sub/a.txt', 'a');
  await box.readFile('/workspace/sub/a.txt');
  await box.statFile('/workspace/sub/a.txt');
  await box.exists('/workspace/sub/a.txt');
  await box.listProcesses();
  await box.deleteFile('/workspace/sub/a.txt');

  expect({ unowned: container.unownedStdin, open: container.openStdin }).toEqual({ unowned: [], open: [] });
});

test('a box woken beside its running container reads what its store left through the seam', async () => {
  const chain = chainBox();

  await chain.box.devboxStartup();
  await chain.evict().devboxState();

  expect({ unowned: chain.container.unownedStdin, open: chain.container.openStdin }).toEqual({ unowned: [], open: [] });
});

test("a file read whose stdin will not close fails in the box's words", async () => {
  const { box, container } = harness(TestDevbox);

  await box.devboxStartup();
  await box.writeFile('/workspace/a.txt', 'a');
  container.stdinCloseFault = new Error('Network connection lost.');
  const [read] = await Promise.allSettled([box.readFile('/workspace/a.txt')]);

  expect(read?.status === 'rejected' ? String(read.reason) : 'read').toContain('closing the stdin of /usr/local/bin/sandbox-shim');
});

// The resize's own script, run on a real shell: a client gone is an ended terminal; one whose input is no terminal fails.
test('a resize of a client that has exited answers that its terminal ended', async () => {
  const client = Bun.spawn(['true']);

  await client.exited;

  expect(await settle(resizePty({ exec: pipeExec }, client.pid, { cols: 80, rows: 24 }))).toBe('ended');
});

test("a resize of a client whose input is no terminal fails in stty's words", async () => {
  const client = Bun.spawn(['cat'], { stdin: 'pipe' });
  const [sized] = await Promise.allSettled([settle(resizePty({ exec: pipeExec }, client.pid, { cols: 80, rows: 24 }))]);

  client.kill();
  await client.exited;

  expect(sized?.status === 'rejected' ? String(sized.reason) : 'sized').toContain('stty could not resize the terminal');
});

