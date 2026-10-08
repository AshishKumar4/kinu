#!/usr/bin/env bun
/**
 * CONTINUOUS STAGING (L21). A staging deploy starts whenever the release branch moves on origin and no staging deploy
 * is running. The newest tip wins: a tip that a newer one passed while a deploy ran is dropped, never deployed.
 *
 * systemd runs it, from units {@link install} writes: `kinu-staging@<branch>.path` watches the branch's
 * remote-tracking ref, which moves when the release is pushed, and starts `kinu-staging@<branch>.service`, a oneshot
 * that runs `run` from the dedicated worktree {@link WORKTREE}, with the deploy's credentials from {@link SECRETS_FILE}.
 * Each round reads the tip and stops once it is the last tip deployed; otherwise it moves the worktree to the tip,
 * cleans it, and deploys it (scripts/deploy.sh, which takes the environment's deploy lock). A deploy refused because
 * another staging deploy holds that lock is no deploy: the round waits for the lock, then reads the tip again. systemd
 * starts the service once more when the ref moved during a run (measured 2026-10-01: pushes during one run started
 * exactly one more), and each round's own read covers the rest.
 *
 * AUTO-PROMOTION. Production takes whichever build staging verified, through `deploy.sh --promote`, the one path:
 * `kinu-promote@<branch>.timer` starts `promote` every 15 minutes from {@link PROMOTE_WORKTREE}, with production's
 * credentials from {@link SECRETS_FILE}. A round takes the last tip continuous staging deployed and leaves it
 * when production serves it already or it was tried before; otherwise it runs `promote.ts check` at that tip, which
 * refuses until staging's record and the evals' green Verdict are both there, and only then promotes. A promotion
 * that goes red is never tried again: no rollback is automatic, the report and its rollback hint stand, and the next
 * verified tip deploys forward (decided with Main, 2026-10-01).
 *
 *   bun scripts/staging-loop.ts run <branch>        one staging service run
 *   bun scripts/staging-loop.ts promote <branch>    one promotion round
 *   bun scripts/staging-loop.ts install <branch>    both worktrees and the four units, the path unit and the timer enabled
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as v from 'valibot';

/** The dedicated checkout continuous staging deploys from, and no one edits. */
export const WORKTREE = '/mnt/local/kinu/wt/staging-loop';

/** The dedicated checkout auto-promotion promotes from, and no one edits. */
export const PROMOTE_WORKTREE = '/mnt/local/kinu/wt/promote-loop';

/** The operator's secrets, staging's and production's deploy credentials among them, as `KEY=value` lines; mode 600. */
export const SECRETS_FILE = join(homedir(), '.config', 'kinu', 'secrets.env');

/** What scripts/deploy.sh exits with when another deploy of the environment holds its lock: nothing ran. */
export const DEPLOY_BUSY = 75;

function git(cwd: string, args: readonly string[]): string {
  const run = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });

  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr.toString().trim()}`);

  return run.stdout.toString().trim();
}

/** Every `node_modules` tree of `worktree`: the root's and each workspace's, none inside another. */
function nodeModulesTrees(worktree: string): string[] {
  const found = Bun.spawnSync(
    ['find', worktree, '-path', join(worktree, '.git'), '-prune', '-o', '-name', 'node_modules', '-type', 'd', '-prune', '-print'],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  if (found.exitCode !== 0) throw new Error(`find failed in ${worktree}: ${found.stderr.toString().trim()}`);

  return found.stdout.toString().split('\n').filter((tree) => tree !== '');
}

function holdsInstallParity(worktree: string): boolean {
  return Bun.spawnSync(['bun', 'scripts/install-parity.ts'], { cwd: worktree, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }).exitCode === 0;
}

/**
 * The worktree's packages as the bun.lock of its revision names them, before anything runs on them. A checkout moves
 * the revision and leaves `node_modules`, which deploy.sh installs only when it is absent, so a tip that changes the
 * lock would deploy on the last tip's install. Kept when `scripts/install-parity.ts` holds; otherwise every
 * `node_modules` tree is removed and installed afresh from the frozen lock, the way a linked worktree is installed by
 * hand, and parity is then required: nothing runs on another revision's install.
 */
export function prepareInstall(worktree: string): void {
  if (holdsInstallParity(worktree)) return;

  for (const tree of nodeModulesTrees(worktree)) rmSync(tree, { recursive: true, force: true });

  const installed = Bun.spawnSync(['bun', 'install', '--frozen-lockfile'], { cwd: worktree, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });

  if (installed.exitCode !== 0) throw new Error(`bun install --frozen-lockfile failed in ${worktree}; nothing was deployed`);

  if (!holdsInstallParity(worktree)) throw new Error(`install parity does not hold in ${worktree} after a clean install; nothing was deployed`);
}

export interface LoopInput {
  readonly branch: string;
  /** Where `refs/remotes/origin/<branch>` is read: the worktree shares the repository's refs. */
  readonly worktree: string;
  /** Makes the worktree's packages its revision's: {@link prepareInstall}. */
  readonly prepare: (worktree: string) => void;
  /** The last tip deployed, kept between runs. */
  readonly stateFile: string;
  /** Runs the deploy in `worktree` and answers its exit status. */
  readonly deploy: (worktree: string) => number;
  /** Returns once no deploy of the environment holds its lock. */
  readonly waitForDeploys: () => void;
}

function readState(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
}

function writeState(file: string, tip: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${tip}\n`);
}

/** The worktree at `tip`, clean but for the installed packages, which a deploy's frozen install reconciles, and the
 *  deploy reports, whose differential reads the previous one. */
function checkout(worktree: string, tip: string): void {
  git(worktree, ['checkout', '--quiet', '--detach', '--force', tip]);
  git(worktree, ['clean', '-ffdxq', '-e', 'node_modules', '-e', 'bench-artifacts']);
}

/** Deploys the newest tip until the last one deployed is the tip; answers the tips it deployed, in order. */
export function runLoop(input: LoopInput): string[] {
  const deployed: string[] = [];

  for (;;) {
    const tip = git(input.worktree, ['rev-parse', `refs/remotes/origin/${input.branch}`]);

    if (tip === readState(input.stateFile)) return deployed;
    checkout(input.worktree, tip);
    input.prepare(input.worktree);
    console.log(`staging-loop: deploying ${tip} of origin/${input.branch}`);

    if (input.deploy(input.worktree) === DEPLOY_BUSY) {
      console.log('staging-loop: another staging deploy is running; waiting for it, then reading the tip again');
      input.waitForDeploys();
      continue;
    }

    // Recorded once the deploy has run, red or green: a tip is deployed once, and a red one waits for the next.
    writeState(input.stateFile, tip);
    deployed.push(tip);
  }
}

export interface PromoteInput {
  /** The last tip continuous staging deployed: its state file. */
  readonly stagedFile: string;
  /** The last tip a round tried to promote, kept between rounds. */
  readonly triedFile: string;
  readonly worktree: string;
  /** Makes the worktree's packages its revision's: {@link prepareInstall}. */
  readonly prepare: (worktree: string) => void;
  /** The build sha production serves, as its `/api/health` names it; empty when it names none. */
  readonly productionBuild: () => Promise<string>;
  /** `promote.ts check` in `worktree`: 0 once staging's record and the evals' green Verdict are both there. */
  readonly verified: (worktree: string) => number;
  /** `deploy.sh --promote` in `worktree`, and its exit status. */
  readonly promote: (worktree: string) => number;
}

/** One round: the last staged tip promoted, once verified and if never tried; answers what the round did. */
export async function promoteRound(input: PromoteInput): Promise<string> {
  const staged = readState(input.stagedFile);

  if (staged === '') return 'nothing staged yet';

  if (staged === readState(input.triedFile)) return `${staged} was tried already`;
  const serving = await input.productionBuild();

  if (serving !== '' && staged.startsWith(serving)) return `production serves ${staged} already`;
  checkout(input.worktree, staged);
  input.prepare(input.worktree);

  if (input.verified(input.worktree) !== 0) return `${staged} is not verified yet`;
  const status = input.promote(input.worktree);

  if (status === DEPLOY_BUSY) return 'another production deploy is running';
  // Never tried again, red or green: a red one stays as its report left it, and the next verified tip deploys forward.
  writeState(input.triedFile, staged);

  return status === 0 ? `promoted ${staged}` : `promoting ${staged} went red (exit ${String(status)}); it is not tried again`;
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

/** A oneshot service of this machine: its worktree, credentials, PATH and scratch, in the deploy slice. */
function serviceUnit({ description, worktree, envFile, command, extra }: {
  readonly description: string; readonly worktree: string; readonly envFile: string; readonly command: string; readonly extra: readonly string[];
}): string {
  return [
    '[Unit]',
    `Description=${description}`,
    '',
    '[Service]',
    'Type=oneshot',
    'TimeoutStartSec=infinity',
    `WorkingDirectory=${worktree}`,
    `EnvironmentFile=${envFile}`,
    `Environment=PATH=${process.env['PATH'] ?? ''}`,
    `Environment=TMPDIR=${process.env['TMPDIR'] ?? '/tmp'}`,
    ...extra,
    // The script's own packages, before it loads: a fresh worktree has none until a deploy installs them.
    `ExecStartPre=${process.execPath} install --frozen-lockfile`,
    `ExecStart=${process.execPath} ${worktree}/scripts/staging-loop.ts ${command} %I`,
    'Slice=kinu-deploy.slice',
    'MemoryMax=28G',
    '',
  ].join('\n');
}

/** The four units, written for this machine: its repository, production's origin, its PATH and scratch. */
export function loopUnits(common: string, productionOrigin: string) {
  return {
    'kinu-staging@.path': [
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
    'kinu-staging@.service': serviceUnit({
      description: 'Continuous staging of origin\'s %I, the newest tip each round (scripts/staging-loop.ts)',
      worktree: WORKTREE, envFile: SECRETS_FILE, command: 'run', extra: [],
    }),
    'kinu-promote@.timer': [
      '[Unit]',
      'Description=Auto-promotion: the last staged tip of origin\'s %I, once verified (scripts/staging-loop.ts)',
      '',
      '[Timer]',
      'OnCalendar=*:0/15',
      'Unit=kinu-promote@%i.service',
      '',
      '[Install]',
      'WantedBy=timers.target',
      '',
    ].join('\n'),
    'kinu-promote@.service': serviceUnit({
      description: 'Auto-promotion round for origin\'s %I (scripts/staging-loop.ts)',
      worktree: PROMOTE_WORKTREE, envFile: SECRETS_FILE, command: 'promote', extra: [`Environment=KINU_PRODUCTION_ORIGIN=${productionOrigin}`],
    }),
  };
}

/** Both worktrees and the four units, the path unit and the timer enabled: from then on each push of `branch` deploys
 *  its tip to staging, and each verified one is promoted. */
async function install(branch: string): Promise<void> {
  if (!existsSync(SECRETS_FILE)) throw new Error(`${SECRETS_FILE} does not exist: write the deploy's credentials there (mode 600), then install`);

  const root = new URL('..', import.meta.url).pathname;
  const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  // Read off the manifest, not restated: the origin a promotion round asks which build production serves.
  const { deployedConfig } = await import('./infra-manifest');
  const production = deployedConfig('production').vars?.CLI_PUBLIC_ORIGIN ?? '';

  git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);

  for (const worktree of [WORKTREE, PROMOTE_WORKTREE]) {
    if (!existsSync(worktree)) git(root, ['worktree', 'add', '--quiet', '--detach', worktree, `refs/remotes/origin/${branch}`]);
  }

  const directory = join(homedir(), '.config', 'systemd', 'user');

  mkdirSync(directory, { recursive: true });

  for (const [name, text] of Object.entries(loopUnits(common, production))) writeFileSync(join(directory, name), text);
  const instance = instanceOf(branch);

  for (const argv of [['daemon-reload'], ['enable', '--now', `kinu-staging@${instance}.path`, `kinu-promote@${instance}.timer`]]) {
    const run = Bun.spawnSync(['systemctl', '--user', ...argv], { stdout: 'pipe', stderr: 'pipe' });

    if (run.exitCode !== 0) throw new Error(`systemctl --user ${argv.join(' ')} failed: ${run.stderr.toString().trim()}`);
  }

  console.log(`staging-loop: kinu-staging@${instance}.path watches ${common}/refs/remotes/origin/${branch} and deploys from ${WORKTREE}; `
    + `kinu-promote@${instance}.timer promotes from ${PROMOTE_WORKTREE} every 15 minutes`);
}

/** The state file of `loop` for `branch`. */
function stateOf(loop: 'staging-loop' | 'promote-loop', branch: string): string {
  return join(process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state'), 'kinu', loop, instanceOf(branch));
}

/** What /api/health says of the build: a reset placeholder's names none. */
const HealthSchema = v.looseObject({ build: v.nullish(v.looseObject({ sha: v.pipe(v.string(), v.regex(/^[0-9a-f]{7,40}$/u)) })) });

/** The build sha `origin` serves, as its /api/health names it, or empty. */
async function servedBuild(origin: string): Promise<string> {
  const answer = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(30_000) });

  if (!answer.ok) return '';
  const health = v.safeParse(HealthSchema, await answer.json());

  return health.success ? health.output.build?.sha ?? '' : '';
}

/** A command in `worktree`, its output passed on, and its exit status. */
function inWorktree(worktree: string, argv: readonly string[]): number {
  return Bun.spawnSync([...argv], { cwd: worktree, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }).exitCode;
}

if (import.meta.main) {
  const [command, branch] = process.argv.slice(2);

  if (branch === undefined || (command !== 'run' && command !== 'promote' && command !== 'install')) {
    console.error('usage: bun scripts/staging-loop.ts run <branch> | promote <branch> | install <branch>');
    process.exit(2);
  }

  const worktree = new URL('..', import.meta.url).pathname.replace(/\/$/u, '');

  if (command === 'install') {
    await install(branch);
  } else if (command === 'promote') {
    console.log(`promote-loop: ${await promoteRound({
      stagedFile: stateOf('staging-loop', branch),
      triedFile: stateOf('promote-loop', branch),
      worktree,
      productionBuild: () => servedBuild(process.env['KINU_PRODUCTION_ORIGIN'] ?? ''),
      prepare: prepareInstall,
      verified: (where) => inWorktree(where, ['bun', 'scripts/promote.ts', 'check']),
      promote: (where) => inWorktree(where, ['bash', 'scripts/deploy.sh', '--promote']),
    })}`);
  } else {
    const deployed = runLoop({
      branch,
      worktree,
      stateFile: stateOf('staging-loop', branch),
      prepare: prepareInstall,
      deploy: (where) => inWorktree(where, ['bash', 'scripts/deploy.sh']),
      waitForDeploys: () => {
        Bun.spawnSync(['flock', deployLock('staging'), 'true']);
      },
    });

    console.log(`staging-loop: ${deployed.length === 0 ? 'origin\'s tip was deployed already' : `deployed ${deployed.join(', ')}`}`);
  }
}
