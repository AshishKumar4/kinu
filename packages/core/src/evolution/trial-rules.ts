/**
 * The live trial's pure rules (docs/EVOLUTION-REDESIGN.md §5): the arm a cache segment draws, the interval at a look,
 * and the keep and revert decision. No storage: `trials.ts` reads the arms and applies the verdict.
 */
import * as v from 'valibot';
import { parseJsonValue } from '../utils/json';
import type { ARMS } from './artifact-schema';

const DAY_MS = 86_400_000;

const MAX_TRIAL_MS = 14 * DAY_MS;

export const LOOK_EVERY = 10;

const LOOKS = 3;

/** z for a one-sided α of 0.05/3. */
const Z = 2.128;

export type TrialArm = (typeof ARMS)[number];

export interface LiveTrial {
  readonly trialId: string;
  readonly artifactId: string;
  readonly version: number;
  readonly startedAt: number;
  readonly looks: number;
}

/** The arm a turn ran, recorded with it. */
export interface TrialTurn {
  readonly trialId: string;
  readonly segmentId: string;
  readonly arm: TrialArm;
}

/** FNV-1a of trial and segment ids: the same draw on either backend, and on a replay. */
export function drawArm(trialId: string, segmentId: string): TrialArm {
  let hash = 0x811c9dc5;

  for (const char of `${trialId}:${segmentId}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash % 2 === 0 ? 'candidate' : 'incumbent';
}

interface Interval { readonly diff: number; readonly lo: number; readonly hi: number }

export const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

const variance = (xs: readonly number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);

  return xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1);
};

/** Candidate minus incumbent, Welch's normal interval at the trial's z. */
function armInterval(candidate: readonly number[], incumbent: readonly number[]): Interval {
  const diff = mean(candidate) - mean(incumbent);
  const se = Math.sqrt(variance(candidate) / Math.max(1, candidate.length) + variance(incumbent) / Math.max(1, incumbent.length));

  return { diff, lo: diff - Z * se, hi: diff + Z * se };
}

const VerdictSchema = v.object({
  decision: v.picklist(['kept', 'reverted']),
  why: v.string(),
  segments: v.object({ candidate: v.number(), incumbent: v.number() }),
  satisfaction: v.object({ diff: v.number(), lo: v.number(), hi: v.number() }),
  corrected: v.object({ candidate: v.number(), incumbent: v.number() }),
  errors: v.object({ diff: v.number(), lo: v.number(), hi: v.number() }),
  steps: v.object({ diff: v.number(), lo: v.number(), hi: v.number() }),
});

export type TrialVerdict = v.InferOutput<typeof VerdictSchema>;

export function parseTrialVerdict(text: string): TrialVerdict {
  return v.parse(VerdictSchema, parseJsonValue(text));
}

export interface ArmTurns { readonly scores: number[]; readonly corrected: number[]; readonly errors: number[]; readonly steps: number[]; readonly segments: number }

/**
 * The §5 rules at a look: keep when satisfaction's lower bound clears 0, `corrected` has not risen and neither
 * guardrail is higher with confidence; revert when satisfaction's upper bound is below 0 or a guardrail is higher with
 * confidence, at the last look undecided, or after 14 days. Null: not yet decided.
 */
export function trialDecision(candidate: ArmTurns, incumbent: ArmTurns, trial: LiveTrial, now: number): TrialVerdict | null {
  const look = Math.floor(Math.min(candidate.segments, incumbent.segments) / LOOK_EVERY);
  const expired = now - trial.startedAt >= MAX_TRIAL_MS;

  if (look <= trial.looks && !expired) return null;
  const satisfaction = armInterval(candidate.scores, incumbent.scores);
  const errors = armInterval(candidate.errors, incumbent.errors);
  const steps = armInterval(candidate.steps, incumbent.steps);
  const corrected = { candidate: mean(candidate.corrected), incumbent: mean(incumbent.corrected) };
  const guardrail = [errors.lo > 0 && 'tool errors rose', steps.lo > 0 && 'steps per turn rose'].find((why) => why !== false) ?? null;
  const numbers = { segments: { candidate: candidate.segments, incumbent: incumbent.segments }, satisfaction, corrected, errors, steps };
  const decided = (decision: 'kept' | 'reverted', why: string): TrialVerdict => ({ decision, why, ...numbers });

  if (look > trial.looks) {
    if (guardrail !== null) return decided('reverted', guardrail);

    if (satisfaction.hi < 0) return decided('reverted', 'satisfaction fell');

    if (satisfaction.lo > 0 && corrected.candidate <= corrected.incumbent) return decided('kept', 'satisfaction rose');

    if (look >= LOOKS) return decided('reverted', `no decision at ${String(LOOKS * LOOK_EVERY)} segments per arm`);
  }

  return expired ? decided('reverted', 'no decision in 14 days') : null;
}

