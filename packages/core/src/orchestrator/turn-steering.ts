/**
 * Mechanical turn steering — the harness saying, IN the turn, the one thing it
 * can see about the turn that the model cannot.
 *
 * Everything here exists because prose does not work. Proteus's doctrine tells
 * the model to fork on breadth and on doubt, and to stop and re-read when a
 * command keeps failing; across a 10-task Terminal-Bench slice the model forked
 * on 0 tasks with that doctrine written in, and re-ran the same failing command
 * up to 34 times. The same conditions are trivially detectable from the turn's
 * own tool traffic, so they are detected here and stated to the model at the
 * step boundary where the decision is still open. Measured: doctrine 0%, a
 * mechanical splice 24%.
 *
 * Three triggers, all cheap and deterministic, in priority order:
 *
 *   repeated_call             {@link IDENTICAL_CALLS_BEFORE_STEER} calls of the
 *                             SAME tool with the SAME arguments that returned
 *                             the SAME output. Not "probably looping" — the
 *                             harness has the outputs and they are identical,
 *                             so the model has demonstrably learned nothing
 *                             from the last two. First, because it is the only
 *                             trigger that can name the exact thing repeating.
 *   repeated_failure          {@link CONSECUTIVE_FAILURES_BEFORE_STEER} failing
 *                             results from the SAME tool with no success in
 *                             between — the doctrine's "your first attempt
 *                             failed" made observable.
 *   long_turn_no_delegation   past {@link LONG_TURN_STEPS_BEFORE_STEER} steps
 *                             with no `agents` call — the doctrine's "work
 *                             splits into 2+ angles" made observable: a turn
 *                             that has taken this many steps IS multi-part, and
 *                             the step count is the only evidence of that the
 *                             runtime can read without guessing at intent.
 *
 * ONE steer per turn, whichever trigger fires first. A second one carries
 * almost no new information and reads as nagging; the owner's rule is no spam
 * and no silence, and one line in a turn that is already 25 steps or 3 failures
 * or 3 identical calls deep is the honest middle. That is also why this is one
 * object and not three detectors: three independent mechanisms would each fire
 * on the same thrash loop.
 *
 * Every steer is a HINT. The message says so, nothing gates on it, and the
 * model is free to push on — but it can no longer end the turn having never
 * been told. Whether it converted is the point of the durable `turn_steering`
 * run event ({@link TurnSteering.snapshot}), which the settle spine writes
 * exactly as it writes `context_budget`. What "converted" means is per trigger:
 * the delegation steers ask for a fork, the repeat steer asks for anything
 * other than the call it named.
 *
 * Thresholds are constants, not configuration: a knob would make every bench
 * run a different experiment, and there is no per-agent answer to "how many
 * failures is too many". Their rationale is above; changing them is a code
 * change with a reason attached.
 *
 * Shared by construction: the observation hooks ride the one hook path both
 * backends fire (cf's beforeToolCall/afterToolCall/beforeStep, the CLI's
 * runChat), and the steer itself rides the same splice every asynchronous
 * producer's signal rides — handed to the step it was decided on, so it can
 * never outlive the turn. The AgentOrchestrator owns both, per turn, next to
 * the rest of the turn's accounting.
 */

import type { TurnSteeringRecord, TurnSteeringTrigger } from '../events/types.js';
import type { ToolCallContext, ToolResultContext } from '../extension.js';
import type { AgentSignal } from '../types/signals.js';
import type { BuiltinToolName } from '../tools/registry.js';
import { fnv1a64 } from '../prompting/volatile-context.js';

/** Identical calls answered identically before the turn is told it is looping.
 *  Three is the first count that is a loop rather than a retry: one repeat is a
 *  retry, two is a correction, three has learned nothing twice. */
export const IDENTICAL_CALLS_BEFORE_STEER = 3;

/** Failing results from one tool, with no success in between, before the turn
 *  is told to stop grinding. Three is the first count that is a pattern rather
 *  than a retry: one failure is normal, two is a correction, three is the
 *  approach. */
export const CONSECUTIVE_FAILURES_BEFORE_STEER = 3;

/** Steps into a turn with no delegation before the turn is told the work
 *  splits. Observed turns run to 130 steps, and the navigation-plus-edit shape
 *  of ordinary single-part work settles well inside 25 — so a turn still going
 *  at 25 has enough parts to be worth splitting, while the threshold stays far
 *  enough above normal work that a coherent single change never trips it. */
export const LONG_TURN_STEPS_BEFORE_STEER = 25;

/** How much of a repeated call's arguments the steer quotes back. Enough to
 *  name a command; never a whole `execute_tools` program. */
const ARGS_ECHO_MAX_CHARS = 200;

/** The tool the delegation steers name — the whole delegation ladder is one tool. */
const DELEGATION_TOOL: BuiltinToolName = 'agents';

/** Marks the line as runtime-authored, exactly as the ephemeral context and
 *  turn context blocks do: the model must never read a harness steer as
 *  something the user typed. */
export const TURN_STEERING_HEADER =
  '[Runtime steering — a mechanical nudge from the Proteus harness, not written by the user.]';

function repeatedCallText(tool: string, args: string, calls: number): string {
  return `\`${tool}\` has run ${calls} times with the same arguments and returned the same output every time — ${args}. `
    + 'Repeating it cannot tell you anything new; the output you already have is everything it has to say. '
    + 'Read that output again for the actual cause, or change the approach: a different command, a different file, '
    + `or \`${DELEGATION_TOOL}\` action=fork to run competing approaches in parallel. `
    + 'This is a hint, not an instruction — push on if you know why the repeat is right.';
}

function repeatedFailureText(tool: string, failures: number): string {
  return `\`${tool}\` has failed ${failures} times in a row. Running the same approach again is the least likely thing to work: `
    + `fork now (\`${DELEGATION_TOOL}\` action=fork) to try competing approaches in parallel, and settle=mcts if they have to be scored by execution rather than merged. `
    + 'This is a hint, not an instruction — push on alone if you already know the fix.';
}

function longTurnText(steps: number): string {
  return `${steps} steps into this turn with no delegation. Work this long is work that splits: `
    + `fork now (\`${DELEGATION_TOOL}\` action=fork) to run the independent parts in parallel instead of grinding them one at a time. `
    + 'This is a hint, not an instruction — push on alone if the rest is genuinely sequential.';
}

/**
 * True when a tool result is a failure the model should be able to see as one.
 *
 * The harness discriminator (`success`) is necessary but not sufficient: the
 * `run` tool catches a non-zero exit and RETURNS it as a normal result string
 * (`Error (exit 2)…` — execution/exec-result.ts), which is exactly the case
 * that motivated this whole mechanism. So the text shapes the toolset actually
 * emits count too: the `Error` prefix every built-in failure uses, and the
 * structured `{ error: … }` payloads the unprovisioned-runtime paths return.
 * Nothing else is guessed at — a result that merely mentions the word "error"
 * somewhere in its output is not a failure.
 */
export function isFailingToolResult(ctx: ToolResultContext): boolean {
  if (!ctx.success) return true;
  const text = ctx.result.trimStart();
  if (/^Error\b/.test(text)) return true;
  if (!text.startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      && typeof (parsed as { error?: unknown }).error === 'string';
  } catch {
    return false;
  }
}

/** One tool called one way. Hashed rather than stored: an `execute_tools`
 *  program is tens of kilobytes and a turn runs hundreds of steps. */
function callSignature(toolName: string, args: Record<string, unknown>): string {
  return `${toolName} ${fnv1a64(stableArgs(args))}`;
}

/** Key-order-independent serialization, so `{a,b}` and `{b,a}` are one call. */
function stableArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, (_key, value: unknown) =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : value) ?? '';
  } catch {
    // Circular or unserializable input: no stable identity, so no repeat.
    return '';
  }
}

function echoArgs(args: Record<string, unknown>): string {
  const rendered = stableArgs(args);
  return rendered.length <= ARGS_ECHO_MAX_CHARS
    ? rendered
    : `${rendered.slice(0, ARGS_ECHO_MAX_CHARS)}…`;
}

/** One repeated call: what it is, what it answered, and how many times. */
interface RepeatedCall {
  readonly tool: string;
  readonly args: string;
  /** Hash of the last result, so a changed result restarts the streak. */
  resultHash: string;
  count: number;
}

export class TurnSteering {
  /** Failures per tool since that tool last succeeded. */
  private readonly failures = new Map<string, number>();
  /** Identical calls with an unchanged answer, by call signature. */
  private readonly repeats = new Map<string, RepeatedCall>();
  private delegated = false;
  private fired: { trigger: TurnSteeringTrigger; step: number; tool?: string } | null = null;
  private converted = false;
  /** The signature the repeat steer named — anything else is a changed
   *  approach, which is what that steer asked for. Null for the delegation
   *  steers, which ask for `agents` instead. */
  private repeating: string | null = null;

  /** Clear for a new turn. */
  reset(): void {
    this.failures.clear();
    this.repeats.clear();
    this.delegated = false;
    this.fired = null;
    this.converted = false;
    this.repeating = null;
  }

  onToolCall(ctx: ToolCallContext): void {
    if (ctx.toolName === DELEGATION_TOOL) this.delegated = true;
    if (this.fired && this.answersTheSteer(ctx)) this.converted = true;
  }

  onToolResult(ctx: ToolResultContext): void {
    if (isFailingToolResult(ctx)) {
      this.failures.set(ctx.toolName, (this.failures.get(ctx.toolName) ?? 0) + 1);
    } else {
      this.failures.delete(ctx.toolName);
    }

    // A repeat is only a repeat while the answer stays the same: a call whose
    // output changed taught the model something, so its streak restarts.
    const signature = callSignature(ctx.toolName, ctx.args);
    const resultHash = fnv1a64(ctx.result);
    const seen = this.repeats.get(signature);
    if (seen && seen.resultHash === resultHash) {
      seen.count += 1;
      return;
    }
    this.repeats.set(signature, {
      tool: ctx.toolName, args: echoArgs(ctx.args), resultHash, count: 1,
    });
  }

  /** The turn's steer and whether it converted, or null when none fired. */
  snapshot(): TurnSteeringRecord | null {
    return this.fired ? { ...this.fired, converted: this.converted } : null;
  }

  /**
   * The step-boundary trigger check: the signal to deliver into THIS step, or
   * null. At most one, ever — the first trigger to fire owns the turn.
   */
  steerFor(step: number): AgentSignal | null {
    if (this.fired) return null;
    const looping = [...this.repeats].find(([, call]) => call.count >= IDENTICAL_CALLS_BEFORE_STEER);
    if (looping) {
      const [signature, call] = looping;
      this.repeating = signature;
      this.fired = { trigger: 'repeated_call', step, tool: call.tool };
      return signal(repeatedCallText(call.tool, call.args, call.count));
    }
    const stuck = [...this.failures].find(([, count]) => count >= CONSECUTIVE_FAILURES_BEFORE_STEER);
    if (stuck) {
      this.fired = { trigger: 'repeated_failure', step, tool: stuck[0] };
      return signal(repeatedFailureText(stuck[0], stuck[1]));
    }
    if (step >= LONG_TURN_STEPS_BEFORE_STEER && !this.delegated) {
      this.fired = { trigger: 'long_turn_no_delegation', step };
      return signal(longTurnText(step));
    }
    return null;
  }

  /** Did this call do the thing the fired steer asked for? */
  private answersTheSteer(ctx: ToolCallContext): boolean {
    return this.repeating === null
      ? ctx.toolName === DELEGATION_TOOL
      : callSignature(ctx.toolName, ctx.args) !== this.repeating;
  }
}

/** The turn's OWN steering — meaningless outside the turn that produced it, so
 *  it is handed to the step being prepared rather than delivered. Its body
 *  becomes a user-role message like every other runtime-authored mid-turn
 *  splice: a system message between steps is not portable across providers,
 *  and the header already says who wrote it. */
function signal(text: string): AgentSignal {
  return {
    kind: 'turn_steering',
    text: `${TURN_STEERING_HEADER}\n\n${text}`,
  };
}
