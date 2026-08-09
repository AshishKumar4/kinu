/**
 * Mechanical delegation steering — the harness nudging the model toward the
 * delegation ladder at the two moments the doctrine already names.
 *
 * The doctrine (registry DELEGATION_RUNGS.fork) tells the model to fork on
 * breadth and on doubt. A weak model does not act on it: across a 10-task
 * Terminal-Bench slice the model forked on 0 tasks even after the doubt
 * trigger was written in. Prose cannot be the only carrier of a rule the
 * runtime can detect for itself, so the same two moments are detected
 * mechanically here and stated to the model IN the turn, at the step boundary
 * where the decision is still open.
 *
 * Two triggers, both cheap and deterministic:
 *
 *   repeated_failure          {@link CONSECUTIVE_FAILURES_BEFORE_NUDGE} failing
 *                             results from the SAME tool with no success in
 *                             between — the doctrine's "your first attempt
 *                             failed" made observable.
 *   long_turn_no_delegation   past {@link LONG_TURN_STEPS_BEFORE_NUDGE} steps
 *                             with no `agents` call — the doctrine's "work
 *                             splits into 2+ angles" made observable: a turn
 *                             that has taken this many steps IS multi-part,
 *                             and the step count is the only evidence of that
 *                             the runtime can read without guessing at intent.
 *
 * ONE nudge per turn, whichever trigger fires first. Both nudges say the same
 * thing — reach for fork — so a second one carries no information and reads as
 * nagging; the owner's rule is no spam and no silence, and one line in a turn
 * that is already 25 steps or 3 failures deep is the honest middle.
 *
 * It is a HINT. The message says so, nothing gates on it, and the model is
 * free to push on alone — but it can no longer end the turn having never been
 * told. Whether it converted is the point of the durable `delegation_nudge`
 * run event ({@link DelegationNudge.snapshot}), which the settle spine writes
 * exactly as it writes `context_budget`.
 *
 * Thresholds are constants, not configuration: a knob would make every bench
 * run a different experiment, and there is no per-agent answer to "how many
 * failures is too many". Their rationale is above; changing them is a code
 * change with a reason attached.
 *
 * Shared by construction: this is a {@link ProteusExtension} on the one hook
 * path both backends fire (cf's beforeToolCall/afterToolCall/beforeStep, the
 * CLI's runChat), owned per turn by the AgentOrchestrator next to the rest of
 * the turn's accounting.
 */

import type { ModelMessage } from 'ai';
import type { DelegationNudgeRecord, DelegationNudgeTrigger } from '../events/types.js';
import type {
  PrepareStepContext, ProteusExtension, ToolCallContext, ToolResultContext,
} from '../extension.js';
import { StepInjections } from '../prompting/step-injections.js';
import type { BuiltinToolName } from '../tools/registry.js';

/** Failing results from one tool, with no success in between, before the turn
 *  is told to stop grinding. Three is the first count that is a pattern rather
 *  than a retry: one failure is normal, two is a correction, three is the
 *  approach. */
export const CONSECUTIVE_FAILURES_BEFORE_NUDGE = 3;

/** Steps into a turn with no delegation before the turn is told the work
 *  splits. Observed turns run to 130 steps, and the navigation-plus-edit shape
 *  of ordinary single-part work settles well inside 25 — so a turn still going
 *  at 25 has enough parts to be worth splitting, while the threshold stays far
 *  enough above normal work that a coherent single change never trips it. */
export const LONG_TURN_STEPS_BEFORE_NUDGE = 25;

/** The tool the nudges name — the whole delegation ladder is one tool. */
const DELEGATION_TOOL: BuiltinToolName = 'agents';

/** Marks the line as runtime-authored, exactly as the ephemeral context and
 *  turn context blocks do: the model must never read a harness nudge as
 *  something the user typed. */
export const DELEGATION_NUDGE_HEADER =
  '[Runtime steering — a mechanical nudge from the Proteus harness, not written by the user.]';

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
 * (`Error (exit 2): …` — tools/builtins.ts, cli-backend/runtime.ts), which is
 * exactly the case that motivated this whole mechanism. So the text shapes the
 * toolset actually emits count too: the `Error` prefix every built-in failure
 * uses, and the structured `{ error: … }` payloads the unprovisioned-runtime
 * paths return. Nothing else is guessed at — a result that merely mentions the
 * word "error" somewhere in its output is not a failure.
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

export class DelegationNudge implements ProteusExtension {
  readonly name = 'proteus.delegation-nudge';

  /** Splices the nudge at the step tail and re-applies it at that index for
   *  the rest of the turn — the same coordinate math every other mid-turn
   *  injection rides, so the prompt-cache prefix stays stable. */
  private readonly injections = new StepInjections<{ readonly message: ModelMessage }>();
  /** Failures per tool since that tool last succeeded. */
  private readonly failures = new Map<string, number>();
  private delegated = false;
  private fired: { trigger: DelegationNudgeTrigger; step: number; tool?: string } | null = null;
  private converted = false;

  /** Clear for a new turn. */
  reset(): void {
    this.injections.reset();
    this.failures.clear();
    this.delegated = false;
    this.fired = null;
    this.converted = false;
  }

  onToolCall(ctx: ToolCallContext): void {
    if (ctx.toolName !== DELEGATION_TOOL) return;
    this.delegated = true;
    if (this.fired) this.converted = true;
  }

  onToolResult(ctx: ToolResultContext): void {
    if (!isFailingToolResult(ctx)) {
      this.failures.delete(ctx.toolName);
      return;
    }
    this.failures.set(ctx.toolName, (this.failures.get(ctx.toolName) ?? 0) + 1);
  }

  prepareStep(ctx: PrepareStepContext): ModelMessage[] | undefined {
    return this.injections.drain(ctx, this.nudgeFor(ctx.stepNumber));
  }

  /** The turn's nudge and whether it converted, or null when none fired. */
  snapshot(): DelegationNudgeRecord | null {
    return this.fired ? { ...this.fired, converted: this.converted } : null;
  }

  /** At most one entry, ever: the first trigger to fire owns the turn. */
  private nudgeFor(step: number): Array<{ readonly message: ModelMessage }> {
    if (this.fired) return [];
    const stuck = [...this.failures].find(([, count]) => count >= CONSECUTIVE_FAILURES_BEFORE_NUDGE);
    if (stuck) {
      this.fired = { trigger: 'repeated_failure', step, tool: stuck[0] };
      return [message(repeatedFailureText(stuck[0], stuck[1]))];
    }
    if (step >= LONG_TURN_STEPS_BEFORE_NUDGE && !this.delegated) {
      this.fired = { trigger: 'long_turn_no_delegation', step };
      return [message(longTurnText(step))];
    }
    return [];
  }
}

/** A user-role message, like every other runtime-authored mid-turn splice: a
 *  system message between steps is not portable across providers, and the
 *  header already says who wrote it. */
function message(text: string): { readonly message: ModelMessage } {
  return { message: { role: 'user', content: `${DELEGATION_NUDGE_HEADER}\n\n${text}` } };
}
