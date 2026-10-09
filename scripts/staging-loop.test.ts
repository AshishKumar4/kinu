import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv, runToExit, scratchDir } from '@kinu.run/test-utils';
import { DEPLOY_BUSY, prepareInstall, promoteRound, runLoop } from './staging-loop';

const BRANCH = 'integration/0965';

/** A git that reads no config but the fixture's: no hooks, no signing, no ambient identity. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const run = await runToExit([
    'git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=fixture', '-c', 'user.email=fixture@kinu.run', ...args,
  ], { cwd, env: childEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }) });

  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);

  return run.stdout.trim();
}

/** The release lands: one merge pushed, as Main pushes it. */
async function land(work: string, message: string): Promise<string> {
  await git(work, 'commit', '--allow-empty', '-m', message);
  await git(work, 'push', '-q', 'origin', BRANCH);

  return await git(work, 'rev-parse', 'HEAD');
}

/** The tip-selection fixtures carry no packages, so there is nothing to install; the install has its own fixture. */
const unpackaged = (): void => {};

let work = '';

let worktree = '';

let stateFile = '';

beforeEach(async () => {
  const root = scratchDir('staging-loop');

  work = join(root, 'work');
  worktree = join(root, 'staging-loop');
  stateFile = join(root, 'state', 'integration-0965');
  await git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  await git(root, 'init', '-q', '-b', BRANCH, 'work');
  await git(work, 'remote', 'add', 'origin', join(root, 'origin.git'));
  await land(work, 'the release so far');
  await git(work, 'worktree', 'add', '-q', '--detach', worktree, `refs/remotes/origin/${BRANCH}`);
});

describe('continuous staging deploys the newest tip, once', () => {
  // The owner's rule (L21): the newest tip wins, and a tip passed while a deploy ran is dropped, not run.
  test('tips pushed while a deploy runs are dropped for the newest, and a deployed tip is not deployed again', async () => {
    const first = await git(work, 'rev-parse', 'HEAD');
    const seen: string[] = [];
    let passed = '';
    let newest = '';

    const deployed = await runLoop({
      branch: BRANCH, worktree, stateFile, prepare: unpackaged,
      deploy: async (where) => {
        seen.push(await git(where, 'rev-parse', 'HEAD'));

        // Two merges land while the first deploy runs.
        if (seen.length === 1) {
          passed = await land(work, 'merged during the deploy');
          newest = await land(work, 'merged after that');
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
    expect(await runLoop({ branch: BRANCH, worktree, stateFile, prepare: unpackaged, deploy: () => 0, waitForDeploys: () => {} })).toEqual([]);
  });

  test('a red deploy is not deployed again until the tip moves', async () => {
    const red = await git(work, 'rev-parse', 'HEAD');
    const deploy = (): number => 1;

    expect(await runLoop({ branch: BRANCH, worktree, stateFile, prepare: unpackaged, deploy, waitForDeploys: () => {} })).toEqual([red]);
    expect(await runLoop({ branch: BRANCH, worktree, stateFile, prepare: unpackaged, deploy, waitForDeploys: () => {} })).toEqual([]);

    const next = await land(work, 'the fix');

    expect(await runLoop({ branch: BRANCH, worktree, stateFile, prepare: unpackaged, deploy, waitForDeploys: () => {} })).toEqual([next]);
  });

  // Another staging deploy (a person's, say) holds the deploy lock: this round deployed nothing, so it waits for that
  // one and reads the tip again, which may have moved meanwhile.
  test('a deploy refused for another one running waits for it, then deploys the tip as it then is', async () => {
    let refused = false;
    let newest = '';

    const deployed = await runLoop({
      branch: BRANCH, worktree, stateFile, prepare: unpackaged,
      deploy: () => {
        if (refused) return 0;
        refused = true;

        return DEPLOY_BUSY;
      },
      waitForDeploys: async () => {
        newest = await land(work, 'merged while the other deploy ran');
      },
    });

    expect(deployed).toEqual([newest]);
    expect(await git(worktree, 'rev-parse', 'HEAD')).toBe(newest);
  });
});

// The owner's rule (decided with Main, 2026-10-01): production takes the last tip staging deployed once `promote.ts
// check` passes for it, through `deploy.sh --promote`; a red promotion is never tried again, and the next verified tip
// deploys forward.
describe('auto-promotion takes the last staged tip once it is verified, once', () => {
  const round = (overrides: Partial<Parameters<typeof promoteRound>[0]> = {}) => {
    const promoted: string[] = [];

    const input = {
      stagedFile: stateFile, triedFile: `${stateFile}.tried`, worktree, prepare: unpackaged,
      productionBuild: async () => '',
      verified: () => 0,
      promote: async (where: string) => {
        promoted.push(await git(where, 'rev-parse', 'HEAD'));

        return 0;
      },
      ...overrides,
    };

    return { promoted, run: () => promoteRound(input) };
  };

  test('an unverified tip waits, a verified one is promoted from a checkout at it, and is not promoted twice', async () => {
    const staged = await land(work, 'a staged build');
    let verdict = 1;
    const { promoted, run } = round({ verified: () => verdict });

    await Bun.write(stateFile, `${staged}\n`);
    expect(await run()).toBe(`${staged} is not verified yet`);
    expect(promoted).toEqual([]);

    verdict = 0;
    expect(await run()).toBe(`promoted ${staged}`);
    expect(promoted).toEqual([staged]);
    expect(await run()).toBe(`${staged} was tried already`);
    expect(promoted).toEqual([staged]);
  });

  test('a red promotion is not tried again, and the next staged tip is', async () => {
    const red = await land(work, 'a build whose promotion goes red');
    const { promoted, run } = round({ promote: async (where) => (promoted.push(await git(where, 'rev-parse', 'HEAD')) === 1 ? 1 : 0) });

    await Bun.write(stateFile, `${red}\n`);
    expect(await run()).toBe(`promoting ${red} went red (exit 1); it is not tried again`);
    expect(await run()).toBe(`${red} was tried already`);

    const next = await land(work, 'the next build');

    await Bun.write(stateFile, `${next}\n`);
    expect(await run()).toBe(`promoted ${next}`);
    expect(promoted).toEqual([red, next]);
  });

  test('a tip production serves already, or a promotion refused for another running, is not marked tried', async () => {
    const staged = await land(work, 'a staged build');

    await Bun.write(stateFile, `${staged}\n`);
    expect(await round({ productionBuild: async () => staged.slice(0, 9) }).run()).toBe(`production serves ${staged} already`);

    const busy = round({ promote: () => DEPLOY_BUSY });

    expect(await busy.run()).toBe('another production deploy is running');
    expect(await round().run()).toBe(`promoted ${staged}`);
  });
});

/** A package `name` at `version`, as the npm tarball a `file:` dependency names: offline and exact. */
async function tarball(dir: string, name: string, version: string): Promise<string> {
  const unpacked = join(dir, `${name}-${version}`, 'package');

  mkdirSync(unpacked, { recursive: true });
  writeFileSync(join(unpacked, 'package.json'), JSON.stringify({ name, version }));
  await runToExit(['tar', 'czf', join(dir, `${name}-${version}.tgz`), '-C', join(dir, `${name}-${version}`), 'package']);

  return `file:./vendor/${name}-${version}.tgz`;
}

/** The release changes its dependencies: package.json and the bun.lock an install writes for it, pushed. */
async function depend(dependencies: Record<string, string>, message: string): Promise<string> {
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'fixture', private: true, dependencies }));

  if ((await runToExit(['bun', 'install'], { env: process.env, cwd: work })).exitCode !== 0) throw new Error(`bun install for ${message} failed`);
  await git(work, 'add', 'package.json', 'bun.lock', 'vendor');

  return await land(work, message);
}

// 2026-10-01: a checkout moves the revision and keeps node_modules, and deploy.sh installs only when there is none, so
// the loop's first deploy and any tip that changes bun.lock would deploy on another revision's install. And a frozen
// install over the old tree updates what the lock names but keeps what it dropped (measured with bun 1.4), the
// 2026-09-26 drift install-parity.ts exists for: so the tree is removed first.
describe('each deploy runs on the install of its own tip', () => {
  test('a tip that changes a dependency is deployed on that dependency, installed from its own lock', async () => {
    const vendor = join(work, 'vendor');

    mkdirSync(vendor);
    writeFileSync(join(work, '.gitignore'), 'node_modules\n');
    // The fixture's parity, the same rule as the real script's for this tree: every installed package is one its
    // bun.lock names, at the version it names.
    mkdirSync(join(work, 'scripts'));
    writeFileSync(join(work, 'scripts', 'install-parity.ts'), [
      'import { existsSync, readdirSync } from "node:fs";',
      'const lock = await Bun.file("bun.lock").text();',
      'const installed = existsSync("node_modules") ? readdirSync("node_modules").filter((name) => !name.startsWith(".")) : [];',
      'const named = async (name) => lock.includes(`"${name}@./vendor/${name}-${(await Bun.file(`node_modules/${name}/package.json`).json()).version}.tgz"`);',
      'const ok = installed.includes("fixture-dep") && (await Promise.all(installed.map(named))).every(Boolean);',
      'process.exit(ok ? 0 : 1);',
    ].join('\n'));
    await git(work, 'add', '.gitignore', 'scripts');

    const first = await depend({ 'fixture-dep': await tarball(vendor, 'fixture-dep', '1.0.0'), 'fixture-extra': await tarball(vendor, 'fixture-extra', '1.0.0') }, 'fixture-dep 1.0.0, fixture-extra');
    const seen: string[] = [];

    const deploy = async (where: string): Promise<number> => {
      const dep = String(JSON.parse(readFileSync(join(where, 'node_modules', 'fixture-dep', 'package.json'), 'utf8')).version);

      seen.push(`${await git(where, 'rev-parse', 'HEAD')} on fixture-dep ${dep}${existsSync(join(where, 'node_modules', 'fixture-extra')) ? ' and fixture-extra' : ''}`);

      return 0;
    };

    // The first deploy finds no install at all; the second, the first tip's, whose fixture-extra the second dropped.
    await runLoop({ branch: BRANCH, worktree, stateFile, prepare: prepareInstall, deploy, waitForDeploys: () => {} });

    const second = await depend({ 'fixture-dep': await tarball(vendor, 'fixture-dep', '2.0.0') }, 'fixture-dep 2.0.0, no fixture-extra');

    await runLoop({ branch: BRANCH, worktree, stateFile, prepare: prepareInstall, deploy, waitForDeploys: () => {} });
    expect(seen).toEqual([`${first} on fixture-dep 1.0.0 and fixture-extra`, `${second} on fixture-dep 2.0.0`]);
  });
});
