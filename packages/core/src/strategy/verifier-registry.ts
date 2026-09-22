/**
 * The closed registry `VerifierSpec.kind` resolves against: an unregistered kind
 * is refused as bad_input before a run starts. Each kind owns its `spec` schema.
 * `spec` is never case-transformed, so `verifierDigest` has one input.
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
import { renderIssues, type JsonValue } from '../utils/json';
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
      'must declare `export function solve(input, oracle)` — the harness calls it by that name'),
  ),
  body: v.pipe(v.string(), v.minLength(1)),
  targetOps: v.pipe(v.number(), v.finite()),
  lowerBoundOps: v.pipe(v.number(), v.finite()),
});

/** One registered kind as the registry holds it. */
interface VerifierKindEntry {
  /** The path a candidate's artifact must occupy for this kind to measure it. */
  readonly artifact: string;
  /** The key in `MeasuredValue.measured` carrying the measured baseline, or null. */
  readonly baselineKey: string | null;
  /** The instrument's content digest. A producer, not a string, to keep hashing
     *  off the import path of the browser bundle. */
  readonly implementation: () => string;
  /**
     * Whether this instrument can run in the workspace at all, independent of `spec`;
     * `null` when it can, else the reason. Checked before `spec` is reported on.
     */
  readonly preflight: (ctx: MeasurementContext) => Promise<string | null>;
  readonly bind: (spec: JsonValue) => { readonly verify: Verifier } | { readonly issues: string };
}

const EXEC_RATIO: VerifierKindEntry = {
  artifact: SOLUTION_FILE,
  baselineKey: 'refOps',
  implementation: execRatioImplementation,
  preflight: preflightRatioHarness,
  bind: (spec) => {
    const parsed = v.safeParse(ExecRatioSpecSchema, spec);

    if (!parsed.success) return { issues: renderIssues(parsed.issues) };
    const problem = parsed.output;

    return {
      verify: async (ctx): Promise<Measurement> => {
        // No catch: a harness that cannot run is a broken instrument and must fault
                // the run, not score a candidate badly.
        const m = await runRatioMeasurement(ctx, problem);
        const measured = { refOps: m.refOps, candOps: m.candOps, refMs: m.refMs, candMs: m.candMs };

        if (m.failure !== null) {
          return { kind: 'unmeasurable', detail: `no usable solution: ${m.failure}`, measured };
        }

        if (!m.correct) {
          return {
            kind: 'unmeasurable',
            detail: `wrong answer at ${String(m.candOps)} oracle calls — correctness gates the `
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
      },
    };
  },
};

const ENTRIES = { 'exec-ratio': EXEC_RATIO } satisfies Record<VerifierKind, VerifierKindEntry>;

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

/** Ask a registered instrument whether it can run in this workspace, before a run is accepted. */
export async function preflightVerifier(
  kind: VerifierKind, ctx: MeasurementContext,
): Promise<string | null> {
  return ENTRIES[kind].preflight(ctx);
}

/** Resolve a `VerifierSpec` to its instrument, or refuse as a value (never a throw). */
export function resolveVerifier(source: VerifierSpec): ResolvedVerifier | SwarmRefusal {
  const kind = registeredVerifierKind(source.kind);

  if (kind === null) return unregisteredKindRefusalFor(source.kind);
  const entry = ENTRIES[kind];
  const bound = entry.bind(source.spec);

  if ('issues' in bound) {
    return {
      reason: 'bad_input',
      error: refusalOf(new KinuError(
        'bad_input',
        `\`spec\` does not describe a "${kind}" measurement: ${bound.issues}. Every field is `
        + 'required — one that is missing is a quantity the floor and its margin checks '
        + 'would otherwise have to invent.',
      )).error,
    };
  }

  return {
    kind,
    artifact: entry.artifact,
    baselineKey: entry.baselineKey,
    implementation: entry.implementation(),
    verify: bound.verify,
  };
}
