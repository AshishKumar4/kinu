/**
 * `kinu` with no arguments treats the working directory as the workspace: it opens the local workspace placed
 * there that was used last, and offers to create one only where none is placed. Driven through `bin/cli.ts` on a
 * real pty, the way a person starts it.
 */
import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { utimesSync, writeFileSync } from 'node:fs';
import { scratchDir } from '@kinu.run/test-utils';

import { runTuiInPty, type PtyStep } from './helpers/pty-screen';

const cliBin = resolve(import.meta.dir, '../bin/cli.ts');

function kinuHome(): string {
  const home = scratchDir('dir-workspace-home');
  // Creation needs a configured provider; nothing here sends a turn, so the endpoint is never called.
  writeFileSync(join(home, 'config.json'), `${JSON.stringify({
    providers: { openaiCompat: { default: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'unused' } } },
  })}\n`, { mode: 0o600 });

  return home;
}

function createLocalWorkspace(home: string, directory: string, name: string, writtenSecondsAgo: number): void {
  const created = Bun.spawnSync([process.execPath, cliBin, 'create', name, '--mode', 'local'], {
    cwd: directory,
    env: { ...process.env, KINU_HOME: home, KINU_SKIP_DAEMON: '1', KINU_UPDATE_CHECK: '0' },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect(created.exitCode, created.stderr.toString()).toBe(0);
  const at = Date.now() / 1000 - writtenSecondsAgo;
  utimesSync(join(home, name, 'agent.db'), at, at);
}

function launchIn(home: string, directory: string, until: string, after: readonly PtyStep[] = []) {
  return runTuiInPty(cliBin, {
    cwd: directory,
    cols: 120,
    rows: 32,
    env: { KINU_HOME: home, KINU_SKIP_DAEMON: '1', KINU_UPDATE_CHECK: '0' },
    steps: [{ wait: until, timeout: 45 }, ...after],
  });
}

describe('kinu in a directory', () => {
  test('opens the workspace placed in that directory that was used last, not the newest anywhere', () => {
    const home = kinuHome();
    const project = scratchDir('dir-workspace-project');
    const elsewhere = scratchDir('dir-workspace-elsewhere');
    createLocalWorkspace(home, project, 'project-older', 3000);
    createLocalWorkspace(home, project, 'project-newer', 2000);
    createLocalWorkspace(home, elsewhere, 'elsewhere-latest', 0);

    const run = launchIn(home, project, 'project-newer');

    expect(run.waits.every((wait) => wait.met), run.screen).toBe(true);
    expect(run.screen).toContain('Send a message');
    expect(run.screen).not.toContain('What is this workspace for?');
    expect(run.screen).not.toContain('elsewhere-latest');
  });

  test('offers to create a workspace where none is placed, even when others exist elsewhere', () => {
    const home = kinuHome();
    const elsewhere = scratchDir('dir-workspace-elsewhere');
    createLocalWorkspace(home, elsewhere, 'elsewhere-only', 0);
    const empty = scratchDir('dir-workspace-empty');

    const run = launchIn(home, empty, 'What is this workspace for?');

    expect(run.waits.every((wait) => wait.met), run.screen).toBe(true);
    expect(run.screen).not.toContain('Send a message');
  });
});

/** A closed terminal window or `kill` must end kinu: a TUI left running keeps the conversation's driver lease. */
describe('kinu ends with its terminal', () => {
  for (const signal of ['SIGHUP', 'SIGTERM'] as const) {
    test(`${signal} on an open conversation ends the process`, () => {
      const home = kinuHome();
      const project = scratchDir('dir-workspace-signal');
      createLocalWorkspace(home, project, 'signalled', 0);

      const run = launchIn(home, project, 'Send a message', [{ signal }, { sleep: 10 }]);

      expect(run.waits.every((wait) => wait.met), run.screen).toBe(true);
      expect(run.exited, run.screen).toBe(true);
    });
  }

  test('SIGHUP on the home screen ends the process', () => {
    const home = kinuHome();
    const empty = scratchDir('dir-workspace-signal-home');

    const run = launchIn(home, empty, 'What is this workspace for?', [{ signal: 'SIGHUP' }, { sleep: 10 }]);

    expect(run.waits.every((wait) => wait.met), run.screen).toBe(true);
    expect(run.exited, run.screen).toBe(true);
  });
});
