/**
 * How a shell command's outcome is rendered for the model — the ONE renderer
 * every exec-shaped surface uses (the `run` tool's workspace path, the inline
 * codemode `workspace.exec`, the CLI's `laptop`, the sandbox and Nimbus
 * containers, the device tunnel).
 *
 * It exists because each of those surfaces had grown its own version of the
 * same two lines, and every one of them threw a stream away:
 *
 *   exitCode !== 0  →  "Error (exit N): " + stderr        (stdout DISCARDED)
 *   exitCode === 0  →  stdout                             (stderr DISCARDED)
 *
 * Both halves are wrong, and the first half is the expensive one. `pytest`,
 * `cargo test`, `go test`, `make` and most build systems write their actual
 * diagnostics — which test failed, which line, which symbol — to **stdout**,
 * and exit non-zero with a stderr that is empty or a stray warning. Under the
 * old rule a failing suite reached the model as `Error (exit 1): ` and nothing
 * else: it knew it had failed and could not see why, so it had nothing to
 * update on and re-ran the same command. That is the measured thrash class
 * (`make` ×10, `objdump` ×34, regenerate-and-retest ×20) in the local
 * Terminal-Bench corpus. The reference harnesses do not have it: Terminus 2
 * shows the tmux pane exactly as a human sees it, Claude Code's Bash returns
 * the combined stream.
 *
 * So: a non-zero exit reports the code and BOTH streams, stdout first (it is
 * usually the diagnostics, and it should survive a head-clamp); a zero exit
 * reports stdout and appends stderr only when there is some, so the ordinary
 * quiet success is byte-identical to what it always was.
 *
 * Labels rather than true interleaving: nothing in this codebase captures a
 * merged pipe (each transport hands back two separate strings, and the remote
 * ones — sandbox, Nimbus, the device tunnel — return them over a protocol that
 * separated them long before we see them). Faking an interleave by
 * concatenating would assert an ordering we do not have.
 *
 * The `Error` prefix is load-bearing and stays: it is how a non-zero exit
 * returned as a normal tool result is recognised as a failure at all
 * (orchestrator/turn-steering.ts `isFailingToolResult`, extension.ts's
 * tool-result contract).
 */

/** The shape every transport settles a command into. */
export interface ExecOutcome {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

export const STDOUT_LABEL = '--- stdout ---';
export const STDERR_LABEL = '--- stderr ---';

/** What a command that wrote nothing anywhere reads as. */
export const NO_OUTPUT = '(no output)';

export function formatExecResult(result: ExecOutcome): string {
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const exitCode = result.exitCode ?? 0;

  if (exitCode === 0) {
    if (!stderr.trim()) return stdout || NO_OUTPUT;
    if (!stdout.trim()) return stderr;
    return `${stdout}\n${STDERR_LABEL}\n${stderr}`;
  }

  const sections = [`Error (exit ${exitCode})`];
  if (stdout.trim()) sections.push(`${STDOUT_LABEL}\n${stdout}`);
  if (stderr.trim()) sections.push(`${STDERR_LABEL}\n${stderr}`);
  if (sections.length === 1) sections.push(NO_OUTPUT);
  return sections.join('\n');
}
