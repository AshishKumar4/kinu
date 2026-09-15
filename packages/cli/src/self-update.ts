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
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { CLI_RUNTIME_PATH, cliArtifactPath, isSameBuild } from '@kinu.run/core';
import { KinuError, toKinuError } from '@kinu.run/core/obs';
import { AGENT_HOME } from './config';

const CLI_ROOT = join(AGENT_HOME, 'cli');

export const CLI_CURRENT = join(CLI_ROOT, 'current');

const CLI_PREV = join(CLI_ROOT, 'prev');

const STAGED_PREFIX = 'next-';

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
async function fetchVerified(origin: string, pathname: string, into: string, fetchImpl: FetchLike): Promise<void> {
  const res = await fetchImpl(`${origin}${pathname}`, { cache: 'no-store' });

  if (!res.ok) throw new KinuError('unavailable', `could not download ${pathname}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const checksum = await fetchImpl(`${origin}${pathname}.sha256`, { cache: 'no-store' });

  if (!checksum.ok) throw new KinuError('unavailable', `could not download the checksum for ${pathname}: HTTP ${checksum.status}`);
  const expected = (await checksum.text()).trim().split(/\s+/)[0] ?? '';

  if (!/^[0-9a-f]{64}$/i.test(expected)) throw new KinuError('io', `the checksum published for ${pathname} is not a sha256`);
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
 * Stage the served build into `cli/next-<stamp>` and prove it: both archives
 * verified against their checksums, unpacked over one tree, and that tree's
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
    await fetchVerified(origin, platformArtifactPath(), join(work, 'cli.tar.gz'), fetchImpl);
    await fetchVerified(origin, CLI_RUNTIME_PATH, join(work, 'runtime.tar.gz'), fetchImpl);
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
 * Make a staged tree the current one: `current → prev`, `next → current`.
 * Two renames, nothing else — the one atomicity-sensitive step, and the same
 * order the daemon install uses. `prev` is kept for one launch; the launcher
 * removes it after `current` answers `--version`, or restores it when it does
 * not.
 */
function adoptStagedBuild(next: string): void {
  rmSync(CLI_PREV, { recursive: true, force: true });

  if (existsSync(CLI_CURRENT)) renameSync(CLI_CURRENT, CLI_PREV);
  renameSync(next, CLI_CURRENT);
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
  const staged = await verifiedStagedBuild(served);
  sweepStagedBuilds(staged);
  adoptStagedBuild(staged ?? await stageServedBuild(origin, served, seams));
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
