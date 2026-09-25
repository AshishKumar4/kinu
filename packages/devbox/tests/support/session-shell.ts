// Models the container's one persistent session shell for every fake: `bash -n` parses each
// command, since a string-matching fake accepts commands the real shell refuses, and the output
// comes back by lines, as the container server re-reads it. The shell is bash: the 0.12.9
// container server spawns `bash --norc` per session and wraps each command in a script that
// itself uses `[[ ]]`.
import { spawnSync } from 'node:child_process';

/** `exit` ends the SDK's persistent session shell, not the script; the SDK answers that
 *  command with `SessionTerminatedError`. */
const SHELL_EXIT = /(?:^|[\s;&|(])exit(?:\s+\d+)?\s*(?:$|[;&|)])/;

/** Only a top-level `set -e`/`set -o errexit` counts: bash keeps it for the session (D18),
 *  so the next failing command from any caller ends the persistent shell. */
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

/** Mirrors the SDK error for a command that ends its shell; the recovery taxonomy
 *  classifies on the SDK's own `code`, so it must match. */
function sessionTerminated(exitCode: number): Error {
  return Object.assign(
    new Error(`Session 'sandbox-default' shell exited (exit code: ${String(exitCode)})`),
    { name: 'SessionTerminatedError', code: 'SESSION_TERMINATED' },
  );
}

/** One `bash -n` verdict per distinct command string. A suite runs the same
 *  templates thousands of times, and the parse of a string cannot change. */
const parsed = new Map<string, string | undefined>();

function syntaxRefusal(command: string): string | undefined {
  const held = parsed.get(command);

  if (held !== undefined || parsed.has(command)) return held;
  const checked = spawnSync('bash', ['-n', '-c', command], { encoding: 'utf8' });

  if (checked.error !== undefined) {
    // Missing `bash` throws rather than skipping: a parse gate that silently stops checking
    // lets broken command templates pass a green suite.
    throw new Error(`the session-shell parse gate could not run bash: ${checked.error.message}`);
  }

  const refusal = checked.status === 0
    ? undefined
    : (checked.stderr.trim() || `bash -n exited ${String(checked.status)}`);

  parsed.set(command, refusal);

  return refusal;
}

/** Every fake exec seam calls this first, so a command template that grows an `exit` or
 *  loses a separator fails the tests that run it, not the deployments. */
export function sessionShellRefusal(command: string): Error | undefined {
  if (SHELL_EXIT.test(command)) return sessionTerminated(0);

  // The session dies with the next failing command's status, not this one's; the deployed
  // probe reported 1.
  if (leavesErrexitSet(command)) {
    return Object.assign(sessionTerminated(1), { shellRefusal: 'a top-level set -e outlives this command in the persistent session' });
  }

  const refusal = syntaxRefusal(command);

  if (refusal === undefined) return undefined;

  // 2 is the shell's exit code for a parse failure, and what deployed stops reported.
  return Object.assign(sessionTerminated(2), { shellRefusal: refusal });
}

export function requireSessionShellAccepts(command: string): void {
  const refused = sessionShellRefusal(command);

  if (refused !== undefined) {
    throw new Error(`the container's session shell would refuse this command: ${refused.message}\n${command}`);
  }
}

/** A session command's output as `exec` answers it: the container server re-reads the command's
 *  output with bash `while IFS= read -r line` and joins the lines with `\n` (0.12.9 container
 *  server, `buildFIFOScript` and `parseLogFile`). So every NUL byte is dropped, the final newline
 *  goes, and an empty line inside the output stays. Measured 2026-09-25 against the production
 *  image's own server (`/api/execute`): `a\0b` answered `ab`, `a\nb\n` answered `a\nb`, and
 *  `a\n\nb` answered `a\n\nb` (docs/DEVBOX-DECISIONS.md P6). */
export function sessionShellOutput(raw: string): string {
  const lines = raw.replaceAll('\0', '').split('\n');

  if (lines.at(-1) === '') lines.pop();

  return lines.join('\n');
}
