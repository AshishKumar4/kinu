/**
 * The WIRE form of a swarm call's two structured fields, and the mapping onto the
 * types the search is written over.
 *
 * WHY A MAPPING EXISTS AT ALL. `strategy/objective.ts` and `strategy/swarm.ts` are
 * camelCase because that is correct TypeScript. This surface is snake_case —
 * `merge_strategy`, `budget_usd`, `wall_clock_ms`, `keep_history`, `event_id` — so
 * `objective`'s wire form is snake_case too and the mapping is part of the contract
 * rather than an implementation detail. An `objective` that were the one camelCase
 * island in a snake_case action would make camelCase-for-snake_case the EXPECTED
 * model error rather than an exotic one, on the surface where that error is already
 * measured: a model spelling `budgetUsd` asked for a $5 ceiling and used to get none.
 *
 * FOUR NAMES ARE ACTUALLY AFFECTED and the rest of both types is single-word, which
 * is why this file is small: `best_known_honest` on a floor, and
 * `exploration_weight` / `prune_threshold` / `min_visits_for_prune` on a composed
 * configuration. `samples` and `threshold` are already single words because they were
 * moved ONTO the axis values that own them, which is the same decision paying twice.
 *
 * AND ONE PAYLOAD IS DELIBERATELY NOT MAPPED. `verify.spec` crosses untouched. It is
 * opaque to this convention because the convention governs the fields this
 * specification declares, not the interior of a payload whose schema the registered
 * verifier kind owns — and if anything transformed it, `verifierDigest` would differ
 * depending on which side of the transform it was computed on, which is §5.1's own
 * failure mode reached through a naming convention. With no transform there are not
 * two sides, so "wire form" and "as received" are the same bytes.
 *
 * `strictObject` throughout, for the reason the input itself is strict: valibot's
 * `object` EXCLUDES an unrecognised entry rather than rejecting it, and a dropped
 * field on this surface is a caller who asked for something getting the same result
 * as a caller who asked for nothing.
 */
import * as v from 'valibot';
import { JsonValueSchema } from '../utils/json';
import {
  SWARM_ADVANCES, SWARM_DECORRELATES, SWARM_EXPANDS, SWARM_OBSERVES,
} from '../strategy/swarm';
import type { Objective } from '../strategy/objective';
import type { SwarmConfig } from '../strategy/swarm';

const DirectionSchema = v.picklist(['minimise', 'maximise'] as const);
const ScaleSchema = v.picklist(['linear', 'log'] as const);

/** A verifier as DATA. `kind` is checked against the registry at dispatch rather than
 *  here, so the refusal can name the registered kinds instead of reading as a schema
 *  violation; `spec` is whatever that kind owns, carried through unexamined. */
const VerifierSpecSchema = v.strictObject({
  kind: v.pipe(v.string(), v.minLength(1)),
  spec: JsonValueSchema,
});

/** A floor is a PROOF, so `proof` is required prose and not a citation. */
const FloorSchema = v.pipe(
  v.strictObject({
    value: v.pipe(v.number(), v.finite()),
    proof: v.pipe(v.string(), v.minLength(1)),
    kind: v.picklist(['certificate', 'adversary', 'physical'] as const),
    best_known_honest: v.pipe(v.number(), v.finite()),
  }),
  v.transform((wire) => ({
    value: wire.value,
    proof: wire.proof,
    kind: wire.kind,
    bestKnownHonest: wire.best_known_honest,
  })),
);

const ScalarEntries = {
  kind: v.literal('scalar'),
  metric: v.pipe(v.string(), v.minLength(1)),
  unit: v.pipe(v.string(), v.minLength(1)),
  direction: DirectionSchema,
  scale: ScaleSchema,
  target: v.pipe(v.number(), v.finite()),
  verify: VerifierSpecSchema,
  floor: v.optional(FloorSchema),
};

const ScalarObjectiveSchema = v.strictObject(ScalarEntries);

/**
 * The four arms, discriminated on `kind` so a call that names one gets that arm's
 * complaint rather than a union's.
 *
 * `instances` and `components` carry their minimum in the schema because a front over
 * one axis is an argmax, and reporting an argmax as a frontier is the thing
 * `advance:'pareto'` must not be able to do.
 */
const ObjectiveSchema = v.variant('kind', [
  ScalarObjectiveSchema,
  v.strictObject({
    ...ScalarEntries,
    kind: v.literal('instanced'),
    instances: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(2)),
  }),
  v.strictObject({
    kind: v.literal('vector'),
    components: v.pipe(v.array(ScalarObjectiveSchema), v.minLength(2)),
  }),
  v.strictObject({
    kind: v.literal('witness'),
    witness: v.pipe(v.string(), v.minLength(1)),
    check: VerifierSpecSchema,
    proxy: v.optional(ScalarObjectiveSchema),
  }),
]);

/**
 * The axes, partial — `config` is the OVERRIDE half of a composition, so a call with
 * `from` states only what differs and a call without it is refused naming the axes it
 * did not state (that refusal lives in `resolveSwarm`, over the merged tuple, because
 * completeness is a property of the resolution rather than of the field).
 *
 * The three tagged axes keep their parameters ON the value that owns them: `inherit`
 * exists only under `unit:'trajectory'`, `samples` only under `score:'judge'`, and a
 * threshold only under the two `carry` values that admit into a store. That is what
 * makes §6.5's marginalisation refusal always have its input instead of reasoning over
 * an absent field — and what makes `inherit` unstateable on a node that has no
 * conversation to state it about.
 */
const SwarmConfigWireSchema = v.strictObject({
  unit: v.optional(v.variant('kind', [
    v.strictObject({ kind: v.literal('step') }),
    v.strictObject({ kind: v.literal('answer') }),
    v.strictObject({ kind: v.literal('generator') }),
    v.strictObject({ kind: v.literal('trajectory'), inherit: v.boolean() }),
  ])),
  observe: v.optional(v.picklist(SWARM_OBSERVES)),
  expand: v.optional(v.picklist(SWARM_EXPANDS)),
  decorrelate: v.optional(v.picklist(SWARM_DECORRELATES)),
  score: v.optional(v.variant('kind', [
    v.strictObject({ kind: v.literal('verify') }),
    v.strictObject({ kind: v.literal('agree') }),
    v.strictObject({ kind: v.literal('novelty') }),
    v.strictObject({ kind: v.literal('none') }),
    v.strictObject({ kind: v.literal('judge'), samples: v.pipe(v.number(), v.integer(), v.minValue(1)) }),
  ])),
  advance: v.optional(v.picklist(SWARM_ADVANCES)),
  carry: v.optional(v.variant('kind', [
    v.strictObject({ kind: v.literal('none') }),
    v.strictObject({ kind: v.literal('elites') }),
    v.strictObject({ kind: v.literal('reflections'), threshold: v.pipe(v.number(), v.finite()) }),
    v.strictObject({ kind: v.literal('artifacts'), threshold: v.pipe(v.number(), v.finite()) }),
  ])),
  exploration_weight: v.optional(v.pipe(v.number(), v.finite())),
  prune_threshold: v.optional(v.pipe(v.number(), v.finite())),
  min_visits_for_prune: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

/**
 * The resolved-configuration override, with the three region parameters renamed and
 * every ABSENT one left absent.
 *
 * Absent rather than present-and-undefined, which is not a nicety here: `resolveSwarm`
 * decides an axis is missing by reading `undefined`, and §6.5 refuses a pruning
 * parameter supplied under an `advance` that does not prune. A key written as
 * `undefined` would make "the caller did not say" and "the caller said nothing"
 * indistinguishable in the merge, which is the one distinction this specification
 * exists to keep.
 */
function configOf(wire: v.InferOutput<typeof SwarmConfigWireSchema>): Partial<SwarmConfig> {
  const config: Partial<SwarmConfig> = {};
  if (wire.unit !== undefined) Object.assign(config, { unit: wire.unit });
  if (wire.observe !== undefined) Object.assign(config, { observe: wire.observe });
  if (wire.expand !== undefined) Object.assign(config, { expand: wire.expand });
  if (wire.decorrelate !== undefined) Object.assign(config, { decorrelate: wire.decorrelate });
  if (wire.score !== undefined) Object.assign(config, { score: wire.score });
  if (wire.advance !== undefined) Object.assign(config, { advance: wire.advance });
  if (wire.carry !== undefined) Object.assign(config, { carry: wire.carry });
  if (wire.exploration_weight !== undefined) {
    Object.assign(config, { explorationWeight: wire.exploration_weight });
  }
  if (wire.prune_threshold !== undefined) {
    Object.assign(config, { pruneThreshold: wire.prune_threshold });
  }
  if (wire.min_visits_for_prune !== undefined) {
    Object.assign(config, { minVisitsForPrune: wire.min_visits_for_prune });
  }
  return config;
}

/**
 * `objective` as it crosses the wire, mapped onto the type the search reads.
 *
 * Annotated with the DECLARED type rather than left to inference, so the four arms
 * above are held to `Objective` by the compiler: an arm that drifts from the type the
 * search is written over stops compiling here instead of parsing into something the
 * search cannot read.
 */
export const SwarmObjectiveSchema: v.GenericSchema<unknown, Objective> = ObjectiveSchema;

/** `config` as it crosses the wire, mapped onto the axis tuple's partial. */
export const SwarmConfigSchema: v.GenericSchema<unknown, Partial<SwarmConfig>> = v.pipe(
  SwarmConfigWireSchema,
  v.transform(configOf),
);
