/**
 * The mechanical completion gate — a one-shot run does not get to end on the
 * model's own say-so.
 *
 * On the interactive surface a human reads the answer and pushes back, so the
 * model deciding it is done is fine. On the one-shot surface (`kinu exec`,
 * `kinu run`) nobody reads it: the process exits, whatever is on disk is the
 * deliverable, and the next thing to look at it is a grader or a CI step. The
 * measured failure class there is the near-miss — a stray build artifact left
 * behind, a violated output constraint, a transposed column, a self-consistent
 * wrong API — roughly a dozen honest zeros in the local Terminal-Bench corpus
 * that sat one check away from passing.
 *
 * Terminus 2, the reference agent that scores ~79% on the same benchmark, has
 * exactly one mechanism for this and it is not advice: `task_complete: true`
 * does not end its run. The harness replies with the CURRENT terminal state and
 * "are you sure — this will be graded and you won't be able to make further
 * corrections", and requires the claim a second time. One forced re-look at
 * fresh state, on every single trial.
 *
 * Kinu had prose instead (a Verification section in the system prompt), and
 * Kinu's own telemetry says what prose is worth: written doctrine converted
 * 0% of benchmark trials to the behaviour it asked for, while a mechanical
 * splice converted 24%. So this is a mechanism, and it is built so a claim
 * cannot satisfy it:
 *
 *   • the gate fires on what the turn DID (it made tool calls and the stream
 *     completed), never on what the turn said;
 *   • the state it shows is read by the harness, from the same shell the agent
 *     was working in, after the agent stopped — the agent cannot author it;
 *   • it fires once per task, so "yes I'm sure" cannot spend a budget, and the
 *     turn after it is final.
 *
 * What it deliberately does NOT do: fire when the harness could observe
 * nothing (see {@link observeCompletionState} returning null). A gate with no
 * evidence to show would be reduced to asking "are you sure?", which is the
 * doctrine-shaped fix this exists to replace.
 */

import type { CompletionGateRecord } from '../events/types';
import type { VFS } from '../types/primitives';
import type { ExecOutcome } from '../execution/exec-result';
import { formatExecResult } from '../execution/exec-result';
import { clampToolResult } from '../tools/clamp';

/** `kinuEvent` on the turn the gate enqueues — its provenance in the run
 *  log, and how the turn pump recognises the confirming turn as its own. */
export const COMPLETION_GATE_EVENT = 'completion_gate';

/** Marks the turn as runtime-authored, exactly as the mid-turn steering splice
 *  does: the model must never read a harness check as something the user typed. */
export const COMPLETION_GATE_HEADER =
  '[Runtime check — a mechanical gate from Kinu, not written by the user.]';

/**
 * What the harness looks at: where it is, what is there, and what changed —
 * the three things a person checks before calling a terminal task done, all
 * read-only and all cheap.
 *
 * `git status` is dropped when it fails, because "not a git repository" is a
 * fact about the probe rather than about the deliverable. The other two are
 * reported however they settle: a working directory that cannot be listed is
 * itself state worth seeing.
 */
export const COMPLETION_PROBE_COMMANDS = ['pwd', 'ls -la', 'git status --short'] as const;

/** Bound on the observation. Big enough for a full directory listing plus a
 *  working tree's worth of changes; clamped through the ordinary tool-result
 *  path, so an overflowing listing still spills with its restore recipe. */
export const COMPLETION_OBSERVATION_MAX_CHARS = 8_000;

/** Bound on the task echoed back. The task is already in history — the echo is
 *  there to re-anchor a weak model at the moment it is deciding it is done, not
 *  to re-send the prompt. */
export const COMPLETION_TASK_ECHO_MAX_CHARS = 2_000;

/**
 * Read the current state through the agent's own shell, after it has stopped.
 * Returns null when nothing could be read at all — the caller must then not
 * gate, because it has nothing to show.
 */
export async function observeCompletionState(deps: {
  exec: (command: string) => Promise<ExecOutcome>;
  vfs?: VFS;
}): Promise<string | null> {
  const blocks: string[] = [];
  for (const command of COMPLETION_PROBE_COMMANDS) {
    let outcome: ExecOutcome;
    try {
      outcome = await deps.exec(command);
    } catch {
      continue;
    }
    if (command.startsWith('git ') && (outcome.exitCode ?? 0) !== 0) continue;
    blocks.push(`$ ${command}\n${formatExecResult(outcome).trim()}`);
  }
  if (blocks.length === 0) return null;
  return clampToolResult(blocks.join('\n\n'), {
    maxChars: COMPLETION_OBSERVATION_MAX_CHARS,
    vfs: deps.vfs,
  });
}

/** The turn the gate enqueues: the task, the observation, and the stakes. */
export function completionGateText(opts: { task: string; observed: string }): string {
  return `${COMPLETION_GATE_HEADER}

This run ends after your next reply and its result is graded exactly as it stands then. No later turn can correct it.

The task you were given:
${truncate(opts.task, COMPLETION_TASK_ECHO_MAX_CHARS)}

The state of your working directory right now, read by the harness after you stopped:

${opts.observed}

Check it against what the task actually asked for — the files it named, the output format it specified, anything it said must not be left behind. If everything is there, say so in one line and stop. If anything is missing or wrong, fix it now.`;
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}\n[… ${text.length - maxChars} chars of the task omitted; it is in full above in this conversation]`;
}

/** Whether a finished turn has earned the right to be the last word. */
export interface TurnCompletionFacts {
  /** The turn's stream ended without a terminal failure. */
  readonly completed: boolean;
  /** Tool calls the turn made. Zero means it produced no state to check. */
  readonly toolCalls: number;
}

/**
 * Per-session gate state. One task, one gate: {@link arm} is called at the
 * start of each task turn on the one-shot surface and nowhere else, so the
 * interactive surface simply never arms and the gate costs it nothing.
 */
export class CompletionGate {
  private armed = false;
  private fired = false;
  private record: CompletionGateRecord | null = null;
  private taskText = '';

  /** A task turn is starting on a surface that grades what it leaves behind.
   *  The task is held because the turn that trips the gate is not always the
   *  one that was given it — a detached job's wake turn can be the last to do
   *  work, and echoing ITS text back as "the task you were given" would be a
   *  lie at the exact moment the model is checking itself against the task. */
  arm(task: string): void {
    this.armed = true;
    this.fired = false;
    this.record = null;
    this.taskText = task;
  }

  /** The task this run is graded against. */
  get task(): string {
    return this.taskText;
  }

  /**
   * The turn just ended. True when the harness must take its own look before
   * the run is allowed to be over.
   *
   * A turn that made no tool calls left no state to check — it answered a
   * question — and a turn that ended in a terminal failure has already
   * reported that failure, so neither is gated.
   */
  shouldGate(facts: TurnCompletionFacts): boolean {
    return this.armed && !this.fired && facts.completed && facts.toolCalls > 0;
  }

  /** The confirming turn has been enqueued. */
  fire(): void {
    this.fired = true;
  }

  /** The confirming turn ended: what the agent did with its free re-look. */
  settle(facts: { toolCalls: number }): void {
    this.record = { converted: facts.toolCalls > 0 };
  }

  /** The record, once — it belongs to the one run that closes after
   *  {@link settle}, the way a turn's mechanical steer belongs to its own. */
  take(): CompletionGateRecord | null {
    const record = this.record;
    this.record = null;
    return record;
  }
}
