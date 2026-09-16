/**
 * The CLI's own tree, replaced without a moment where it is missing.
 *
 * Under `$KINU_HOME/cli`: `current` is what the launcher runs; `prev` is the
 * tree `current` replaced, kept for one launch so the launcher can restore it
 * when `current` fails its `--version` smoke; `next-<stamp>` is a tree being
 * staged. A staged tree is verified where it stands — every download against
 * its published checksum, then its own `cli.js --version` against the served
 * stamp — and only then swapped in with two renames. Nothing here touches the
 * launcher script: background code rewriting the shell that is interpreting it
 * is how half-swapped launchers happen, so `bin/kinu` stays `kinu update`'s.
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

/** The one lock every writer of `cli/` takes — this refresh, another child
 *  the same probe window started, and the launcher's own refresh — as a
 *  directory, which `mkdir` creates atomically or refuses. The holder's pid
 *  sits inside so a lock a dead process left is taken over, not waited on. */
const CLI_LOCK = join(CLI_ROOT, '.lock');

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface RefreshSeams {
  fetchImpl?: FetchLike;
}

/** A stamp as a directory name: `0.2.0+abc1234` → `next-0.2.0-abc1234`. */
function stagedDirFor(served: string): string {
  return join(CLI_ROOT, `${STAGED_PREFIX}${served.replace(/[^A-Za-z0-9.-]/g, '-')}`);
}

/**
 * The published artifact for the running machine, or a refusal for a platform
 * no artifact is built for. Same words the daemon's HELLO uses, so the hub and
 * the CLI name a platform identically.
 */
function platformArtifactPath(): string {
  const artifact = cliArtifactPath(process.platform, process.arch);

  if (artifact === null) throw new KinuError('unsupported', `no Kinu CLI build is published for ${process.platform}-${process.arch}`);

  return artifact;
}

/**
 * Download one published artifact and prove it whole against the checksum
 * published beside it. The checksum is the integrity anchor exactly as it is
 * for the launcher: an incomplete deploy answers a download path with the SPA
 * shell, and unpacking an HTML page as a tarball fails without saying why.
 */
/**
 * The served build's signed manifest, verified against the pinned key: the
 * one authority for which bytes are Kinu's. Refused — nothing downloaded —
 * when the manifest carries no signature, one that does not verify, or one
 * that does not cover the artifact asked for (SECURITY-devices C1).
 */
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

/** Download one published artifact and prove it whole against the SIGNED
 *  checksum — the manifest's, never the origin's own `.sha256` file, which
 *  the origin chooses. */
async function fetchVerified(origin: string, pathname: string, into: string, release: SignedRelease, fetchImpl: FetchLike): Promise<void> {
  const expected = release.checksums[pathname];

  if (expected === undefined) throw new KinuError('denied', `the signed release names no ${pathname}; nothing is downloaded`);
  const res = await fetchImpl(`${origin}${pathname}`, { cache: 'no-store' });

  if (!res.ok) throw new KinuError('unavailable', `could not download ${pathname}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');

  if (actual !== expected.toLowerCase()) throw new KinuError('io', `checksum mismatch for ${pathname}`);
  writeFileSync(into, bytes);
}

/** One child process, run to completion: its stdout, or the failure with the
 *  child's own stderr in the message. */
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

/** The staged tree's own answer to `--version`, run from that tree. */
function stagedVersion(tree: string): Promise<string> {
  return runToCompletion('launching the staged Kinu build', process.execPath, [join(tree, 'cli.js'), '--version'], tree);
}

/**
 * Stage the served build into `cli/next-<stamp>` and prove it: the release
 * manifest's signature verified against the pinned key, both archives
 * verified against the checksums it signed, unpacked over one tree, and that tree's
 * `cli.js --version` equal to the stamp the origin published. A failed stage
 * leaves nothing behind but `current`, byte for byte as it was.
 */
async function stageServedBuild(origin: string, served: string, seams: RefreshSeams): Promise<string> {
  const fetchImpl = seams.fetchImpl ?? fetch;
  const next = stagedDirFor(served);
  const work = `${next}.download`;
  rmSync(next, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  try {
    // The signed manifest first, before any download: a refused signature
    // costs one small read and lands nothing.
    const release = await signedRelease(origin, served, fetchImpl);
    await fetchVerified(origin, platformArtifactPath(), join(work, 'cli.tar.gz'), release, fetchImpl);
    await fetchVerified(origin, CLI_RUNTIME_PATH, join(work, 'runtime.tar.gz'), release, fetchImpl);
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
 * Make a staged tree the current one. The last-known-good `prev` is kept
 * until the new tree is in place: `prev → prev.old`, `current → prev`,
 * `next → current`, then `prev.old` goes. A crash between any two lines
 * leaves a runnable tree for the launcher to find — a proven `next-*` when
 * `current` is missing, else `prev` — which is what its launch check
 * recovers from without a download. `prev` is kept for one launch; the
 * launcher removes it after `current` answers `--version`, or restores it
 * when it does not.
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

/** The build `cli/current` answers for, or null when there is none or it
 *  does not launch — the re-check every refresh makes under the lock, so a
 *  second child of one probe window adopts nothing over the first's work. */
async function installedBuild(): Promise<string | null> {
  if (!existsSync(join(CLI_CURRENT, 'cli.js'))) return null;

  try {
    return await stagedVersion(CLI_CURRENT);
  } catch (cause) {
    if (cause instanceof KinuError) return null;
    throw cause;
  }
}

/** Take the `cli/` lock, or answer null when another live process holds it. */
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

    // The directory is there: a live holder keeps it; a holder that died
    // between its mkdir and its exit left it, and the lock is taken over.
    const holder = readLockHolder();

    if (holder !== null && processAlive(holder)) return null;
    rmSync(CLI_LOCK, { recursive: true, force: true });
  }

  return null;
}

/** The pid inside the lock, or null when no pid file is there — a holder
 *  that died between the mkdir and the write, or a lock nobody wrote into. */
function readLockHolder(): number | null {
  const text = tolerate(() => readFileSync(join(CLI_LOCK, 'pid'), 'utf-8'), 'enoent');

  if (text === undefined) return null;
  const pid = Number(text.trim());

  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function processAlive(pid: number): boolean {
  // `kill 0` answers ESRCH for a pid nobody holds. Any other refusal is a
  // process this user cannot signal in this user's own home, and propagates.
  return tolerate(() => {
    process.kill(pid, 0);

    return true;
  }, 'esrch') === true;
}

/**
 * A tree staged for `served` earlier that still answers `--version` with it —
 * what `kinu update` adopts without downloading again. Null when there is
 * none, or when the one there is does not answer for the served stamp.
 */
async function verifiedStagedBuild(served: string): Promise<string | null> {
  const next = stagedDirFor(served);

  if (!existsSync(join(next, 'cli.js'))) return null;

  try {
    if (isSameBuild(await stagedVersion(next), served)) return next;
  } catch (cause) {
    // A staged tree that cannot launch is not a build; it is removed below,
    // and the caller downloads a fresh one.
    if (!(cause instanceof KinuError)) throw cause;
  }

  rmSync(next, { recursive: true, force: true });

  return null;
}

/** Staged trees left by an interrupted refresh, removed before a new stage. */
function sweepStagedBuilds(keep: string | null): void {
  if (!existsSync(CLI_ROOT)) return;

  for (const entry of readdirSync(CLI_ROOT)) {
    const tree = join(CLI_ROOT, entry);

    if (entry.startsWith(STAGED_PREFIX) && tree !== keep) rmSync(tree, { recursive: true, force: true });
  }
}

/**
 * Install the served build as `cli/current`: adopt a verified staged tree, or
 * stage one and adopt it. Resolves once the swap is on disk; the running
 * process keeps its own bundle, and the next launch runs the new one.
 */
export async function refreshCliTree(origin: string, served: string, seams: RefreshSeams = {}): Promise<void> {
  mkdirSync(CLI_ROOT, { recursive: true });
  const release = takeCliLock();

  // Another live refresh holds `cli/`: it lands the same served build, or a
  // newer probe's. This one has nothing to add and exits without a word — the
  // startup throttle is read-then-fetch-then-write, so two commands inside
  // one probe window both spawn a child.
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

/**
 * The refresh as the startup check runs it: a detached child of this CLI that
 * stages and swaps on its own, so a command that has already printed its
 * answer exits without waiting for a download. The child is `kinu update
 * --background` on this very entry file — the one bundle known to run here.
 */
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
