import { dirname, resolve } from 'node:path';

/** The one daemon instance: its binary, the tree it backs, and its control surface. */
export interface JournalDaemonPaths {
  readonly binary: string;
  readonly root: string;
  readonly mount: string;
  readonly state: string;
  readonly socket: string;
}

/**
 * The daemon's exact argv, shared by the in-container spawn and by a host that
 * supervises the daemon as a container process. Both must name one binary and
 * one path set, or a fence would answer for a different tree.
 */
export function journalDaemonArgv(options: JournalDaemonPaths): readonly string[] {
  const root = resolve(options.root);
  const mount = resolve(options.mount);
  const state = resolve(options.state);
  const socket = resolve(options.socket);
  if (dirname(socket) !== state) throw new Error('journal control socket must live directly in its private state directory');
  return [options.binary, '--root', root, '--mount', mount, '--state', state, '--socket', socket];
}

/**
 * How long the daemon has, inside the container, to present its control socket
 * and its mount.
 *
 * Five seconds rather than the two the host used to spend polling: the wait
 * itself got LONGER while the cost collapsed, because it is now spent in one
 * place instead of across forty round trips.
 */
export const JOURNAL_READY_WAIT_SECONDS = 5;

/** One shell word, whatever the path holds. */
function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** What one {@link journalReadyCommand} run saw. Two facts, because the daemon
 *  can present its control socket and still fail to mount, and a failure that
 *  cannot say which half is missing sends a reader to the daemon's logs for a
 *  question the probe already answered. */
export interface JournalReadyReading {
  readonly socket: boolean;
  readonly mount: boolean;
}

/**
 * ONE container command that waits for the journal daemon to start serving.
 *
 * MEASURED DEFECT THIS REPAIRS. The host used to ask this question forty times
 * — `JOURNAL_READY_ATTEMPTS` execs, one round trip out to the container each,
 * with a short sleep between them — and the loop was bounded by the ATTEMPT
 * COUNT, never by time. That is only a bound while every exec is fast, and the
 * one case this loop exists for is the case where they are not: an exec against
 * a container the platform is reclaiming retries inside the SDK for up to two
 * minutes apiece, so forty attempts is eighty minutes of waiting that reports
 * nothing and that no caller can distinguish from a hang. On the deployed
 * bounded-layers arm it presented as exactly that: probe `blp1` sat at
 * `running=true restoration=unstarted` for 300,771 ms with its attach pinned,
 * and run `e2ecal0901002202` recorded 900,001 ms on the same step.
 *
 * So the wait moves INSIDE the container, where a tick costs a sleep and two
 * syscalls instead of a network hop, and the whole probe costs ONE exec. The
 * bound is a wall deadline rather than an iteration count, so a container that
 * ticks slowly gets the same seconds as one that ticks fast. `date` counts
 * whole seconds, so the wait lands between `waitSeconds - 1` and `waitSeconds`;
 * sub-second accuracy would cost a `%N` this image is not promised to have, and
 * the question is "has the daemon come up", not "when exactly".
 *
 * IT ANSWERS ON STDOUT, NEVER THROUGH ITS EXIT STATUS, and it never says
 * `exit`: every command runs in the SDK's one persistent session shell, and a
 * command that ends it takes every later command with it. `echo` is the last
 * word, so a daemon that never came up is a reading rather than a refusal.
 *
 * A container whose `sleep` will not take a fraction degrades to a busy loop
 * for the deadline and answers correctly — the deadline is the bound, the
 * cadence is only politeness.
 */
export function journalReadyCommand(
  surface: Pick<JournalDaemonPaths, 'mount' | 'socket'>,
  waitSeconds: number = JOURNAL_READY_WAIT_SECONDS,
): string {
  const socket = shellWord(resolve(surface.socket));
  // `/proc/mounts` names the mount in field two and the type in field three, so
  // ` <mount> fuse` is the whole question. Fixed-string, because a path is not
  // a pattern.
  const mounted = `grep -qsF ${shellWord(` ${resolve(surface.mount)} fuse`)} /proc/mounts`;
  return `end=$(($(date +%s)+${String(Math.max(0, Math.ceil(waitSeconds)))})); `
    + 'while :; do '
    + `if [ -S ${socket} ]; then socket=yes; else socket=no; fi; `
    + `if ${mounted}; then mount=yes; else mount=no; fi; `
    + 'if [ "$socket" = yes ] && [ "$mount" = yes ]; then break; fi; '
    + 'if [ "$(date +%s)" -ge "$end" ]; then break; fi; '
    + 'sleep 0.05; '
    + 'done; '
    + 'echo "socket=$socket mount=$mount"';
}

/**
 * The reading one {@link journalReadyCommand} run printed, or `undefined` when
 * the container printed something else.
 *
 * The two are different findings and the caller reports them differently: a
 * daemon that did not come up is a daemon failure, and a probe that did not
 * answer at all is a container that did not run the command.
 */
export function readJournalReady(stdout: string): JournalReadyReading | undefined {
  const found = /socket=(yes|no) mount=(yes|no)/.exec(stdout);
  if (found === null) return undefined;
  return { socket: found[1] === 'yes', mount: found[2] === 'yes' };
}
