// What the container's ONE persistent shell does with a command, for every fake
// that stands in for it.
//
// TWO DEPLOYED DEFECTS, ONE CLASS. Both were commands this package composes,
// both were accepted by a fake that answered them by string matching, and both
// killed the session shell on a real deployment:
//
//   1. `exit` ON A SUCCESS BRANCH. The chain's store-visibility probe said
//      `printf ready; exit 0`, which ended the shell rather than the script:
//      `SessionTerminatedError: Session 'sandbox-default' shell exited (exit
//      code: 0)`, 1,054 times over one wake in probe `wakeprobe09010702`.
//   2. A COMMAND THE SHELL CANNOT PARSE. `releaseWorkdirHoldersCommand` joined
//      its lines with a SPACE, so the container received `… fi done if [ -z …`
//      — no separator before `done`. `sh` answered `Syntax error: "do"
//      unexpected` and exited 2, so every stop in run `e2e20260901140445` died
//      as `Session 'sandbox-default' shell exited (exit code: 2)`:
//      two deployed boxes lost `stop-small` to it.
//   3. A TOP-LEVEL `set -e`. The chain's delta batches began with `set -e`
//      so a failed `cp` could not hide behind the `chmod` after it; the flag
//      outlived the batch in the persistent shell, and the next failing
//      command from ANY caller ended the session with that command's status.
//      Settlement `20260915012040` lost G3's read-only probe — a `touch` that
//      is meant to fail with EROFS — as `shell exited (exit code: 1)`, and
//      D5's G3 died the same way on 2026-09-13. Measured on the pinned
//      image's container server on 2026-09-15: `set -e` at the top level,
//      then `false`, and the session is gone; the same inside `( … )` and
//      the session survives.
//
// The second one is why this module runs a REAL PARSE rather than another
// pattern. A fake that matches `startsWith('holders=""')` accepts a command no
// shell would run, so the suite was green on a command the deployment refused —
// and no assertion anybody thought to write would have caught it, because the
// defect was in the shape of the string rather than in the decisions around it.
// `sh -n` is the same question the container asks, asked by the same kind of
// program.
//
// POSIX, NOT BASH. The sandbox image is Alpine, so the shell behind a session is
// a POSIX one; a command that needs bash has to say `bash -c` and carry its own
// dependency. Checking against `sh` therefore holds every composed command to
// the contract the container really offers.
import { spawnSync } from 'node:child_process';

/**
 * A command that tells the container's one session shell to exit.
 *
 * `exit` in a command string is not a way to end a script: the SDK feeds every
 * command to a PERSISTENT shell, so it ends that shell, and the SDK answers the
 * command that said it with `SessionTerminatedError`.
 */
const SHELL_EXIT = /(?:^|[\s;&|(])exit(?:\s+\d+)?\s*(?:$|[;&|)])/;

/**
 * A `set -e` (or `set -o errexit`) the persistent shell would keep after the
 * command: one at the top level of the command, outside any `( … )` subshell.
 * Bash keeps the flag for the life of the session, so the command that sets it
 * ends the session at the next failing command from anyone.
 */
function leavesErrexitSet(command: string): boolean {
  let depth = 0;

  for (const rawLine of command.split('\n')) {
    const line = rawLine.trim();

    if (depth === 0 && /^set\s+(?:-[a-zA-Z]*e[a-zA-Z]*|-o\s+errexit)(?:\s|$)/.test(line)) return true;

    for (const char of line) {
      if (char === '(') depth += 1;
      else if (char === ')') depth = Math.max(0, depth - 1);
    }
  }

  return false;
}

/**
 * What the SDK throws when a command ends the shell it was running in. The
 * `code` is the SDK's own, which is what the recovery taxonomy classifies.
 */
function sessionTerminated(exitCode: number): Error {
  return Object.assign(
    new Error(`Session 'sandbox-default' shell exited (exit code: ${String(exitCode)})`),
    { name: 'SessionTerminatedError', code: 'SESSION_TERMINATED' },
  );
}

/** One `sh -n` verdict per distinct command string. A suite runs the same
 *  templates thousands of times, and the parse of a string cannot change. */
const parsed = new Map<string, string | undefined>();

/** The shell's own complaint about a command it will not run, or `undefined`
 *  when it parses. */
function syntaxRefusal(command: string): string | undefined {
  const held = parsed.get(command);

  if (held !== undefined || parsed.has(command)) return held;
  const checked = spawnSync('sh', ['-n', '-c', command], { encoding: 'utf8' });

  if (checked.error !== undefined) {
    // No `sh` means this check cannot be made, and a check that quietly stops
    // checking is how the defect above survived a green suite in the first
    // place. Refusing loudly is the only honest answer.
    throw new Error(`the session-shell parse gate could not run sh: ${checked.error.message}`);
  }

  const refusal = checked.status === 0
    ? undefined
    : (checked.stderr.trim() || `sh -n exited ${String(checked.status)}`);

  parsed.set(command, refusal);

  return refusal;
}

/**
 * The failure a container's session shell answers a command with, or
 * `undefined` when the shell would run it.
 *
 * Every fake exec seam in this package calls this FIRST, so a command template
 * that grows an `exit` or loses a separator fails every test that runs it
 * rather than every deployment that runs it.
 */
export function sessionShellRefusal(command: string): Error | undefined {
  if (SHELL_EXIT.test(command)) return sessionTerminated(0);

  // The status the session dies with is the NEXT failing command's, not this
  // one's; 1 is what the deployed probe reported.
  if (leavesErrexitSet(command)) {
    return Object.assign(sessionTerminated(1), { shellRefusal: 'a top-level set -e outlives this command in the persistent session' });
  }

  const refusal = syntaxRefusal(command);

  if (refusal === undefined) return undefined;

  // The exit code a POSIX shell answers a parse failure with, and the code the
  // deployed stops really reported.
  return Object.assign(sessionTerminated(2), { shellRefusal: refusal });
}

/** The same verdict as an assertion, for a test that reads one command
 *  template directly rather than running it through a fake. */
export function requireSessionShellAccepts(command: string): void {
  const refused = sessionShellRefusal(command);

  if (refused !== undefined) {
    throw new Error(`the container's session shell would refuse this command: ${refused.message}\n${command}`);
  }
}
