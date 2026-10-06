/**
 * The closed registry `VerifierSpec.kind` resolves against; an unregistered kind is refused as bad_input.
 * Each kind owns its `spec` schema; `spec` is never case-transformed, so `verifierDigest` has one input.
 * Spec: docs/EXPLORATION.md "The closed verifier registry", "Comparability", "The floor", "Refusals".
 */
import * as v from 'valibot';
import {
  SOLUTION_FILE, REFERENCE_SOLVE_DECLARATION,
  execRatioImplementation, preflightRatioHarness, runRatioMeasurement,
} from './exec-ratio';
import { KinuError, refusalOf } from '../obs/error';
import {
  VERIFIER_KINDS,
  type Measurement, type MeasurementContext, type Verifier, type VerifierKind,
  type VerifierSpec,
} from './objective';
import { renderIssues } from '../utils/json';
import type { SwarmRefusal } from './swarm';

// Declared in `objective.ts` beside the field it closes, to avoid an import cycle.
export { VERIFIER_KINDS, type VerifierKind };

/**
 * `kind:'exec-ratio'` takes `RatioProblem` in full, not a corpus name, so the
 * digest covers the contents rather than a label.
 */
const ExecRatioSpecSchema = v.strictObject({
  params: v.record(v.string(), v.pipe(v.number(), v.finite())),
  // Checked at validation, not measurement, so a bad spec fails before a run starts.
  reference: v.pipe(
    v.string(), v.minLength(1),
    v.includes(REFERENCE_SOLVE_DECLARATION,
      'must declare `export function solve(input, oracle)`: the harness calls it by that name'),
  ),
  body: v.pipe(v.string(), v.minLength(1)),
  targetOps: v.pipe(v.number(), v.finite()),
  lowerBoundOps: v.pipe(v.number(), v.finite()),
});

type ExecRatioSpec = v.InferOutput<typeof ExecRatioSpecSchema>;

/** The one registered kind's measurement: a candidate's oracle calls against the reference's, on one instance. */
function execRatioVerifier(problem: ExecRatioSpec): Verifier {
  return async (ctx): Promise<Measurement> => {
    // No catch: a harness that cannot run is a broken instrument and must fault the run, not score a candidate badly.
    const m = await runRatioMeasurement(ctx, problem);
    const measured = { refOps: m.refOps, candOps: m.candOps, refMs: m.refMs, candMs: m.candMs };

    if (m.failure !== null) {
      return { kind: 'unmeasurable', detail: `no usable solution: ${m.failure}`, measured };
    }

    if (!m.correct) {
      return {
        kind: 'unmeasurable',
        detail: `wrong answer at ${String(m.candOps)} oracle calls: correctness gates the `
          + 'measurement, so an incorrect answer has no cost worth comparing however cheap it was',
        measured,
      };
    }

    return {
      kind: 'measured',
      // Raw, in the objective's unit; normalisation happens once in the harness (*Raw units*).
      value: m.candOps,
      detail: `${String(m.candOps)} oracle calls against the reference's ${String(m.refOps)} on the `
        + 'same instance in the same process',
      measured,
    };
  };
}

export interface ResolvedVerifier {
  readonly kind: VerifierKind;
  readonly artifact: string;
  readonly baselineKey: string | null;
  /** Belongs in {@link ObjectiveIdentity}: runs resolving to different code are not comparable. */
  readonly implementation: string;
  readonly verify: Verifier;
}

export function unregisteredKindRefusal(): string {
  return `\`kind\` must be one of: ${VERIFIER_KINDS.join(', ')}. `
    + 'Register a verifier kind, or use one of these.';
}

/** Resolve `kind` alone, without touching `spec`. */
export function registeredVerifierKind(kind: string): VerifierKind | null {
  return VERIFIER_KINDS.find((known) => known === kind) ?? null;
}

export function unregisteredKindRefusalFor(kind: string): SwarmRefusal {
  return {
    reason: 'bad_input',
    error: refusalOf(new KinuError(
      'bad_input',
      `no verifier kind "${kind}" is registered. ${unregisteredKindRefusal()}`,
    )).error,
  };
}

/**
 * Whether the registered instrument can run in this workspace, before a run is accepted: `null` when it can, else the
 * reason. Independent of `spec`, so it is asked before `spec` is reported on.
 */
export async function preflightVerifier(ctx: MeasurementContext): Promise<string | null> {
  return preflightRatioHarness(ctx);
}

/** Resolve a `VerifierSpec` to its instrument, or refuse as a value (never a throw). */
export function resolveVerifier(source: VerifierSpec): ResolvedVerifier | SwarmRefusal {
  const kind = registeredVerifierKind(source.kind);

  if (kind === null) return unregisteredKindRefusalFor(source.kind);
  const parsed = v.safeParse(ExecRatioSpecSchema, source.spec);

  if (!parsed.success) {
    return {
      reason: 'bad_input',
      error: refusalOf(new KinuError(
        'bad_input',
        `\`spec\` does not describe a "${kind}" measurement: ${renderIssues(parsed.issues)}. Every field is `
        + 'required: one that is missing is a quantity the floor and its margin checks '
        + 'would otherwise have to invent.',
      )).error,
    };
  }

  // The digest is produced here, not at import, to keep hashing off the browser bundle's import path.
  return { kind, artifact: SOLUTION_FILE, baselineKey: 'refOps', implementation: execRatioImplementation(), verify: execRatioVerifier(parsed.output) };
}
