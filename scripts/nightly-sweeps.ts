#!/usr/bin/env bun
/**
 * The nightly sweeps, on armada at one commit. Each needs no credential and no model, so each is an `armada map` over
 * its parts, every part a medium container of the commit's own environment (.armada.json):
 *
 *   flakes  every suite the CI tier runs, three seeded runs under --randomize (`bun run sweep:flakes`, scripts/flake-gate.ts)
 *   bench   every bench task's defect must break this repository's checks and its reverse restore them (`bench.ts validate`)
 *
 * They were GitHub workflows (flake-sweep.yml, bench.yml). Each part's report comes back as its armada output and is
 * kept under {@link REPORTS}. A red part makes the run exit 1; nothing retries or quarantines.
 *
 *   bun scripts/nightly-sweeps.ts run <rev> [flakes|bench]...   the named sweeps (default: both) at <rev>
 *   bun scripts/nightly-sweeps.ts install <branch>              a user timer that runs both at origin's <branch> each night
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'armada';

const ROOT = join(import.meta.dir, '..');

/** The dedicated checkout the timer runs from, and no one edits. */
export const WORKTREE = '/mnt/local/kinu/wt/nightly-sweeps';

/** Where each part's report is kept: `<rev>/<sweep>-<part>.tgz`. */
export const REPORTS = join(process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state'), 'kinu', 'nightly-sweeps');

export interface Sweep {
  readonly name: 'flakes' | 'bench';
  readonly parts: number;
  /** One part's command; `{item}` is its 1-based number, `{out}` the report it leaves. */
  readonly command: readonly string[];
  readonly timeoutSeconds: number;
}

/**
 * Parts sized to the medium container. flakes: the swept rows' walls add up to 29 minutes a pass, 86 for the three
 * (2026-09-26, the 24-thread box), so sixteen parts finish in minutes. bench: one task took 130 s (2026-09-23) and
 * twenty shards hold about eight tasks each.
 */
export const SWEEPS: readonly Sweep[] = [
  {
    name: 'flakes',
    parts: 16,
    command: ['sh', '-c', 'bun run sweep:flakes --shard={item}/16; status=$?; tar -czf {out} bench-artifacts/flake-sweep 2>/dev/null; exit $status'],
    timeoutSeconds: 3600,
  },
  {
    name: 'bench',
    parts: 20,
    command: ['sh', '-c', 'bun scripts/bench.ts validate --run-root "$(mktemp -d /tmp/kinu-bench-XXXXXX)" --shard {item}/20; '
      + 'status=$?; tar -czf {out} bench-artifacts 2>/dev/null; exit $status'],
    timeoutSeconds: 3600,
  },
];

/** The `armada map` argv of one sweep at `rev`; its parts arrive on stdin as a JSON array of their numbers. */
export function mapArgv(sweep: Sweep, rev: string): string[] {
  return [
    join(ROOT, 'node_modules', '.bin', 'armada'), 'map', `--commit=${rev}`, '--items=-', `--pool=${String(sweep.parts)}`,
    '--size=medium', `--timeout=${String(sweep.timeoutSeconds)}`, '--output', `--label=nightly ${sweep.name} ${rev}`,
    '--', ...sweep.command,
  ];
}

/** One sweep: its map's exit code (0 green, 1 a red part, 2 a part that could not run), its reports kept. */
async function runSweep(sweep: Sweep, rev: string): Promise<number> {
  const parts = Array.from({ length: sweep.parts }, (_, index) => index + 1);
  const map = Bun.spawn(mapArgv(sweep, rev), { cwd: ROOT, stdin: new Blob([JSON.stringify(parts)]), stdout: 'inherit', stderr: 'pipe' });
  let said = '';

  for await (const chunk of map.stderr) {
    const text = new TextDecoder().decode(chunk);

    said += text;
    process.stderr.write(text);
  }

  const code = await map.exited;
  const job = /^job (\S+)$/mu.exec(said)?.[1];

  if (job === undefined) return code === 0 ? 2 : code;
  const directory = join(REPORTS, rev);

  mkdirSync(directory, { recursive: true });

  for (const index of parts.keys()) {
    const report = await connect().output(job, index);

    if (report !== null) writeFileSync(join(directory, `${sweep.name}-${String(index + 1)}.tgz`), report);
  }

  console.log(`nightly-sweeps: ${sweep.name} at ${rev}, job ${job}: exit ${String(code)}; reports in ${directory}`);

  return code;
}

/** A systemd unit: its file name under ~/.config/systemd/user, and its text. */
export interface SweepUnit {
  readonly name: string;
  readonly text: string;
}

/** The timer and the service it starts. */
export interface SweepUnits {
  readonly timer: SweepUnit;
  readonly service: SweepUnit;
}

/** The two units, written for this machine's PATH and scratch: the timer starts the service at 07:30 UTC. */
export function sweepUnits(): SweepUnits {
  return {
    timer: { name: 'kinu-nightly-sweeps@.timer', text: [
      '[Unit]',
      'Description=The nightly sweeps of origin\'s %I on armada (scripts/nightly-sweeps.ts)',
      '',
      '[Timer]',
      'OnCalendar=*-*-* 07:30:00 UTC',
      'Persistent=true',
      'Unit=kinu-nightly-sweeps@%i.service',
      '',
      '[Install]',
      'WantedBy=timers.target',
      '',
    ].join('\n') },
    service: { name: 'kinu-nightly-sweeps@.service', text: [
      '[Unit]',
      'Description=The nightly sweeps of origin\'s %I on armada (scripts/nightly-sweeps.ts)',
      '',
      '[Service]',
      'Type=oneshot',
      'TimeoutStartSec=infinity',
      `WorkingDirectory=${WORKTREE}`,
      `Environment=PATH=${process.env['PATH'] ?? ''}`,
      `Environment=TMPDIR=${process.env['TMPDIR'] ?? '/tmp'}`,
      'ExecStartPre=/usr/bin/git fetch --quiet origin %I',
      'ExecStartPre=/usr/bin/git checkout --quiet --detach FETCH_HEAD',
      `ExecStartPre=${process.execPath} install --frozen-lockfile`,
      `ExecStart=${process.execPath} ${WORKTREE}/scripts/nightly-sweeps.ts run FETCH_HEAD`,
      'Slice=kinu-lanes.slice',
      'MemoryMax=4G',
      '',
    ].join('\n') },
  };
}

function install(branch: string): void {
  const git = (argv: readonly string[]): void => {
    const run = Bun.spawnSync(['git', ...argv], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });

    if (run.exitCode !== 0) throw new Error(`git ${argv.join(' ')} failed: ${run.stderr.toString().trim()}`);
  };

  git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);

  if (!existsSync(WORKTREE)) git(['worktree', 'add', '--quiet', '--detach', WORKTREE, `refs/remotes/origin/${branch}`]);
  const directory = join(homedir(), '.config', 'systemd', 'user');

  mkdirSync(directory, { recursive: true });

  for (const unit of Object.values(sweepUnits())) writeFileSync(join(directory, unit.name), unit.text);
  const instance = branch.replaceAll('/', '-');

  for (const argv of [['daemon-reload'], ['enable', '--now', `kinu-nightly-sweeps@${instance}.timer`]]) {
    const run = Bun.spawnSync(['systemctl', '--user', ...argv], { stdout: 'pipe', stderr: 'pipe' });

    if (run.exitCode !== 0) throw new Error(`systemctl --user ${argv.join(' ')} failed: ${run.stderr.toString().trim()}`);
  }

  console.log(`nightly-sweeps: kinu-nightly-sweeps@${instance}.timer runs both sweeps at origin/${branch} each night from ${WORKTREE}`);
}

if (import.meta.main) {
  const [command, target, ...named] = process.argv.slice(2);
  const unknown = named.filter((name) => !SWEEPS.some((sweep) => sweep.name === name));

  if (target === undefined || (command !== 'run' && command !== 'install') || unknown.length > 0) {
    console.error('usage: bun scripts/nightly-sweeps.ts run <rev> [flakes|bench]... | install <branch>');
    process.exit(2);
  }

  if (command === 'install') {
    install(target);
  } else {
    // A full sha names the reports and the jobs, whatever ref was asked for.
    const sha = Bun.spawnSync(['git', 'rev-parse', '--verify', `${target}^{commit}`], { cwd: ROOT, stdout: 'pipe' }).stdout.toString().trim();
    let worst = sha === '' ? 2 : 0;

    for (const sweep of SWEEPS.filter((each) => named.length === 0 || named.includes(each.name))) {
      if (sha !== '') worst = Math.max(worst, await runSweep(sweep, sha));
    }

    process.exit(worst);
  }
}
