/**
 * The machine's device-daemon pidfile: the lock without which two daemons on one machine share one device.json, both
 * answer the hub, and each rotation invalidates the other's token. One protocol for both its writers, `kinu connect`
 * and the daemon itself (packages/pc-agent requires this leaf): Node builtins only, so the daemon's CommonJS build
 * carries it, and plain errors, each naming what it was doing.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** What the machine's pidfile answers a claim: held, or the live daemon that holds it. */
export interface MachineClaim {
  readonly held: boolean;
  readonly holder: number | null;
}

/** A caught error's `code` as text: an errno name, or `ps`'s exit status. */
function codeOf(err: Error): string | null {
  return 'code' in err && (typeof err.code === 'string' || typeof err.code === 'number') ? String(err.code) : null;
}

/** Whether `caught` failed with one of `codes`. */
function failedWith(caught: Error, ...codes: readonly string[]): boolean {
  const code = codeOf(caught);

  return code !== null && codes.includes(code);
}

/** The pid `text` names, or null when it names none. */
function pidIn(text: string): number | null {
  const pid = Number(text.trim());

  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** The pid the pidfile names, or null when there is none or it names nothing usable. */
export function readMachinePid(pidPath: string): number | null {
  try {
    return pidIn(readFileSync(pidPath, 'utf8'));
  } catch (err) {
    if (err instanceof Error && failedWith(err, 'ENOENT')) return null;
    throw new Error(`reading the device daemon pidfile at ${pidPath}`, { cause: err });
  }
}

/** Whether `pid` is a live process: `kill(pid, 0)` reports absence as ESRCH and presence under another user as EPERM. */
export function machineProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (err) {
    if (err instanceof Error && failedWith(err, 'ESRCH')) return false;

    if (err instanceof Error && failedWith(err, 'EPERM')) return true;
    throw new Error(`checking whether pid ${String(pid)} is running`, { cause: err });
  }
}

/** `/proc/<pid>/<file>`, or null when the process is gone: no entry, or reaped mid-read (ESRCH). */
function procRead(pid: number, file: string): string | null {
  try {
    return readFileSync(`/proc/${String(pid)}/${file}`, 'utf8');
  } catch (err) {
    if (err instanceof Error && failedWith(err, 'ENOENT', 'ESRCH')) return null;
    throw err;
  }
}

function psCommand(pid: number): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();

  execFile('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }, (err, stdout) => {
    if (err) reject(err);
    else resolve(stdout);
  });

  return promise;
}

/** `ps -p` exits 1 for no such process. */
const PS_NO_SUCH_PROCESS = '1';

/**
 * Whether `pid` runs the daemon at `daemonPath`. A pid the system recycled for another program holds nothing. The
 * command line names the file by whatever spelling its starter used, so any argument of the daemon file's own name
 * counts: another home's daemon that inherited the pid reads as the holder, and refusing to start is recoverable with
 * one `kinu connect`, where a second daemon beside the first is the defect the lock exists for.
 *
 * A process just spawned has an empty command line until its exec lands (empty right after `spawn` in 1,442 of 1,600
 * bun spawns, 2026-10-08), so an empty one that is no zombie is the daemon its starter just recorded; a zombie, an
 * exited daemon not yet reaped, is gone.
 */
export async function runsMachineDaemon(pid: number, daemonPath: string): Promise<boolean> {
  const named = (args: readonly string[]): boolean => args.some((arg) => arg === daemonPath || basename(arg) === basename(daemonPath));

  try {
    if (process.platform === 'linux') {
      const args = procRead(pid, 'cmdline');

      if (args === null) return false;

      if (args !== '') return named(args.split('\0'));
      const stat = procRead(pid, 'stat') ?? '';
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);

      return state !== '' && state !== 'Z';
    }

    if (process.platform === 'darwin') return named((await psCommand(pid)).trim().split(/\s+/u));

    return false;
  } catch (err) {
    if (err instanceof Error && failedWith(err, 'EACCES', 'EPERM')) return false;

    if (process.platform === 'darwin' && err instanceof Error && failedWith(err, PS_NO_SUCH_PROCESS)) return false;
    throw new Error(`checking whether pid ${String(pid)} runs the device daemon`, { cause: err });
  }
}

/** The live daemon the pidfile names, or null: a pidfile naming a gone process, or another program, names none. */
export async function runningMachineDaemon(pidPath: string, daemonPath: string): Promise<number | null> {
  const pid = readMachinePid(pidPath);

  return pid !== null && machineProcessAlive(pid) && await runsMachineDaemon(pid, daemonPath) ? pid : null;
}

/**
 * Publishes `pid` as the machine's daemon, or answers false when a pidfile is already there. The pidfile appears whole
 * or not at all: the pid is written to a file of its own under `<pidfile>.claims`, synced, and linked into place, which
 * fails when one exists, and the directory is synced after. An exclusive create written afterwards left an empty
 * pidfile for a moment, which the other claimant read as stale and removed: two connects at once each claimed and
 * returned with two daemons running (4 in 360 runs of "concurrent connects leave one daemon owner", 2026-10-08).
 */
function publishMachinePid(pidPath: string, pid: number): boolean {
  const claims = `${pidPath}.claims`;
  const claim = join(claims, `${String(pid)}-${randomBytes(8).toString('hex')}`);

  try {
    mkdirSync(claims, { recursive: true, mode: 0o700 });
    const descriptor = openSync(claim, 'wx', 0o600);

    try {
      writeFileSync(descriptor, `${String(pid)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }

    try {
      linkSync(claim, pidPath);
    } catch (err) {
      if (err instanceof Error && failedWith(err, 'EEXIST')) return false;
      throw err;
    }

    syncDirectory(dirname(pidPath));

    return true;
  } catch (err) {
    throw new Error(`writing the device daemon pidfile at ${pidPath}`, { cause: err });
  } finally {
    rmSync(claim, { force: true });
  }
}

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const descriptor = openSync(directory, 'r');

  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Removes the pidfile only while it still names `pid` (null: one naming no pid). It is moved aside whole and read; one
 * naming another pid is a claim made since `pid` was read, and is linked back. A plain remove after the check removed
 * such a claim: a connect that waited for the old daemon to exit removed the claim another connect made meanwhile, and
 * both started a daemon (2026-10-08).
 */
export function removeMachinePid(pidPath: string, pid: number | null): void {
  const claims = `${pidPath}.claims`;
  const aside = join(claims, `aside-${String(process.pid)}-${randomBytes(8).toString('hex')}`);

  try {
    mkdirSync(claims, { recursive: true, mode: 0o700 });

    try {
      renameSync(pidPath, aside);
    } catch (err) {
      if (err instanceof Error && failedWith(err, 'ENOENT')) return;
      throw err;
    }

    if (pidIn(readFileSync(aside, 'utf8')) !== pid) {
      try {
        linkSync(aside, pidPath);
      } catch (err) {
        if (!(err instanceof Error && failedWith(err, 'EEXIST'))) throw err;
      }
    }

    rmSync(aside, { force: true });
  } catch (err) {
    throw new Error(`removing the device daemon pidfile at ${pidPath}`, { cause: err });
  }
}

/**
 * Takes the machine for `pid`, or reports the live daemon that holds it. A pidfile naming `pid` is this same claim (a
 * starter writes it for the daemon it spawned, and the daemon claims again). One naming a gone process, or another
 * program, is stale and removed; one naming a live daemon refuses, unless `takesOver` says this claim replaces it (a
 * successor its predecessor started).
 */
export async function claimMachine(
  pidPath: string,
  pid: number,
  daemonPath: string,
  takesOver: (holder: number) => boolean = () => false,
): Promise<MachineClaim> {
  // The second attempt follows a removed stale claim.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (publishMachinePid(pidPath, pid)) return { held: true, holder: pid };
    const holder = readMachinePid(pidPath);

    if (holder === pid) return { held: true, holder: pid };

    if (holder !== null && machineProcessAlive(holder) && await runsMachineDaemon(holder, daemonPath) && !takesOver(holder)) {
      return { held: false, holder };
    }

    removeMachinePid(pidPath, holder);
  }

  return { held: false, holder: readMachinePid(pidPath) };
}
