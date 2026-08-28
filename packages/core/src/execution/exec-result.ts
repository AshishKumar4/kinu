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

import * as v from 'valibot';
import { ERROR_CODES, refusalOf, tolerate, type KinuError, type Refusal } from '../obs/index';
import { parseJsonValue } from '../utils/json';

const RefusalSchema = v.object({ reason: v.picklist(ERROR_CODES), error: v.string() });
const ErrorResultSchema = v.object({ error: v.string() });

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

/**
 * A classified failure, rendered onto the STRING channel an executor tool
 * answers on.
 *
 * It lives beside `isFailingResultText` because that predicate is what reads it
 * back: the JSON refusal is one of the two shapes it recognises, so producer and
 * recogniser are the same file and cannot disagree about the shape. Before this,
 * an executor answered a failure with prose — `exec error: …`, `No device
 * connected.` — which `isFailingResultText` correctly classifies as NOT a
 * failure, because it is indistinguishable from a command whose OUTPUT happens
 * to say that. So a sandbox with no binding and a laptop with no device were
 * both recorded as clean calls.
 *
 * Returned rather than thrown, because these tools are also called from
 * LLM-generated code inside `execute_tools`: a throw ends the whole block, while
 * a refusal payload lets the generated code branch on `reason` — the same reason
 * `tools/file-tool.ts` returns its refusals and `run`'s escalation paths return
 * theirs.
 */
export function refusalText(error: KinuError): string {
  return JSON.stringify(refusalOf(error));
}

/**
 * The refusal a rendered tool result carries, or null when it is not one — the
 * reader side of `refusalText`, kept in this file so producer and parser cannot
 * disagree about the shape. Every surface that shows a result to a HUMAN (the
 * CLI's chat transcripts and one-shot runs) funnels through here, so a refusal
 * reaches the person as prose instead of as the JSON the model reads.
 *
 * Strict on purpose: a result of structured JSON that merely CONTAINS an
 * `error` field (codemode results, executor payloads) is not a refusal, and
 * rendering one as a failure would lie about a successful call.
 */
export function parseRefusal(result: string): Refusal | null {
  const text = result.trimStart();
  if (!text.startsWith('{')) return null;
  const json = tolerate(() => parseJsonValue(text), 'malformed-input');
  if (json === undefined) return null;
  const parsed = v.safeParse(RefusalSchema, json);
  return parsed.success ? { reason: parsed.output.reason, error: parsed.output.error } : null;
}

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

/**
 * Whether a rendered tool result is a FAILURE — the inverse of the renderer
 * above, and the one definition every reader shares.
 *
 * It lives here because this file creates the evidence: `formatExecResult`
 * turns a non-zero exit into a leading `Error (exit N)`, and that prefix is
 * the only surviving trace of the exit code by the time a result reaches a
 * reader. A reader that checks the transport discriminator alone cannot see it
 * — the `run` tool catches a non-zero exit and hands it back as an ordinary,
 * successful result, because that text is what steers the model's next step.
 *
 * Two shapes, both produced by this codebase and nothing else guessed at: the
 * `Error` prefix every built-in failure uses, and the refusal payload a tool puts
 * on its own result. A result that merely mentions the word "error" somewhere in
 * its output is not a failure.
 *
 * The JSON half is read from the head rather than parsed whole: every seam hands
 * over a BOUNDED prefix of the result (chat.ts and the cf afterToolCall both cut
 * at 1000 chars), so a long failure payload arrives as JSON that cannot parse
 * while its discriminator is still legible at the front. `reason` is read there
 * as well as `error`, because a refusal leads with its CLASSIFICATION — that is
 * the whole point of putting the discriminator where no clamp can reach it
 * (obs/error.ts `Refusal`, tools/file-tool.ts:78-84). Reading only `error` meant
 * a clamped refusal was indistinguishable from a clamped success.
 */
export function isFailingResultText(result: string): boolean {
  const text = result.trimStart();
  if (/^Error\b/.test(text)) return true;
  if (!text.startsWith('{')) return false;
  const json = tolerate(() => parseJsonValue(text), 'malformed-input');
  if (json === undefined) return /^\{\s*"(?:reason|error)"\s*:\s*"/.test(text);
  return v.safeParse(ErrorResultSchema, json).success;
}
