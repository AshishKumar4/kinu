import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv, scratchDir } from '@kinu.run/test-utils';
import { DEPLOY_BUSY, runLoop } from './staging-loop';

const BRANCH = 'integration/0965';

/** A git that reads no config but the fixture's: no hooks, no signing, no ambient identity. */
function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync([
    'git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=fixture', '-c', 'user.email=fixture@kinu.run', ...args,
  ], { cwd, stdout: 'pipe', stderr: 'pipe', env: childEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }) });

  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);

  return run.stdout.toString().trim();
}

/** The release lands: one merge pushed, as Main pushes it. */
function land(work: string, message: string): string {
  git(work, 'commit', '--allow-empty', '-m', message);
  git(work, 'push', '-q', 'origin', BRANCH);

  return git(work, 'rev-parse', 'HEAD');
}

let work = '';

let worktree = '';

let stateFile = '';

beforeEach(() => {
  const root = scratchDir('staging-loop');

  work = join(root, 'work');
  worktree = join(root, 'staging-loop');
  stateFile = join(root, 'state', 'integration-0965');
  git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(root, 'init', '-q', '-b', BRANCH, 'work');
  git(work, 'remote', 'add', 'origin', join(root, 'origin.git'));
  land(work, 'the release so far');
  git(work, 'worktree', 'add', '-q', '--detach', worktree, `refs/remotes/origin/${BRANCH}`);
});

describe('continuous staging deploys the newest tip, once', () => {
  // The owner's rule (L21): the newest tip wins, and a tip passed while a deploy ran is dropped, not run.
  test('tips pushed while a deploy runs are dropped for the newest, and a deployed tip is not deployed again', () => {
    const first = git(work, 'rev-parse', 'HEAD');
    const seen: string[] = [];
    let passed = '';
    let newest = '';

    const deployed = runLoop({
      branch: BRANCH, worktree, stateFile,
      deploy: (where) => {
        seen.push(git(where, 'rev-parse', 'HEAD'));

        // Two merges land while the first deploy runs.
        if (seen.length === 1) {
          passed = land(work, 'merged during the deploy');
          newest = land(work, 'merged after that');
        }

        return 0;
      },
      waitForDeploys: () => {
        throw new Error('no other deploy runs here');
      },
    });

    expect(deployed).toEqual([first, newest]);
    expect(seen).toEqual([first, newest]);
    expect(seen).not.toContain(passed);
    expect(readFileSync(stateFile, 'utf8').trim()).toBe(newest);
    expect(runLoop({ branch: BRANCH, worktree, stateFile, deploy: () => 0, waitForDeploys: () => {} })).toEqual([]);
  });

  test('a red deploy is not deployed again until the tip moves', () => {
    const red = git(work, 'rev-parse', 'HEAD');
    const deploy = (): number => 1;

    expect(runLoop({ branch: BRANCH, worktree, stateFile, deploy, waitForDeploys: () => {} })).toEqual([red]);
    expect(runLoop({ branch: BRANCH, worktree, stateFile, deploy, waitForDeploys: () => {} })).toEqual([]);

    const next = land(work, 'the fix');

    expect(runLoop({ branch: BRANCH, worktree, stateFile, deploy, waitForDeploys: () => {} })).toEqual([next]);
  });

  // Another staging deploy (a person's, say) holds the deploy lock: this round deployed nothing, so it waits for that
  // one and reads the tip again, which may have moved meanwhile.
  test('a deploy refused for another one running waits for it, then deploys the tip as it then is', () => {
    let refused = false;
    let newest = '';

    const deployed = runLoop({
      branch: BRANCH, worktree, stateFile,
      deploy: () => {
        if (refused) return 0;
        refused = true;

        return DEPLOY_BUSY;
      },
      waitForDeploys: () => {
        newest = land(work, 'merged while the other deploy ran');
      },
    });

    expect(deployed).toEqual([newest]);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(newest);
  });
});
