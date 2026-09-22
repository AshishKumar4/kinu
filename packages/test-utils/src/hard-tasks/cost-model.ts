/**
 * Scores metered-oracle measurements (from core `strategy/exec-ratio.ts`) on [0,1] for the eval ladder and
 * assembles tasks. `MeasuredValue.value` stays raw (docs/EXPLORATION.md, *Raw units*); normalisation lives here.
 */
import {
  REFERENCE_FILE,
  SOLUTION_FILE,
  runRatioMeasurement,
  type RatioMeasurement,
  type RatioProblem,
} from '@kinu.run/core';
import type { VerifierContext } from '../eval-outcome';

/** A scored ratio, carrying every quantity the score was derived from. */
export interface RatioScore {
  /** Normalized to [0,1], ready for `ratioOutcome`. */
  readonly score: number;
  readonly detail: string;
  readonly measured: Readonly<Record<string, number>>;
}

/**
 * Log-scale score on [0,1]: 0 = no better than the reference, 1 = reached the target. Clamped here because
 * `ratioOutcome` throws out of range; raw counts survive in `measured`.
 */
export function scoreRatio(m: RatioMeasurement, problem: RatioProblem): RatioScore {
  const measured = {
    refOps: m.refOps, candOps: m.candOps, targetOps: problem.targetOps,
    lowerBoundOps: problem.lowerBoundOps, refMs: m.refMs, candMs: m.candMs,
  };

  if (m.refOps <= problem.targetOps) {
    throw new Error(
      `reference spent ${String(m.refOps)} oracle calls but the target is `
      + `${String(problem.targetOps)} — a target at or below the measured reference leaves `
      + 'no range to score on, so this task cannot be scored at all',
    );
  }

  if (m.failure !== null) {
    return { score: 0, detail: `no usable solution: ${m.failure}`, measured };
  }

  if (!m.correct) {
    return {
      score: 0,
      detail: `wrong answer at ${String(m.candOps)} oracle calls — correctness gates the ratio, `
        + 'so an incorrect answer scores zero however cheap it was',
      measured,
    };
  }

  if (m.candOps < problem.lowerBoundOps) {
    return {
      score: 0,
      detail: `${String(m.candOps)} oracle calls is below this problem's information-theoretic `
        + `floor of ${String(problem.lowerBoundOps)}, so the answer cannot have been derived `
        + 'through the oracle — the measurement channel was bypassed',
      measured,
    };
  }

  const span = Math.log(m.refOps) - Math.log(problem.targetOps);
  const raw = (Math.log(m.refOps) - Math.log(Math.max(m.candOps, 1))) / span;
  const score = Math.min(1, Math.max(0, raw));

  return {
    score,
    detail: `${String(m.candOps)} oracle calls vs reference ${String(m.refOps)} `
      + `(${(m.refOps / Math.max(m.candOps, 1)).toFixed(2)}x), target ${String(problem.targetOps)} `
      + `→ log-scale score ${score.toFixed(4)}`
      + (raw > 1 ? ` (clamped from ${raw.toFixed(4)}: target beaten)` : '')
      + (raw < 0 ? ` (clamped from ${raw.toFixed(4)}: worse than the reference)` : ''),
    measured,
  };
}

/** A file placed in the agent's workspace before the turn begins. */
export interface SeedFile {
  readonly path: string;
  readonly content: string;
}

/** One hard task: prompt, seed files and verifier together, so prompt numbers match the scorer. */
export interface HardTask {
  readonly id: string;
  readonly prompt: string;
  readonly tags: readonly string[];
  readonly seed: readonly SeedFile[];
  /** Instance parameters, target and certificate floor, kept so a stored score can be re-derived. */
  readonly problem: RatioProblem;
  /** Ground truth, as code. Pure over `(vfs, exec)`, handed no model. */
  readonly verify: (ctx: VerifierContext) => Promise<RatioScore>;
}

/** Assemble a measured-ratio task from its problem content. */
export function ratioTask(spec: {
  readonly id: string;
  readonly tags: readonly string[];
  /** The problem statement, minus the boilerplate this function appends. */
  readonly brief: string;
  /** The exported signature the solution must have, quoted in the prompt. */
  readonly signature: string;
  readonly problem: RatioProblem;
}): HardTask {
  const { problem } = spec;

  return {
    id: spec.id,
    tags: spec.tags,
    prompt: [
      spec.brief.trim(),
      '',
      `Write ${SOLUTION_FILE} exporting exactly this signature:`,
      '',
      `    ${spec.signature}`,
      '',
      `${REFERENCE_FILE} in this workspace is a CORRECT but slow reference for the same`,
      'problem. Read it: it shows the exact data shape and the exact oracle contract.',
      '',
      'HOW YOU ARE SCORED. Your solution is run on the same instance as the reference,',
      'and the only thing measured is HOW MANY ORACLE CALLS you spend to get the right',
      `answer. The target is ${String(problem.targetOps)} oracle calls, at which you score 1.0.`,
      'Matching the reference scores 0.0 and the scale between them is logarithmic, so',
      'a partial improvement earns partial credit. A wrong answer scores 0.0 whatever it',
      'cost. You may not read or modify the oracle, and the elements carry no usable',
      'value of their own — the oracle is the only channel to the data.',
      '',
      `Run \`node ${REFERENCE_FILE}\` style checks however you like, but the graded run is`,
      `ours: only ${SOLUTION_FILE} is read.`,
      '',
      `${SOLUTION_FILE} already exists as a stub that throws, and the file tool refuses a`,
      'blind overwrite: read it before you replace it. That is plumbing rather than part of',
      'the problem, and it is the same for every attempt.',
    ].join('\n'),
    seed: [
      { path: REFERENCE_FILE, content: problem.reference },
      {
        path: SOLUTION_FILE,
        content: [
          '// Your solution. Replace the body: as shipped it throws, which scores 0.0.',
          `export ${spec.signature.replace(/^export\s+/, '')} {`,
          '  throw new Error("not implemented");',
          '}',
        ].join('\n') + '\n',
      },
    ],
    problem,
    verify: async (ctx) => scoreRatio(await runRatioMeasurement(ctx, problem), problem),
  };
}
