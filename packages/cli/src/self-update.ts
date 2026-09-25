/**
 * Atomic replacement of `$KINU_HOME/cli`: `current` runs, `prev` is kept one launch for rollback, `next-<stamp>` is
 * staged and verified before two renames swap it in. Never touches `bin/kinu`, which belongs to `kinu update`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import {
  CLI_RUNTIME_PATH, CLI_VERSION_PATH, cliArtifactPath, isSameBuild,
  RELEASE_SIGNING_PUBLIC_KEY, RELEASE_SIGNING_PUBLIC_KEY_ENV, SignedReleaseSchema, verifyRelease, type SignedRelease,
} from '@kinu.run/core';
import * as v from 'valibot';
import { KinuError, toKinuError, tolerate } from '@kinu.run/core/obs';
import { AGENT_HOME } from './config';

const CLI_ROOT = join(AGENT_HOME, 'cli');

export const CLI_CURRENT = join(CLI_ROOT, 'current');

const CLI_PREV = join(CLI_ROOT, 'prev');

const STAGED_PREFIX = 'next-';

/** `mkdir`-atomic lock holding the pid, so a dead holder's lock is taken over. */
const CLI_LOCK = join(CLI_ROOT, '.lock');

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface RefreshSeams {
  fetchImpl?: FetchLike;
}

/** A stamp as a directory name: `0.2.0+abc1234` → `next-0.2.0-abc1234`. */
function stagedDirFor(served: string): string {
  return join(CLI_ROOT, `${STAGED_PREFIX}${served.replace(/[^A-Za-z0-9.-]/g, '-')}`);
}

/** Same platform words as the daemon's HELLO. */
function platformArtifactPath(): string {
  const artifact = cliArtifactPath(process.platform, process.arch);

  if (artifact === null) throw new KinuError('unsupported', `no Kinu CLI build is published for ${process.platform}-${process.arch}`);

  return artifact;
}

/** An incomplete deploy serves the SPA shell at download paths. */
/** Refused unless signed, valid, and covering the artifact (SECURITY-devices C1). */
async function signedRelease(origin: string, served: string, fetchImpl: FetchLike): Promise<SignedRelease> {
  const res = await fetchImpl(`${origin}${CLI_VERSION_PATH}`, { cache: 'no-store' });

  if (!res.ok) throw new KinuError('unavailable', `could not download the release manifest: HTTP ${res.status}`);
  const parsed = v.safeParse(SignedReleaseSchema, await res.json());

  if (!parsed.success) throw new KinuError('denied', 'the release manifest carries no signature; nothing is downloaded');

  if (!isSameBuild(parsed.output.version, served)) throw new KinuError('io', `the release manifest names ${parsed.output.version}, not the served ${served}`);
  const publicKey = process.env[RELEASE_SIGNING_PUBLIC_KEY_ENV] ?? RELEASE_SIGNING_PUBLIC_KEY;

  if (!await verifyRelease(parsed.output, publicKey)) throw new KinuError('denied', 'the release signature does not verify against the pinned key; nothing is downloaded');

  return parsed.output;
}

/** Verified against the signed manifest's checksum, never the origin's `.sha256`. */
interface VerifiedDownload {
  readonly origin: string;
  readonly pathname: string;
  readonly into: string;
  readonly release: SignedRelease;
  readonly fetchImpl: FetchLike;
}

async function fetchVerified({ origin, pathname, into, release, fetchImpl }: VerifiedDownload): Promise<void> {
  const expected = release.checksums[pathname];

  if (expected === undefined) throw new KinuError('denied', `the signed release names no ${pathname}; nothing is downloaded`);
  const res = await fetchImpl(`${origin}${pathname}`, { cache: 'no-store' });

  if (!res.ok) throw new KinuError('unavailable', `could not download ${pathname}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');

  if (actual !== expected.toLowerCase()) throw new KinuError('io', `checksum mismatch for ${pathname}`);
  writeFileSync(into, bytes);
}

function runToCompletion(doing: string, command: string, args: string[], cwd?: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(command, args, { cwd }, (cause, stdout, stderr) => {
    if (cause) reject(toKinuError({ doing: `${doing}: ${stderr.trim()}`, cause, otherwise: 'io' }));
    else resolve(stdout.trim());
  });

  return promise;
}

function extractTarball(archive: string, into: string): Promise<string> {
  return runToCompletion(`unpacking ${archive}`, 'tar', ['-xzf', archive, '-C', into]);
}

function stagedVersion(tree: string): Promise<string> {
  return runToCompletion('launching the staged Kinu build', process.execPath, [join(tree, 'cli.js'), '--version'], tree);
}

/** Failure leaves `current` untouched. */
async function stageServedBuild(origin: string, served: string, seams: RefreshSeams): Promise<string> {
  const fetchImpl = seams.fetchImpl ?? fetch;
  const next = stagedDirFor(served);
  const work = `${next}.download`;
  rmSync(next, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  try {
    // Verify the signed manifest before any download.
    const release = await signedRelease(origin, served, fetchImpl);
    await fetchVerified({ origin, pathname: platformArtifactPath(), into: join(work, 'cli.tar.gz'), release, fetchImpl });
    await fetchVerified({ origin, pathname: CLI_RUNTIME_PATH, into: join(work, 'runtime.tar.gz'), release, fetchImpl });
    mkdirSync(join(work, 'extract'));
    await extractTarball(join(work, 'cli.tar.gz'), join(work, 'extract'));
    await extractTarball(join(work, 'runtime.tar.gz'), join(work, 'extract'));

    if (!existsSync(join(work, 'extract', 'kinu', 'cli.js'))) throw new KinuError('io', 'the Kinu build archive carries no cli.js');
    renameSync(join(work, 'extract', 'kinu'), next);
    const reported = await stagedVersion(next);

    if (!isSameBuild(reported, served)) {
      throw new KinuError('io', `the staged Kinu build reports ${reported}, not the served ${served}`);
    }

    return next;
  } catch (cause) {
    rmSync(next, { recursive: true, force: true });
    throw cause;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Swap a staged tree in: `prev → prev.old`, `current → prev`, `next → current`, drop `prev.old`. A crash between
 * any two steps leaves a runnable tree; the launcher drops `prev` once `current` passes `--version`.
 */
function adoptStagedBuild(next: string): void {
  const retired = `${CLI_PREV}.old`;
  rmSync(retired, { recursive: true, force: true });

  if (existsSync(CLI_CURRENT)) {
    if (existsSync(CLI_PREV)) renameSync(CLI_PREV, retired);
    renameSync(CLI_CURRENT, CLI_PREV);
  }

  renameSync(next, CLI_CURRENT);
  rmSync(retired, { recursive: true, force: true });
}

/** Re-checked under the lock so a second child adopts nothing over the first. */
async function installedBuild(): Promise<string | null> {
  if (!existsSync(join(CLI_CURRENT, 'cli.js'))) return null;

  try {
    return await stagedVersion(CLI_CURRENT);
  } catch (cause) {
    if (cause instanceof KinuError) return null;
    throw cause;
  }
}

function takeCliLock(): (() => void) | null {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const taken = tolerate(() => {
      mkdirSync(CLI_LOCK);

      return true;
    }, 'eexist');

    if (taken === true) {
      writeFileSync(join(CLI_LOCK, 'pid'), `${String(process.pid)}\n`);

      return () => { rmSync(CLI_LOCK, { recursive: true, force: true }); };
    }

    // A dead holder's lock is taken over.
    const holder = readLockHolder();

    if (holder !== null && processAlive(holder)) return null;
    rmSync(CLI_LOCK, { recursive: true, force: true });
  }

  return null;
}

function readLockHolder(): number | null {
  const text = tolerate(() => readFileSync(join(CLI_LOCK, 'pid'), 'utf-8'), 'enoent');

  if (text === undefined) return null;
  const pid = Number(text.trim());

  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function processAlive(pid: number): boolean {
  // ESRCH: no such pid. Any other refusal propagates.
  return tolerate(() => {
    process.kill(pid, 0);

    return true;
  }, 'esrch') === true;
}

async function verifiedStagedBuild(served: string): Promise<string | null> {
  const next = stagedDirFor(served);

  if (!existsSync(join(next, 'cli.js'))) return null;

  try {
    if (isSameBuild(await stagedVersion(next), served)) return next;
  } catch (cause) {
    if (!(cause instanceof KinuError)) throw cause;
  }

  rmSync(next, { recursive: true, force: true });

  return null;
}

function sweepStagedBuilds(keep: string | null): void {
  if (!existsSync(CLI_ROOT)) return;

  for (const entry of readdirSync(CLI_ROOT)) {
    const tree = join(CLI_ROOT, entry);

    if (entry.startsWith(STAGED_PREFIX) && tree !== keep) rmSync(tree, { recursive: true, force: true });
  }
}

/** The running process keeps its bundle; the next launch runs the new one. */
export async function refreshCliTree(origin: string, served: string, seams: RefreshSeams = {}): Promise<void> {
  mkdirSync(CLI_ROOT, { recursive: true });
  const release = takeCliLock();

  // Another live refresh holds `cli/` and lands the same or a newer build.
  if (release === null) return;

  try {
    const installed = await installedBuild();

    if (installed !== null && isSameBuild(installed, served)) return;
    const staged = await verifiedStagedBuild(served);
    sweepStagedBuilds(staged);
    adoptStagedBuild(staged ?? await stageServedBuild(origin, served, seams));
  } finally {
    release();
  }
}

/** Detached, so a command exits without waiting for a download. */
export function spawnBackgroundRefresh(): void {
  const entry = process.argv[1];

  if (entry === undefined) throw new KinuError('unsupported', 'the CLI entry file is unknown, so no background refresh can start');

  const child = spawn(process.execPath, [entry, 'update', '--background'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, KINU_HOME: AGENT_HOME },
  });

  child.unref();
}
