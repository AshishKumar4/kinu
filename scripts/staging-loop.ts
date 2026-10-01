#!/usr/bin/env bun
/**
 * CONTINUOUS STAGING (L21). A staging deploy starts whenever the release branch moves on origin and no staging deploy
 * is running. The newest tip wins: a tip that a newer one passed while a deploy ran is dropped, never deployed.
 *
 * systemd runs it, from units {@link install} writes: `kinu-staging@<branch>.path` watches the branch's
 * remote-tracking ref, which moves when the release is pushed, and starts `kinu-staging@<branch>.service`, a oneshot
 * that runs `run` from the dedicated worktree {@link WORKTREE}, with the deploy's credentials from {@link ENV_FILE}.
 * Each round reads the tip and stops once it is the last tip deployed; otherwise it moves the worktree to the tip,
 * cleans it, and deploys it (scripts/deploy.sh, which takes the environment's deploy lock). A deploy refused because
 * another staging deploy holds that lock is no deploy: the round waits for the lock, then reads the tip again. systemd
 * starts the service once more when the ref moved during a run (measured 2026-10-01: pushes during one run started
 * exactly one more), and each round's own read covers the rest.
 *
 *   bun scripts/staging-loop.ts run <branch>        one service run
 *   bun scripts/staging-loop.ts install <branch>    the worktree and both units, the path unit enabled
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** The dedicated checkout continuous staging deploys from, and no one edits. */
export const WORKTREE = '/mnt/scratch/kinu/wt/staging-loop';

/** The deploy's credentials, as `KEY=value` lines, written by whoever owns them; mode 600. */
export const ENV_FILE = join(homedir(), '.config', 'kinu', 'staging-deploy.env');

/** What scripts/deploy.sh exits with when another deploy of the environment holds its lock: nothing ran. */
export const DEPLOY_BUSY = 75;

function git(cwd: string, args: readonly string[]): string {
  const run = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });

  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr.toString().trim()}`);

  return run.stdout.toString().trim();
}

export interface LoopInput {
  readonly branch: string;
  /** Where `refs/remotes/origin/<branch>` is read: the worktree shares the repository's refs. */
  readonly worktree: string;
  /** The last tip deployed, kept between runs. */
  readonly stateFile: string;
  /** Runs the deploy in `worktree` and answers its exit status. */
  readonly deploy: (worktree: string) => number;
  /** Returns once no deploy of the environment holds its lock. */
  readonly waitForDeploys: () => void;
}

/** Deploys the newest tip until the last one deployed is the tip; answers the tips it deployed, in order. */
export function runLoop(input: LoopInput): string[] {
  const deployed: string[] = [];

  for (;;) {
    const tip = git(input.worktree, ['rev-parse', `refs/remotes/origin/${input.branch}`]);
    const last = existsSync(input.stateFile) ? readFileSync(input.stateFile, 'utf8').trim() : '';

    if (tip === last) return deployed;
    git(input.worktree, ['checkout', '--quiet', '--detach', '--force', tip]);
    // Clean, but for the installed packages, which the deploy's frozen install reconciles, and the deploy reports,
    // whose differential reads the previous one.
    git(input.worktree, ['clean', '-ffdxq', '-e', 'node_modules', '-e', 'bench-artifacts']);
    console.log(`staging-loop: deploying ${tip} of origin/${input.branch}`);

    if (input.deploy(input.worktree) === DEPLOY_BUSY) {
      console.log('staging-loop: another staging deploy is running; waiting for it, then reading the tip again');
      input.waitForDeploys();
      continue;
    }

    // Recorded once the deploy has run, red or green: a tip is deployed once, and a red one waits for the next.
    mkdirSync(dirname(input.stateFile), { recursive: true });
    writeFileSync(input.stateFile, `${tip}\n`);
    deployed.push(tip);
  }
}

/** The lock scripts/deploy.sh holds for a run of `environment`. */
function deployLock(environment: string): string {
  return join(process.env['XDG_RUNTIME_DIR'] ?? '/tmp', `kinu-deploy-${environment}.lock`);
}

/** systemd's name for `branch` as a unit instance: `integration/0965` is `integration-0965`. */
function instanceOf(branch: string): string {
  const escaped = Bun.spawnSync(['systemd-escape', branch], { stdout: 'pipe', stderr: 'pipe' });

  if (escaped.exitCode !== 0) throw new Error(`systemd-escape ${branch} failed: ${escaped.stderr.toString().trim()}`);

  return escaped.stdout.toString().trim();
}

/** The two units, written for this machine: its repository, its PATH and scratch, its deploy slice. */
export function stagingUnits(common: string) {
  return {
    path: [
      '[Unit]',
      'Description=Continuous staging: a deploy whenever origin\'s %I moves (scripts/staging-loop.ts)',
      '',
      '[Path]',
      `PathChanged=${common}/refs/remotes/origin/%I`,
      'Unit=kinu-staging@%i.service',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'),
    service: [
      '[Unit]',
      'Description=Continuous staging of origin\'s %I, the newest tip each round (scripts/staging-loop.ts)',
      '',
      '[Service]',
      'Type=oneshot',
      'TimeoutStartSec=infinity',
      `WorkingDirectory=${WORKTREE}`,
      `EnvironmentFile=${ENV_FILE}`,
      `Environment=PATH=${process.env['PATH'] ?? ''}`,
      `Environment=TMPDIR=${process.env['TMPDIR'] ?? '/tmp'}`,
      `ExecStart=${process.execPath} ${WORKTREE}/scripts/staging-loop.ts run %I`,
      'Slice=kinu-deploy.slice',
      'MemoryMax=28G',
      '',
    ].join('\n'),
  };
}

/** The worktree and both units, the path unit enabled: from then on each push of `branch` deploys its tip. */
function install(branch: string): void {
  if (!existsSync(ENV_FILE)) throw new Error(`${ENV_FILE} does not exist: write the deploy's credentials there (mode 600), then install`);
  const root = new URL('..', import.meta.url).pathname;
  const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);

  git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);

  if (!existsSync(WORKTREE)) git(root, ['worktree', 'add', '--quiet', '--detach', WORKTREE, `refs/remotes/origin/${branch}`]);
  const directory = join(homedir(), '.config', 'systemd', 'user');
  const written = stagingUnits(common);

  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'kinu-staging@.path'), written.path);
  writeFileSync(join(directory, 'kinu-staging@.service'), written.service);

  for (const argv of [['daemon-reload'], ['enable', '--now', `kinu-staging@${instanceOf(branch)}.path`]]) {
    const run = Bun.spawnSync(['systemctl', '--user', ...argv], { stdout: 'pipe', stderr: 'pipe' });

    if (run.exitCode !== 0) throw new Error(`systemctl --user ${argv.join(' ')} failed: ${run.stderr.toString().trim()}`);
  }

  console.log(`staging-loop: kinu-staging@${instanceOf(branch)}.path watches ${common}/refs/remotes/origin/${branch}; deploys run from ${WORKTREE}`);
}

if (import.meta.main) {
  const [command, branch] = process.argv.slice(2);

  if (branch === undefined || (command !== 'run' && command !== 'install')) {
    console.error('usage: bun scripts/staging-loop.ts run <branch> | install <branch>');
    process.exit(2);
  }

  if (command === 'install') {
    install(branch);
  } else {
    const worktree = new URL('..', import.meta.url).pathname.replace(/\/$/u, '');
    const state = process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state');

    const deployed = runLoop({
      branch,
      worktree,
      stateFile: join(state, 'kinu', 'staging-loop', instanceOf(branch)),
      deploy: (where) => Bun.spawnSync(['bash', 'scripts/deploy.sh'], { cwd: where, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }).exitCode,
      waitForDeploys: () => {
        Bun.spawnSync(['flock', deployLock('staging'), 'true']);
      },
    });

    console.log(`staging-loop: ${deployed.length === 0 ? 'origin\'s tip was deployed already' : `deployed ${deployed.join(', ')}`}`);
  }
}
