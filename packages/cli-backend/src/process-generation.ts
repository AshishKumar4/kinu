/**
 * Which run of a process a pid names: the one host reader the config lock, the agent lease, test cleanup
 * (test-utils `recordedIn`) and the scripts' process owners use. Host-only, so it stays out of the shared packages. Pids are reused, so a holder recorded by pid alone is "live" again the moment
 * an unrelated process gets its number; the generation tells one run from a later one given the same pid. Linux reads
 * `/proc/<pid>/stat` field 22 (start ticks since boot); Darwin hashes `/bin/ps -p <pid> -o lstart=` under `LC_ALL=C`
 * (no shell, no locale drift). Other systems read none.
 */
import { Cause, Effect } from 'effect';
import { classify, settleSync } from '@kinu.run/core/obs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type SupportedPlatform = 'linux' | 'darwin';

export type GenerationProbe =
  | { readonly state: 'read'; readonly identity: string }
  | { readonly state: 'absent' }
  | { readonly state: 'unreadable' };

export interface GenerationReader {
  readonly platform: SupportedPlatform;
  read(pid: number): GenerationProbe;
}

const ABSENT: GenerationProbe = { state: 'absent' };

const UNREADABLE: GenerationProbe = { state: 'unreadable' };

/** This host's reader; null on a system that has none. */
export function hostGenerationReader(): GenerationReader | null {
  if (process.platform === 'linux') return { platform: 'linux', read: (pid) => settleSync(linuxGeneration(pid)) };

  if (process.platform === 'darwin') return { platform: 'darwin', read: readDarwinGeneration };

  return null;
}

/** Field 22 is process start ticks since boot. */
function procStartTicks(stat: string): string | null {
  const close = stat.lastIndexOf(')');

  if (close === -1) return null;
  const startTicks = stat.slice(close + 2).split(' ')[19];

  return startTicks === undefined || !/^\d+$/u.test(startTicks) ? null : startTicks;
}

function darwinStartIdentity(lstart: string): string | null {
  const canonical = lstart.trim();

  return canonical === '' ? null : createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

function linuxGeneration(pid: number): Effect.Effect<GenerationProbe> {
  return Effect.catchCause(Effect.sync((): GenerationProbe => {
    const startTicks = procStartTicks(readFileSync(`/proc/${String(pid)}/stat`, 'utf8'));

    return startTicks === null ? UNREADABLE : { state: 'read', identity: startTicks };
  }), (failed) => Effect.succeed(classify({ cause: Cause.squash(failed) }) === 'enoent' ? ABSENT : UNREADABLE));
}

/** `ps` runs to its exit: 1 names a pid no process holds, and a `ps` that cannot run at all throws rather than guess
 *  whether its holder still runs. */
function readDarwinGeneration(pid: number): GenerationProbe {
  const ps = Bun.spawnSync({
    cmd: ['/bin/ps', '-p', String(pid), '-o', 'lstart='],
    env: { LC_ALL: 'C', LANG: 'C' },
    stdout: 'pipe',
    stderr: 'ignore',
  });

  if (ps.exitCode === 1) return ABSENT;

  if (ps.exitCode !== 0) return UNREADABLE;
  const identity = darwinStartIdentity(ps.stdout.toString());

  return identity === null ? UNREADABLE : { state: 'read', identity };
}
