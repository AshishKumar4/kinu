/**
 * The registry `VerifierSpec.kind` is CLOSED over, and the resolution that makes
 * §3.4's one real guard exist.
 *
 * WHY A REGISTRY AND NOT A STRING. `objective.ts` says "a registered verifier kind"
 * and named no registry, no membership rule and no refusal for an unregistered one.
 * Under that open reading `kind` is a free string — which is a fabricated script
 * wearing a type, exactly the `scripts/simulate_conversion.py` a model invented
 * unprompted — and §3.4's guard *"a fabricated script cannot resolve, so the run
 * faults before it can publish"* becomes advisory by §3.8's own argument that a rule
 * firing on a MISSING field cannot fire on a fabricated one. So membership is a
 * closed set, an unregistered kind is a call-time `bad_input` naming the registered
 * ones, and the refusal deliberately does NOT offer *"or pass a closure"*: the
 * closure arm of `VerifierSource` is unreachable from the tool surface, and offering
 * an unreachable remedy is worse than offering none.
 *
 * WHY EACH KIND OWNS A SPEC SCHEMA. Closing `kind` implies a PER-KIND `spec` schema
 * or the boundary validates that the instrument is JSON and nothing about the
 * instrument. A `spec` that drops `lowerBoundOps` leaves §4's floor nowhere to live
 * and §4.5's C1/C2 with no input, so it is refused HERE, naming the field, rather
 * than surfacing as a measurement of something else.
 *
 * WHY `spec` IS NOT TRANSFORMED. `objective`'s wire form is snake_case (§2.2) and
 * these fields are camelCase. That is not an inconsistency: `spec` is OPAQUE to the
 * objective's naming convention, because the convention governs the fields the
 * specification declares and not the interior of a payload whose schema the
 * registered kind owns. If anything transformed `spec`, `verifierDigest` would
 * differ depending on which side of the transform it was computed on — §5.1's own
 * failure mode reached through a naming convention. With no transform there are not
 * two sides.
 *
 * WHY IDENTITY CARRIES AN IMPLEMENTATION DIGEST. `argumentDigest({kind, spec})` does
 * not capture WHICH code `kind` resolved to, so two runs whose kind resolves to
 * different implementations would be pooled as comparable and the store could not
 * tell. {@link ResolvedVerifier.implementation} is that missing half.
 */
import * as v from 'valibot';
import { SOLUTION_FILE, execRatioImplementation, runRatioMeasurement } from './exec-ratio';
import { ProteusError, refusalOf } from '../obs/error';
import type { Measurement, Verifier, VerifierSpec } from './objective';
import { renderIssues, type JsonValue } from '../utils/json';
import type { SwarmRefusal } from './swarm';

/**
 * Every verifier kind that resolves. The set `VerifierSpec.kind` is closed over, and
 * the list a refusal prints.
 *
 * One member, and that is a statement rather than a stub: a kind is a real
 * instrument with a real spec schema, and the corpus that pays for this one
 * (`exec-ratio`) is the only measurement substrate the tree currently owns. A second
 * member arrives with its implementation, not before it.
 */
export const VERIFIER_KINDS = ['exec-ratio'] as const;

export type VerifierKind = (typeof VERIFIER_KINDS)[number];

/**
 * What `kind:'exec-ratio'` requires of its `spec` — `RatioProblem` in FULL rather
 * than a pointer at a corpus entry.
 *
 * Full because §5.1 makes the digest the comparability key on the grounds that *"a
 * name is a claim the caller can get wrong"*: a `spec` naming `hard-majority-vote`
 * would digest a label whose contents can change underneath it, which is the
 * silent-recomparison failure the digest exists to prevent. It costs nothing to send
 * this way — `RatioProblem` is already fully data, every field JSON-serialisable,
 * not one closure.
 *
 * `strictObject` for the reason the tool input is strict: a key this instrument does
 * not read is a caller asking for something that would be accepted and ignored.
 */
const ExecRatioSpecSchema = v.strictObject({
  params: v.record(v.string(), v.pipe(v.number(), v.finite())),
  reference: v.pipe(v.string(), v.minLength(1)),
  body: v.pipe(v.string(), v.minLength(1)),
  targetOps: v.pipe(v.number(), v.finite()),
  lowerBoundOps: v.pipe(v.number(), v.finite()),
});

/**
 * One registered kind, as the registry holds it: where a candidate must be written
 * for this kind to measure one, which quantity its measurement reports as the run's
 * own baseline, its content identity, and the ONE member that turns a `spec` into an
 * instrument.
 *
 * `bind` rather than a schema beside a builder, because the two are only ever used
 * together and splitting them made the spec's type leak into the registry's own
 * shape: every entry then had to agree on one spec type, which is exactly what a
 * per-kind schema is not.
 */
interface VerifierKindEntry {
  /**
   * The path a candidate's artifact must occupy for this kind to measure it.
   *
   * Declared per kind rather than assumed by the runner: where the artifact lives is
   * the instrument's convention, and a runner that guessed would measure the
   * workspace as found while reporting a candidate's score.
   */
  readonly artifact: string;
  /**
   * The key inside `MeasuredValue.measured` carrying the MEASURED BASELINE, or null
   * for a kind that does not measure one.
   *
   * §2.3 requires the baseline to be measured on the workspace as found and forbids
   * a caller supplying one. `exec-ratio` satisfies that in its strongest form — the
   * reference runs first and unbounded on the very instance the candidate will see —
   * so the baseline arrives with every measurement instead of costing a separate
   * pass, and naming the key is what lets a caller read it without knowing the kind.
   */
  readonly baselineKey: string | null;
  /** The instrument's own content digest. §5.1's identity, completed.
   *
   *  A producer, not a string: a digest is computed from source bytes, and a
   *  registry entry is built at module load — in a barrel the browser bundle
   *  imports. Resolving it here is what keeps the hash off the import path. */
  readonly implementation: () => string;
  /** The instrument bound to this `spec`, or the fields this kind rejected. */
  readonly bind: (spec: JsonValue) => { readonly verify: Verifier } | { readonly issues: string };
}

const EXEC_RATIO: VerifierKindEntry = {
  artifact: SOLUTION_FILE,
  baselineKey: 'refOps',
  implementation: execRatioImplementation,
  bind: (spec) => {
    const parsed = v.safeParse(ExecRatioSpecSchema, spec);
    // Named fields, not a shape complaint: the caller has to know WHICH one.
    if (!parsed.success) return { issues: renderIssues(parsed.issues) };
    const problem = parsed.output;
    return {
      verify: async (ctx): Promise<Measurement> => {
        // No catch: a harness that could not run is a BROKEN INSTRUMENT and must fault
        // the run rather than come back as a candidate that scored badly (§3.4). The
        // three things a CANDIDATE can do wrong arrive as fields below.
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
          // RAW, in the objective's own unit. Normalisation is the harness's job and
          // happens once, from the measured baseline and the declared target (§3.5).
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

/** A `kind` that resolved: the instrument, and everything a caller needs to use and
 *  record it without knowing which kind it got. */
export interface ResolvedVerifier {
  readonly kind: VerifierKind;
  readonly artifact: string;
  readonly baselineKey: string | null;
  /** Belongs in {@link ObjectiveIdentity} beside the spec digest: two runs whose
   *  kind resolved to different code are not comparable. */
  readonly implementation: string;
  readonly verify: Verifier;
}

/** The refusal §7.2's one-imperative rule allows for an unregistered kind. It does
 *  not offer the closure arm, which this surface cannot reach. */
export function unregisteredKindRefusal(): string {
  return `\`kind\` must be one of: ${VERIFIER_KINDS.join(', ')}. `
    + 'Register a verifier kind, or use one of these.';
}

/**
 * Resolve a `VerifierSpec` to the instrument it names, or refuse.
 *
 * This function IS §3.4's guard: a name nobody registered does not resolve, so the
 * run is refused before it can measure anything, let alone publish it. The refusal
 * is a VALUE and never a throw — the caller's next move is to correct the call.
 */
export function resolveVerifier(source: VerifierSpec): ResolvedVerifier | SwarmRefusal {
  const kind = VERIFIER_KINDS.find((registered) => registered === source.kind);
  if (!kind) {
    return {
      reason: 'bad_input',
      error: refusalOf(new ProteusError(
        'bad_input',
        `no verifier kind "${source.kind}" is registered. ${unregisteredKindRefusal()}`,
      )).error,
    };
  }
  const entry = ENTRIES[kind];
  const bound = entry.bind(source.spec);
  if ('issues' in bound) {
    return {
      reason: 'bad_input',
      error: refusalOf(new ProteusError(
        'bad_input',
        `\`spec\` does not describe a "${kind}" measurement: ${bound.issues}. Every field is `
        + 'required — one that is missing is a quantity the floor and the §4.5 checks would '
        + 'otherwise have to invent.',
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
