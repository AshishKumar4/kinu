import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv, scratchDir } from '@kinu.run/test-utils';

const SCRIPT = join(import.meta.dir, 'evals-dispatch.ts');

/** A git that reads no config but the fixture's: no hooks, no signing, no ambient identity. */
function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync([
    'git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=fixture', '-c', 'user.email=fixture@kinu.run', ...args,
  ], { cwd, stdout: 'pipe', stderr: 'pipe', env: childEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }) });

  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);

  return run.stdout.toString().trim();
}

/** GitHub's side, which this suite cannot reach: a `gh` that writes down what it was asked and starts run 4242. */
const STAND_IN_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
printf '{"workflow_run_id":4242,"run_url":"https://api.github.com/repos/o/r/actions/runs/4242","html_url":"https://github.com/o/r/actions/runs/4242"}'
`;

// A release in flight: main and integration/0965 both stand at the deployed build, then integration/0965 takes one
// more commit that main does not hold.
const root = scratchDir('evals-dispatch');

const work = join(root, 'work');

const bin = join(root, 'bin');

const builds = { deployed: '', unreleased: '' };

beforeAll(() => {
  git(root, 'init', '--bare', '-b', 'main', 'origin.git');
  git(root, 'init', '-b', 'main', 'work');
  git(work, 'remote', 'add', 'origin', join(root, 'origin.git'));
  git(work, 'commit', '--allow-empty', '-m', 'the deployed build');
  builds.deployed = git(work, 'rev-parse', '--short', 'HEAD');
  git(work, 'push', '-q', 'origin', 'main', 'main:integration/0965');
  git(work, 'checkout', '-q', '-b', 'integration/0965');
  git(work, 'commit', '--allow-empty', '-m', 'merged while it deployed');
  builds.unreleased = git(work, 'rev-parse', '--short', 'HEAD');
  git(work, 'push', '-q', 'origin', 'integration/0965');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), STAND_IN_GH, { mode: 0o755 });
});

function dispatchFor(build: string) {
  const log = join(root, `gh-${build}.log`);

  const run = Bun.spawnSync([process.execPath, SCRIPT, build], {
    cwd: work, stdout: 'pipe', stderr: 'pipe', env: childEnv({ PATH: `${bin}:${process.env.PATH ?? ''}`, GH_LOG: log }),
  });

  return { status: run.exitCode, stdout: run.stdout.toString().trim(), asked: existsSync(log) ? readFileSync(log, 'utf8') : '' };
}

// The `eval` environment releases its secrets to main alone: run 37723534351, dispatched from integration/0965 where
// both branches stood at the build, had both legs refused before a step ran.
describe('the evals of a staging build start from main', () => {
  test('a build main holds is dispatched from main, though a release branch stands at it too', () => {
    const { status, stdout, asked } = dispatchFor(builds.deployed);

    expect([status, stdout]).toEqual([0, '4242 https://github.com/o/r/actions/runs/4242']);
    expect(asked).toContain('-f ref=main');
    expect(asked).toContain(`-f inputs[build]=${builds.deployed}`);
  });

  test('a build main does not hold is not dispatched, and the refusal names it', () => {
    const { status, stdout, asked } = dispatchFor(builds.unreleased);

    expect(status).toBe(1);
    expect(stdout).toContain(builds.unreleased);
    expect(asked).toBe('');
  });
});
