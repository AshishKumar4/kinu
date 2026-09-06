/**
 * The registry `VerifierSpec.kind` is CLOSED over, and the resolution that makes
 * *The closed verifier registry*'s one real guard exist.
 *
 * The registry rejects unregistered kinds as bad_input before a run starts.
 * A caller cannot substitute an invented script such as `scripts/<name>.py`.
 * The tool surface accepts registered kinds only, so a refusal names those kinds.
 *
 * WHY EACH KIND OWNS A SPEC SCHEMA. Closing `kind` implies a PER-KIND `spec` schema
 * or the boundary validates that the instrument is JSON and nothing about the
 * instrument. A `spec` that drops `lowerBoundOps` leaves the floor nowhere to live
 * and *Floor margin*'s C1/C2 with no input, so it is refused HERE, naming the field,
 * rather than surfacing as a measurement of something else.
 *
 * WHY `spec` IS NOT TRANSFORMED. `objective`'s wire form is snake_case (*Wire form*) and
 * these fields are camelCase. That is not an inconsistency: `spec` is OPAQUE to the
 * objective's naming convention, because the convention governs the fields the
 * specification declares and not the interior of a payload whose schema the
 * registered kind owns. If anything transformed `spec`, `verifierDigest` would
 * differ depending on which side of the transform it was computed on —
 * *Comparability*'s own failure mode reached through a naming convention. With no
 * transform there are not two sides.
 *
 * WHY IDENTITY CARRIES AN IMPLEMENTATION DIGEST. `argumentDigest({kind, spec})` does
 * not capture WHICH code `kind` resolved to, so two runs whose kind resolves to
 * different implementations would be pooled as comparable and the store could not
 * tell. {@link ResolvedVerifier.implementation} is that missing half.
 *
 * Specified by docs/EXPLORATION.md — "The closed verifier registry",
 * "Comparability", "The floor" and "Refusals".
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

/**
 * The vocabulary {@link VERIFIER_KINDS} closes and the implementations behind it are
 * deliberately in two files. The set is re-exported here because this is where a
 * reader looks for it, and it is DECLARED in `objective.ts` beside the field it
 * closes so {@link swarmValidity} can check membership at call time without closing an
 * import cycle.
 */
export { VERIFIER_KINDS, type VerifierKind };

/**
 * What `kind:'exec-ratio'` requires of its `spec` — `RatioProblem` in FULL rather
 * than a pointer at a corpus entry.
 *
 * Full because *Comparability* makes the digest the comparability key on the grounds
 * that *"a name is a claim the caller can get wrong"*: a `spec` naming
 * `hard-majority-vote` would digest a label whose contents can change underneath it,
 * which is the silent-recomparison failure the digest exists to prevent. It costs
 * nothing to send this way — `RatioProblem` is already fully data, every field
 * JSON-serialisable, not one closure.
 *
 * `strictObject` for the reason the tool input is strict: a key this instrument does
 * not read is a caller asking for something that would be accepted and ignored.
 */
const ExecRatioSpecSchema = v.strictObject({
  params: v.record(v.string(), v.pipe(v.number(), v.finite())),
  // The declaration the harness converts. Checked HERE, with the other field
  // complaints, because it used to be enforced only at measurement time — so a
  // caller iterating on its spec passed validation, started a run, and learned
  // about this requirement from a faulted baseline one round trip later. A rule
  // the schema can state is a rule the schema should state.
  reference: v.pipe(
    v.string(), v.minLength(1),
    v.includes(REFERENCE_SOLVE_DECLARATION,
      'must declare `export function solve(input, oracle)` — the harness calls it by that name'),
  ),
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
   * *Measured baseline* requires it measured on the workspace as found and forbids a
   * caller supplying one. `exec-ratio` satisfies that in its strongest form — the
   * reference runs first and unbounded on the very instance the candidate will see —
   * so the baseline arrives with every measurement instead of costing a separate
   * pass, and naming the key is what lets a caller read it without knowing the kind.
   */
  readonly baselineKey: string | null;
  /** The instrument's own content digest. *Comparability*'s identity, completed.
   *
   *  A producer, not a string: a digest is computed from source bytes, and a
   *  registry entry is built at module load — in a barrel the browser bundle
   *  imports. Resolving it here is what keeps the hash off the import path. */
  readonly implementation: () => string;
  /**
   * Can this instrument run in the given workspace AT ALL, independent of any
   * `spec`? `null` when it can, otherwise why not, in the executor's own words.
   *
   * Separate from `bind` because the two answer different questions and a caller
   * can only fix one of them. A `spec` complaint is worth reporting because
   * correcting it leads somewhere; an instrument that cannot run in this
   * workspace makes every `spec` irrelevant, and reporting the `spec` first is
   * what sent a model iterating on its fields before it hit the wall.
   */
  readonly preflight: (ctx: MeasurementContext) => Promise<string | null>;
  /** The instrument bound to this `spec`, or the fields this kind rejected. */
  readonly bind: (spec: JsonValue) => { readonly verify: Verifier } | { readonly issues: string };
}

const EXEC_RATIO: VerifierKindEntry = {
  artifact: SOLUTION_FILE,
  baselineKey: 'refOps',
  implementation: execRatioImplementation,
  preflight: preflightRatioHarness,
  bind: (spec) => {
    const parsed = v.safeParse(ExecRatioSpecSchema, spec);
    // Named fields, not a shape complaint: the caller has to know WHICH one.
    if (!parsed.success) return { issues: renderIssues(parsed.issues) };
    const problem = parsed.output;
    return {
      verify: async (ctx): Promise<Measurement> => {
        // No catch: a harness that could not run is a BROKEN INSTRUMENT and must fault
        // the run rather than come back as a candidate that scored badly — *The closed
        // verifier registry*. The three things a CANDIDATE can do wrong arrive as
        // fields below.
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
          // happens once, from the measured baseline and the declared target (*Raw units*).
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

/** The one-imperative refusal *Refusals* allows for an unregistered kind. It does
 *  not offer the closure arm, which this surface cannot reach. */
export function unregisteredKindRefusal(): string {
  return `\`kind\` must be one of: ${VERIFIER_KINDS.join(', ')}. `
    + 'Register a verifier kind, or use one of these.';
}

/**
 * Resolve `kind` alone — membership, without touching `spec`.
 *
 * Split out because the accept path needs the kind BEFORE it validates the spec:
 * knowing which instrument was named is what lets it ask whether that instrument
 * can run here at all. `null` when the name is nobody's; the refusal is built by
 * {@link unregisteredKindRefusalFor} so the message has one spelling.
 */
export function registeredVerifierKind(kind: string): VerifierKind | null {
  return VERIFIER_KINDS.find((known) => known === kind) ?? null;
}

/** The refusal for a kind nobody registered, as a value — never a throw. */
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
 * Ask a registered instrument whether it can run in this workspace. `null` when it
 * can, otherwise why not.
 *
 * ONE call, before a run is accepted. What it replaces: a model discovering the
 * answer from faulted baselines, one throw per turn-step, having first been sent
 * round the `spec` schema — measured at five of ten steps on a production turn,
 * which is what cut that turn short.
 */
export async function preflightVerifier(
  kind: VerifierKind, ctx: MeasurementContext,
): Promise<string | null> {
  return ENTRIES[kind].preflight(ctx);
}

/**
 * Resolve a `VerifierSpec` to the instrument it names, or refuse.
 *
 * This function IS *The closed verifier registry*'s guard: a name nobody registered
 * does not resolve, so the run is refused before it can measure anything, let alone
 * publish it. The refusal is a VALUE and never a throw — the caller's next move is to
 * correct the call.
 */
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
