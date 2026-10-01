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

// A release in flight: main is behind, integration/0965 holds the deployed build and one later commit, and a lane's
// commit is on no branch of origin.
const root = scratchDir('evals-dispatch');

const work = join(root, 'work');

const bin = join(root, 'bin');

const builds = { onMain: '', deployed: '', unpushed: '' };

beforeAll(() => {
  git(root, 'init', '--bare', '-b', 'main', 'origin.git');
  git(root, 'init', '-b', 'main', 'work');
  git(work, 'remote', 'add', 'origin', join(root, 'origin.git'));
  git(work, 'commit', '--allow-empty', '-m', 'the release before');
  builds.onMain = git(work, 'rev-parse', '--short', 'HEAD');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-q', '-b', 'integration/0965');
  git(work, 'commit', '--allow-empty', '-m', 'the deployed build');
  builds.deployed = git(work, 'rev-parse', '--short', 'HEAD');
  git(work, 'commit', '--allow-empty', '-m', 'merged while it deployed');
  git(work, 'push', '-q', 'origin', 'integration/0965');
  git(work, 'checkout', '-q', '-b', 'lane/unpushed');
  git(work, 'commit', '--allow-empty', '-m', 'on no branch of origin');
  builds.unpushed = git(work, 'rev-parse', '--short', 'HEAD');
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

describe('the evals of a staging build start from the branch that holds it', () => {
  // GitHub runs the workflow the dispatched ref defines: a ref behind the build runs an older evals.yml, or refuses
  // the build input, so the ref must hold the build. main, behind it here, is never that ref.
  test('the dispatched ref names a branch on origin that holds the build, with the build as its input', () => {
    const { status, stdout, asked } = dispatchFor(builds.deployed);
    const ref = /-f ref=(\S+)/u.exec(asked)?.[1] ?? '';

    expect([status, stdout]).toEqual([0, `4242 https://github.com/o/r/actions/runs/4242 ${ref}`]);
    expect(asked).toContain(`-f inputs[build]=${builds.deployed}`);
    expect(git(work, 'branch', '-r', '--contains', builds.deployed, '--format=%(refname:strip=3)').split('\n')).toContain(ref);
    expect(ref).toBe('integration/0965');
  });

  test('of the branches that hold a build, the one whose tip is nearest it', () => {
    expect(/-f ref=(\S+)/u.exec(dispatchFor(builds.onMain).asked)?.[1]).toBe('main');
  });

  test('a build no branch on origin holds is not dispatched, and the deploy is told to push it', () => {
    const { status, stdout, asked } = dispatchFor(builds.unpushed);

    expect([status, stdout]).toEqual([1, `no branch on origin holds ${builds.unpushed}: push the branch it came from, then deploy again`]);
    expect(asked).toBe('');
  });
});
