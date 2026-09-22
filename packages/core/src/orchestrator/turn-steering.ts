/**
 * Mechanical in-turn steering: repeated_call, repeated_failure, no_progress, in priority order.
 * One steer per turn, always a hint; conversion is recorded in the `turn_steering` run event.
 * Thresholds are constants, not configuration, so bench runs stay comparable.
 */

import type { TurnSteeringRecord, TurnSteeringTrigger } from '../events/types';
import type { PrepareStepContext, ToolCallContext, ToolResultContext } from '../extension';
import type { AgentSignal } from '../types/signals';
import type { RecoveryFinding } from '../evolution/recovery';
import { fnv1a64 } from '../utils/fnv1a';
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from '../utils/json';

export const IDENTICAL_CALLS_BEFORE_STEER = 3;

export const CONSECUTIVE_FAILURES_BEFORE_STEER = 3;

/** Steps are the clock, not tokens: a step count is identical across providers and reproducible. */
export const STEPS_WITHOUT_PROGRESS_BEFORE_STEER = 12;

const ARGS_ECHO_MAX_CHARS = 200;

/** The model must never read a harness steer as something the user typed. */
export const TURN_STEERING_HEADER =
  '[Runtime steering — a mechanical nudge from the Kinu harness, not written by the user.]';

function repeatedCallText(tool: string, args: string, calls: number): string {
  return `\`${tool}\` has run ${calls} times with the same arguments and returned the same output every time — ${args}. `
    + 'Repeating it cannot tell you anything new; the output you already have is everything it has to say. '
    + 'Read that output again for the actual cause, or change the approach: a different command, a different file, '
    + 'a different approach. '
    + 'This is a hint, not an instruction — push on if you know why the repeat is right.';
}

function repeatedFailureText(tool: string, failures: number): string {
  return `\`${tool}\` has failed ${failures} times in a row. Running the same approach again is the least likely thing to work: `
    + 'read the failure text for the actual cause and change something real — a different command, a different file, '
    + 'a different approach. '
    + 'This is a hint, not an instruction — push on if you already know the fix.';
}

function noProgressText(steps: number): string {
  return `${steps} steps in a row with nothing new in any of them: every call was one this turn had already made, `
    + 'no file was touched for the first time, and no edit landed. '
    + 'Steps that succeed are not the same as steps that get somewhere — this turn is spending and not moving. '
    + 'Stop and say what is actually blocking you, then change something real: a different file, a different command, '
    + 'a different approach. '
    + 'This is a hint, not an instruction — push on if the ground you are re-covering is the right ground.';
}

/** SDK invocation status is independent of the value a successful tool returned. */
export function isFailingToolResult(ctx: ToolResultContext): boolean {
  return !ctx.success;
}

/** Hashed rather than stored: an `eval` program can be large. */
function callSignature(toolName: string, args: JsonObject): string {
  return `${toolName}${fnv1a64(stableArgs(args))}`;
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

/** Structural so steering depends on two monotone numbers, not on `TurnFileLedger`'s shape. */
export interface TurnProgressInputs {
  readonly filesTouched: number;
  readonly editsApplied: number;
}

const NO_FILE_PROGRESS: TurnProgressInputs = { filesTouched: 0, editsApplied: 0 };

interface RepeatedCall {
  readonly tool: string;
  readonly args: string;
  resultHash: string;
  count: number;
}

/** Keeps the last failing call's signature so a recovery can tell a changed call from a lucky retry. */
interface FailureStreak {
  count: number;
  signature: string;
  args: string;
}

export class TurnSteering {
  private readonly failures = new Map<string, FailureStreak>();
  private readonly repeats = new Map<string, RepeatedCall>();
  private fired: { trigger: TurnSteeringTrigger; step: number; tool?: string } | null = null;
  private converted = false;
  private namedCall: string | null = null;
  /** -1 so the first step counts as a change, not a stall. */
  private lastProgress = -1;
  private stalledSteps = 0;

  reset(): void {
    this.failures.clear();
    this.repeats.clear();
    this.fired = null;
    this.converted = false;
    this.namedCall = null;
    this.lastProgress = -1;
    this.stalledSteps = 0;
  }

  onToolCall(ctx: ToolCallContext): void {
    if (this.fired && this.answersTheSteer(ctx)) this.converted = true;
  }

  /** Returns a recovery only when a steer-worthy failure streak is broken by a different call
   *  (evolution/recovery.ts); the same call finally working is a lucky retry, not a recovery. */
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

    // A changed output restarts the streak.
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

  snapshot(): TurnSteeringRecord[] {
    if (this.fired) return [{ ...this.fired, converted: this.converted }];

    return [];
  }

  /** Monotone count of firsts. A changed output is not progress; `eval` always reads as new ground,
   *  so the trigger is deliberately conservative there. */
  private progressScore(files: TurnProgressInputs): number {
    return this.repeats.size + files.filesTouched + files.editsApplied;
  }

  steerFor(ctx: PrepareStepContext, files: TurnProgressInputs = NO_FILE_PROGRESS): AgentSignal | null {
    const step = ctx.stepNumber;
    // Sampled even after a steer fired so the accounting never drifts.
    const score = this.progressScore(files);

    if (score === this.lastProgress) this.stalledSteps += 1;
    else { this.stalledSteps = 0; this.lastProgress = score; }

    if (this.fired) return null;
    const looping = [...this.repeats].find(([, call]) => call.count >= IDENTICAL_CALLS_BEFORE_STEER);

    if (looping) {
      const [signature, call] = looping;
      this.namedCall = signature;
      this.fired = { trigger: 'repeated_call', step, tool: call.tool };

      return signal(repeatedCallText(call.tool, call.args, call.count));
    }

    const stuck = [...this.failures].find(([, streak]) => streak.count >= CONSECUTIVE_FAILURES_BEFORE_STEER);

    if (stuck) {
      this.namedCall = stuck[1].signature;
      this.fired = { trigger: 'repeated_failure', step, tool: stuck[0] };

      return signal(repeatedFailureText(stuck[0], stuck[1].count));
    }

    if (this.stalledSteps >= STEPS_WITHOUT_PROGRESS_BEFORE_STEER) {
      this.fired = { trigger: 'no_progress', step };

      return signal(noProgressText(this.stalledSteps));
    }

    return null;
  }

  private answersTheSteer(ctx: ToolCallContext): boolean {
    const signature = callSignature(ctx.toolName, ctx.args);

    if (this.fired?.trigger === 'no_progress') return !this.repeats.has(signature);

    return signature !== this.namedCall;
  }
}

/** User-role splice: a system message between steps is not portable across providers. */
function signal(text: string): AgentSignal {
  return {
    kind: 'turn_steering',
    text: `${TURN_STEERING_HEADER}\n\n${text}`,
  };
}
