/**
 * Wire form (snake_case) of a swarm call's structured fields, mapped onto the camelCase domain types
 * (docs/EXPLORATION.md). `verify.spec` crosses untouched so `verifierDigest` sees the same bytes.
 * `strictObject` throughout: valibot's `object` silently drops unknown keys.
 */
import * as v from 'valibot';
import { JsonValueSchema } from '../utils/json';
import { SWARM_CONTEXTS, SWARM_EXPANDS } from '../types/swarm';
import type { Objective } from '../types/objective';
import type { SwarmConfig, SwarmNodeAssignment } from '../types/swarm';

const DirectionSchema = v.picklist(['minimise', 'maximise'] as const);

const ScaleSchema = v.picklist(['linear', 'log'] as const);

/** `kind` is checked against the registry at dispatch so the refusal can name registered kinds. */
const VerifierSpecSchema = v.strictObject({
  kind: v.pipe(v.string(), v.minLength(1)),
  spec: JsonValueSchema,
});

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

/** `instances`/`components` require ≥2: a front over one axis is an argmax, not a frontier. */
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

const SwarmConfigWireSchema = v.strictObject({
  unit: v.optional(v.variant('kind', [
    v.strictObject({ kind: v.literal('answer') }),
    v.strictObject({ kind: v.literal('thought') }),
  ])),
  context: v.optional(v.picklist(SWARM_CONTEXTS)),
  expand: v.optional(v.picklist(SWARM_EXPANDS)),
  score: v.optional(v.variant('kind', [
    v.strictObject({ kind: v.literal('verify') }),
    v.strictObject({ kind: v.literal('none') }),
    v.strictObject({ kind: v.literal('judge'), samples: v.pipe(v.number(), v.integer(), v.minValue(1)) }),
  ])),
  advance: v.optional(v.variant('kind', [
    v.strictObject({ kind: v.literal('uct') }),
    v.strictObject({ kind: v.literal('best-first') }),
    v.strictObject({ kind: v.literal('pareto') }),
    v.strictObject({ kind: v.literal('none') }),
    v.strictObject({ kind: v.literal('archive'), novelty: v.pipe(v.number(), v.finite()) }),
  ])),
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

/** Absent keys stay absent: `resolveSwarm` reads `undefined` as "caller did not state this axis". */
function configOf(wire: v.InferOutput<typeof SwarmConfigWireSchema>): Partial<SwarmConfig> {
  const config: Partial<SwarmConfig> = {};

  if (wire.unit !== undefined) Object.assign(config, { unit: wire.unit });

  if (wire.context !== undefined) Object.assign(config, { context: wire.context });

  if (wire.expand !== undefined) Object.assign(config, { expand: wire.expand });

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

/** Annotated with the domain type so an arm that drifts from `Objective` fails to compile here. */
export const SwarmObjectiveSchema: v.GenericSchema<unknown, Objective> = ObjectiveSchema;

/** `config` as it crosses the wire, mapped onto the axis tuple's partial. */
export const SwarmConfigSchema: v.GenericSchema<unknown, Partial<SwarmConfig>> = v.pipe(
  SwarmConfigWireSchema,
  v.transform(configOf),
);

/**
 * The caller's per-node assignments for the first level (the root has no proposal of its own);
 * converted into branch shape by `strategy/swarm-level.ts` `assignedRootGrant`. Both fields non-empty.
 */
export const SwarmNodeAssignmentsSchema: v.GenericSchema<unknown, readonly SwarmNodeAssignment[]> =
  v.pipe(
    v.array(v.strictObject({
      task: v.pipe(v.string(), v.minLength(1)),
      prompt: v.pipe(v.string(), v.minLength(1)),
    })),
    // Empty list: `branches` already expresses that as a refusal.
    v.minLength(1),
  );

/**
 * Model specs assigned round-robin over expansion children. Whether a spec resolves is checked
 * by the runner via `AgentsSwarmDeps.resolveModel`, before any node runs.
 */
export const SwarmModelsSchema: v.GenericSchema<unknown, readonly string[]> =
  v.pipe(
    v.array(v.pipe(v.string(), v.minLength(1))),
    v.minLength(1),
  );
