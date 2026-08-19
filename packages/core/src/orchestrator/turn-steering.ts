/**
 * Mechanical turn steering — the harness saying, IN the turn, the one thing it
 * can see about the turn that the model cannot.
 *
 * Everything here exists because prose does not work. Proteus's doctrine tells
 * the model to delegate on breadth and on doubt, and to stop and re-read when a
 * command keeps failing; across a 10-task Terminal-Bench slice the model
 * delegated on 0 tasks with that doctrine written in, and re-ran the same
 * failing command up to 34 times.
 * The same conditions are trivially detectable from the turn's
 * own tool traffic, so they are detected here and stated to the model at the
 * step boundary where the decision is still open. Measured: doctrine 0%, a
 * mechanical splice 24%.
 *
 * Five triggers, all cheap and deterministic. Four are REACTIVE — they read
 * the turn's own tool traffic, in priority order:
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
 *   no_progress               {@link STEPS_WITHOUT_PROGRESS_BEFORE_STEER} steps
 *                             in a row in which the turn's frontier did not
 *                             move at all: no call it had not already made, no
 *                             file it had not already touched, no edit that
 *                             landed. The trigger the other three cannot see,
 *                             because none of them is about SPEND: a turn can
 *                             burn forty steps whose every call SUCCEEDS and
 *                             still be circling, and three of those steps
 *                             failing is not what was wrong with it.
 *   long_turn_no_delegation   past {@link LONG_TURN_STEPS_BEFORE_STEER} steps
 *                             with no `agents` call — the doctrine's "work
 *                             splits into 2+ angles" made observable: a turn
 *                             that has taken this many steps IS multi-part, and
 *                             the step count is the only evidence of that the
 *                             runtime can read without guessing at intent.
 *
 * and the fifth is not reactive at all, because the decision it is about is
 * made before the turn has any traffic to read:
 *
 *   turn_start_no_delegation  step 0 of a turn whose context holds no work of
 *                             this agent's yet and whose ask is not a question
 *                             — the session's first ask, and again after a
 *                             compaction that folded the whole transcript. The
 *                             doctrine's shape test, stated at the one moment
 *                             the shape is still open. The 25-step steer above
 *                             is recovery from a shape already chosen wrong,
 *                             which prompt.ts conceded in prose and could not
 *                             fix from there.
 *
 * ONE reactive steer per turn, whichever trigger fires first. A second one
 * carries almost no new information and reads as nagging; the owner's rule is
 * no spam and no silence, and one line in a turn that is already 25 steps or 3
 * failures or 3 identical calls or 12 stalled steps deep is the honest middle.
 * That is also why this is one object and not four detectors: four independent
 * mechanisms would each fire on the same thrash loop.
 *
 * The turn-start hint holds its OWN slot, so a turn can carry two rows: the
 * hint at step 0 and, twenty-five steps later, the recovery steer for the
 * shape the hint failed to prevent. One shared slot would have cost either the
 * recovery steer on the session's first turn — the only turn a one-shot
 * `proteus exec` run has — or the count of hints that did NOT convert, which
 * is the number the whole comparison rests on.
 *
 * Every steer is a HINT. The message says so, nothing gates on it, and the
 * model is free to push on — but it can no longer end the turn having never
 * been told. Whether it converted is the point of the durable `turn_steering`
 * run event ({@link TurnSteering.snapshot}), which the settle spine writes
 * exactly as it writes `context_budget`. What "converted" means is per trigger:
 * the delegation steers ask for a search, the repeat steer asks for anything
 * other than the call it named, and the progress steer asks for a call the turn
 * has not made before — so whether a trigger EARNS its place is a query over
 * `turn_steering` rows, not an opinion.
 *
 * The failure ledger has a second reader: {@link TurnSteering.onToolResult}
 * reports the moment a steer-worthy streak is BROKEN by a changed call that
 * ran clean — an execution recovery (evolution/recovery.ts), the one thing
 * about the episode's own learning the runtime can prove. Detection lives
 * here because the streaks live here; what the observation is worth, and its
 * ceiling, is that module's business. A streak broken by the SAME call
 * finally working reports nothing: that is a retry that got lucky, and
 * durable "keep grinding" advice is the exact misevolution the steer above
 * exists to prevent.
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

import * as v from 'valibot';
import type { ModelMessage } from 'ai';
import type { TurnSteeringRecord, TurnSteeringTrigger } from '../events/types';
import type { PrepareStepContext, ToolCallContext, ToolResultContext } from '../extension';
import type { AgentSignal } from '../types/signals';
import type { BuiltinToolName } from '../tools/registry';
import type { RecoveryFinding } from '../evolution/recovery';
import { fnv1a64 } from '../prompting/volatile-context';
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from '../utils/json';
import { isFailingResultText } from '../execution/exec-result';

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

/**
 * Consecutive steps whose {@link TurnSteering.progressScore} did not move
 * before the turn is told it is spending without getting anywhere.
 *
 * Twelve, and the reasoning is the shape of the measure rather than a feel for
 * the number. Progress here is a MONOTONE count of firsts — a call the turn has
 * not made, a file it has not touched, an edit that landed — so ordinary work
 * moves it on very nearly every step: each new command is a first, each new
 * file read is a first. A step that moves NOTHING is a step that re-issued
 * something already issued against ground already covered, and twelve of those
 * back to back is not a plateau, it is a circuit. Half of
 * {@link LONG_TURN_STEPS_BEFORE_STEER} on purpose: the two triggers answer
 * different questions ("this is going nowhere" vs "this is long enough to
 * split") and the one that can say WHY should get there first.
 *
 * The clock is steps rather than tokens even though the insight is about spend,
 * because a step IS one full request against the whole context: steps burned
 * are proportional to tokens burned, and unlike a token count a step count is
 * identical across providers and exactly reproducible in a bench run. A
 * threshold that moved with the model would make every run a different
 * experiment.
 */
export const STEPS_WITHOUT_PROGRESS_BEFORE_STEER = 12;

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
    + `or \`${DELEGATION_TOOL}\` action=swarm to run competing approaches in parallel. `
    + 'This is a hint, not an instruction — push on if you know why the repeat is right.';
}

function repeatedFailureText(tool: string, failures: number): string {
  return `\`${tool}\` has failed ${failures} times in a row. Running the same approach again is the least likely thing to work: `
    + `search now (\`${DELEGATION_TOOL}\` action=swarm) to try competing approaches in parallel — say what counts in \`objective\` and each candidate is measured by your own verifier, or take \`preset:'ideate'\` when there is nothing to measure yet. `
    + 'This is a hint, not an instruction — push on alone if you already know the fix.';
}

function noProgressText(steps: number): string {
  return `${steps} steps in a row with nothing new in any of them: every call was one this turn had already made, `
    + 'no file was touched for the first time, and no edit landed. '
    + 'Steps that succeed are not the same as steps that get somewhere — this turn is spending and not moving. '
    + 'Stop and say what is actually blocking you, then change something real: a different file, a different command, '
    + `or \`${DELEGATION_TOOL}\` action=swarm to run competing approaches in parallel. `
    + 'This is a hint, not an instruction — push on if the ground you are re-covering is the right ground.';
}

function longTurnText(steps: number): string {
  return `${steps} steps into this turn with no delegation. Work this long is work that splits: `
    + `search now (\`${DELEGATION_TOOL}\` action=swarm) to run the independent parts in parallel instead of grinding them one at a time. `
    + 'This is a hint, not an instruction — push on alone if the rest is genuinely sequential.';
}

/**
 * The turn-start hint: the one decision that is the model's own — how the work
 * splits — named at the only step where making it is still free, then the call
 * that runs the parts.
 *
 * Worded as a hint in the same register as the other four, and deliberately
 * carries no number: nothing here is evidence about THIS turn, only about when
 * the decision is open.
 */
function turnStartDelegationText(): string {
  return 'Settle the shape first: what the parts are, and what each one owes the others. That decision is yours. '
    + `Then run the independent parts as one search (\`${DELEGATION_TOOL}\` action=swarm) in one call, and carry on with what is left. `
    + 'This is a hint, not an instruction — work alone if the whole thing is one coherent change.';
}

/** A user message's parts, read for their text alone: an image or a file part
 *  carries none, so it contributes nothing to read. */
const TextPartsSchema = v.array(v.looseObject({ text: v.optional(v.string()) }));

/** A user message's readable text — the string form, or its text parts joined.
 *  Narrowed with a parse rather than a shape check, the same way the context
 *  meter reads a message's content (prompting/context-meter.ts). */
function askText(message: ModelMessage): string {
  if (message.role !== 'user') return '';
  const flat = v.safeParse(v.string(), message.content);
  if (flat.success) return flat.output;
  const parts = v.safeParse(TextPartsSchema, message.content);
  return parts.success ? parts.output.map((part) => part.text ?? '').join('') : '';
}

/**
 * The turn-start hint's whole predicate: a fresh ask with no work behind it.
 *
 * Read off the messages the step is about to send, the one thing both backends
 * agree on — and at THIS hook they are the durable history plus the turn-local
 * tail, before the prune and before the dynamic-context weave
 * (prompting/prepare-step.ts runs extensions first), so nothing runtime-authored
 * is in them yet.
 *
 * Two facts, the same two oh-my-pi's eager prelude reads
 * (session/todo-tracker.ts): no assistant message anywhere, so this agent has
 * said nothing here and the shape of the work is still open; and an ask that
 * does not end in `?` or `!`, because a question wants an answer and an
 * exclamation is a correction — neither is a body of work to split. The FIRST
 * user message is the ask: the turn-local tail is appended after it.
 *
 * One predicate covers both of oh-my-pi's two mechanisms. A continuation turn,
 * a background wake and every later turn all carry the assistant side of work
 * that already happened, so none of them fires; a compaction that folded the
 * whole transcript leaves no assistant message either, and the shape of what
 * remains is open again for exactly the reason it was open at session start.
 */
function freshAsk(messages: readonly ModelMessage[]): boolean {
  if (messages.some((message) => message.role === 'assistant')) return false;
  const ask = messages.find((message) => message.role === 'user');
  const text = ask ? askText(ask).trimEnd() : '';
  return text.length > 0 && !text.endsWith('?') && !text.endsWith('!');
}

/**
 * True when a tool result is a failure the model should be able to see as one.
 *
 * The harness discriminator (`success`) is necessary but not sufficient: the
 * `run` tool catches a non-zero exit and RETURNS it as a normal result string
 * (`Error (exit 2)…`), which is exactly the case that motivated this whole
 * mechanism. Reading that text is `isFailingResultText`, which lives next to
 * the renderer that writes the prefix — one definition, shared with the call
 * cards and with evolution's execution verdict.
 */
export function isFailingToolResult(ctx: ToolResultContext): boolean {
  return !ctx.success || isFailingResultText(ctx.result);
}

/** One tool called one way. Hashed rather than stored: an `execute_tools`
 *  program is tens of kilobytes and a turn runs hundreds of steps. */
function callSignature(toolName: string, args: JsonObject): string {
  return `${toolName} ${fnv1a64(stableArgs(args))}`;
}

/** Key-order-independent serialization, so `{a,b}` and `{b,a}` are one call. */
function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isJsonObject(value)) return value;

  const sorted: JsonObject = {};
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  for (const [key, child] of entries) {
    sorted[key] = sortJsonValue(child);
  }
  return sorted;
}

function stableArgs(args: JsonObject): string {
  return JSON.stringify(sortJsonValue(args));
}

function echoArgs(args: JsonObject): string {
  const rendered = stableArgs(args);
  return rendered.length <= ARGS_ECHO_MAX_CHARS
    ? rendered
    : `${rendered.slice(0, ARGS_ECHO_MAX_CHARS)}…`;
}

/**
 * The turn's file-side progress, read once per step boundary.
 *
 * Structural rather than an import of `TurnFileLedger`: the steering object
 * depends on two monotone numbers, not on the ledger's shape. `TurnFileLedger`
 * satisfies it through its own `progress` getter.
 */
export interface TurnProgressInputs {
  /** Distinct paths the turn has read or written. */
  readonly filesTouched: number;
  /** Edits that actually changed a file. */
  readonly editsApplied: number;
}

/** No file work observed — what a caller with no ledger reports, and what a
 *  turn that has touched nothing has. */
const NO_FILE_PROGRESS: TurnProgressInputs = { filesTouched: 0, editsApplied: 0 };

/** One repeated call: what it is, what it answered, and how many times. */
interface RepeatedCall {
  readonly tool: string;
  readonly args: string;
  /** Hash of the last result, so a changed result restarts the streak. */
  resultHash: string;
  count: number;
}

/** One tool's failure streak, with the LAST failing call kept — signature so a
 *  recovery can tell a changed call from a lucky retry, echo so the finding
 *  can say what was failing. */
interface FailureStreak {
  count: number;
  signature: string;
  args: string;
}

export class TurnSteering {
  /** Failure streaks per tool since that tool last succeeded. */
  private readonly failures = new Map<string, FailureStreak>();
  /** Identical calls with an unchanged answer, by call signature. */
  private readonly repeats = new Map<string, RepeatedCall>();
  private delegated = false;
  private fired: { trigger: TurnSteeringTrigger; step: number; tool?: string } | null = null;
  private converted = false;
  /** The turn-start hint's own slot. Separate from {@link fired} because the
   *  hint fires before any reactive trigger can have evidence, and spending the
   *  reactive slot on it would cost the recovery steer on the session's first
   *  turn (see the header). */
  private startFired = false;
  private startConverted = false;
  /** The signature the repeat steer named — anything else is a changed
   *  approach, which is what that steer asked for. Set by that trigger alone;
   *  the other three judge conversion without it (see answersTheSteer). */
  private repeating: string | null = null;
  /** {@link progressScore} at the last step boundary, and how many boundaries
   *  in a row it has been that. -1 so the very first step is a change rather
   *  than a stall against a score of zero. */
  private lastProgress = -1;
  private stalledSteps = 0;

  /** Clear for a new turn. */
  reset(): void {
    this.failures.clear();
    this.repeats.clear();
    this.delegated = false;
    this.fired = null;
    this.converted = false;
    this.startFired = false;
    this.startConverted = false;
    this.repeating = null;
    this.lastProgress = -1;
    this.stalledSteps = 0;
  }

  onToolCall(ctx: ToolCallContext): void {
    const delegating = ctx.toolName === DELEGATION_TOOL;
    if (delegating) this.delegated = true;
    if (this.startFired && delegating) this.startConverted = true;
    if (this.fired && this.answersTheSteer(ctx)) this.converted = true;
  }

  /**
   * A tool result settled. Returns the execution recovery this result just
   * proved, or null on the overwhelmingly common path: a steer-worthy failure
   * streak of this tool, broken by THIS call — a different call of the same
   * tool that ran clean. The same-signature break (the identical call finally
   * worked) is deliberately not a recovery: nothing about the approach
   * changed, so there is nothing to write down.
   */
  onToolResult(ctx: ToolResultContext): RecoveryFinding | null {
    const signature = callSignature(ctx.toolName, ctx.args);
    let recovery: RecoveryFinding | null = null;
    if (isFailingToolResult(ctx)) {
      const streak = this.failures.get(ctx.toolName);
      if (streak) {
        streak.count += 1;
        streak.signature = signature;
        streak.args = echoArgs(ctx.args);
      } else {
        this.failures.set(ctx.toolName, { count: 1, signature, args: echoArgs(ctx.args) });
      }
    } else {
      const streak = this.failures.get(ctx.toolName);
      if (streak && streak.count >= CONSECUTIVE_FAILURES_BEFORE_STEER && signature !== streak.signature) {
        recovery = {
          tool: ctx.toolName,
          failures: streak.count,
          failedArgs: streak.args,
          succeededArgs: echoArgs(ctx.args),
          failedSignature: streak.signature,
        };
      }
      this.failures.delete(ctx.toolName);
    }

    // A repeat is only a repeat while the answer stays the same: a call whose
    // output changed taught the model something, so its streak restarts.
    const resultHash = fnv1a64(ctx.result);
    const seen = this.repeats.get(signature);
    if (seen && seen.resultHash === resultHash) {
      seen.count += 1;
      return recovery;
    }
    this.repeats.set(signature, {
      tool: ctx.toolName, args: echoArgs(ctx.args), resultHash, count: 1,
    });
    return recovery;
  }

  /** The turn's steers and whether each converted — at most two, the turn-start
   *  hint and the one reactive steer, in the order they were spliced. Empty on
   *  a turn that was never steered: no row, `turn_end` being the denominator. */
  snapshot(): TurnSteeringRecord[] {
    const rows: TurnSteeringRecord[] = [];
    if (this.startFired) {
      rows.push({ trigger: 'turn_start_no_delegation', step: 0, converted: this.startConverted });
    }
    if (this.fired) rows.push({ ...this.fired, converted: this.converted });
    return rows;
  }

  /**
   * How far this turn has got, as ONE monotone number.
   *
   * Three counts of firsts, all of them things the harness already computes:
   *
   *   • `repeats.size` — distinct (tool, arguments) calls issued. The repeat
   *     detector's own keyset, read for what it is rather than for what
   *     repeats in it: every entry is a call this turn had not made before. It
   *     is also, for `run`, exactly "distinct commands run".
   *   • `filesTouched` — paths read or written for the first time, off the
   *     turn's file ledger.
   *   • `editsApplied` — edits that actually changed a file. `sed -i` exits 0
   *     whether or not it matched; this is the count that does not.
   *
   * A call whose OUTPUT merely changed is deliberately NOT progress, which is
   * where this measure parts company with the repeat detector beside it: that
   * one asks "did this call teach the model anything", and a `git status` or a
   * `make` whose output differs by a timestamp does. This asks whether the TURN
   * reached anywhere new, and re-running the same command does not — which is
   * exactly the loop shape the identical-output detector cannot see.
   *
   * The known limit, stated rather than hidden: `execute_tools` sends a fresh
   * program almost every step, so its signature diversity always reads as new
   * ground. The harness cannot see inside one tool call; what it CAN see of a
   * codemode turn is the file work, because the inline executor writes to this
   * same ledger. So the trigger is deliberately conservative there — a steer
   * that fires wrongly costs a line of the model's context and its trust in
   * the harness, and neither is worth a guess.
   */
  private progressScore(files: TurnProgressInputs): number {
    return this.repeats.size + files.filesTouched + files.editsApplied;
  }

  /**
   * The step-boundary trigger check: the signal to deliver into THIS step, or
   * null. At most one per step, and at most one REACTIVE one per turn — the
   * first of those to fire owns the turn.
   *
   * Takes the step's own context because the turn-start trigger reads the
   * messages the request is about to carry ({@link freshAsk}); the other
   * four read only the tool traffic this object has been observing.
   *
   * `files` is the turn's file ledger reading, supplied by the caller that owns
   * it (the AgentOrchestrator, which owns both). Absent means no file work was
   * observed, so the trigger runs on tool-call evidence alone.
   */
  steerFor(ctx: PrepareStepContext, files: TurnProgressInputs = NO_FILE_PROGRESS): AgentSignal | null {
    const step = ctx.stepNumber;
    // Sampled on every boundary, including ones where a steer has already
    // fired: this is the turn's own accounting, and letting it drift would
    // make the number meaningless if the trigger order ever changes.
    const score = this.progressScore(files);
    if (score === this.lastProgress) this.stalledSteps += 1;
    else { this.stalledSteps = 0; this.lastProgress = score; }

    if (this.fired) return null;
    const looping = [...this.repeats].find(([, call]) => call.count >= IDENTICAL_CALLS_BEFORE_STEER);
    if (looping) {
      const [signature, call] = looping;
      this.repeating = signature;
      this.fired = { trigger: 'repeated_call', step, tool: call.tool };
      return signal(repeatedCallText(call.tool, call.args, call.count));
    }
    const stuck = [...this.failures].find(([, streak]) => streak.count >= CONSECUTIVE_FAILURES_BEFORE_STEER);
    if (stuck) {
      this.fired = { trigger: 'repeated_failure', step, tool: stuck[0] };
      return signal(repeatedFailureText(stuck[0], stuck[1].count));
    }
    if (this.stalledSteps >= STEPS_WITHOUT_PROGRESS_BEFORE_STEER) {
      this.fired = { trigger: 'no_progress', step };
      return signal(noProgressText(this.stalledSteps));
    }
    if (step >= LONG_TURN_STEPS_BEFORE_STEER && !this.delegated) {
      this.fired = { trigger: 'long_turn_no_delegation', step };
      return signal(longTurnText(step));
    }
    // Last, and only ever at step 0 — where none of the four above can have
    // evidence yet, so a reactive steer that DID fire on this step is about
    // this turn and outranks a hint that is about every turn.
    if (step === 0 && !this.startFired && freshAsk(ctx.messages)) {
      this.startFired = true;
      return signal(turnStartDelegationText());
    }
    return null;
  }

  /** Did this call do the thing the fired steer asked for? Per trigger,
   *  because the steers ask for different things: the repeat steer asks for
   *  anything but the call it named, the progress steer asks for ground the
   *  turn has not covered, and the delegation steers ask for a search. */
  private answersTheSteer(ctx: ToolCallContext): boolean {
    const signature = callSignature(ctx.toolName, ctx.args);
    if (this.fired?.trigger === 'repeated_call') return signature !== this.repeating;
    if (this.fired?.trigger === 'no_progress') return !this.repeats.has(signature);
    return ctx.toolName === DELEGATION_TOOL;
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
