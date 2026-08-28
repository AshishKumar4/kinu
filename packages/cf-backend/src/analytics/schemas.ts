/**
 * The three Analytics Engine datasets, and the slot layout every writer and
 * every reader resolves through.
 *
 * ## Why a descriptor rather than positional literals
 *
 * AE's columns are `blob1..blob20` and `double1..double20`. A writer that spells
 * `blobs[4] = provider` and a reader that spells `blob5 AS provider` are two
 * declarations of one fact, and the failure when they disagree is the worst kind
 * this repository has: the query returns a column, the column contains strings,
 * and every one of them is the wrong field. Nothing is thrown and nothing reads
 * empty. So the position is derived, once, from a named slot: the writer
 * projects a typed row through `blobs`, and a reader asks
 * `blobColumn(schema, 'provider')`. A rename is then a type error on both sides
 * rather than a silently transposed dataset.
 *
 * ## Why three datasets rather than one
 *
 * AE samples PER INDEX VALUE, and sampling is the reason. A turn stream and an
 * admin audit trail differ in volume by orders of magnitude; sharing a dataset
 * would put them in one sampling population and the audit rows — the ones that
 * must be exact — are the ones that would be dropped. Three datasets also mean
 * three row SHAPES, so no dataset carries a column that is meaningless for most
 * of its rows.
 *
 * ## What the byte budgets are for
 *
 * Every slot declares `maxBytes`, and `defineSchema` asserts that the blob
 * budgets SUM to no more than the platform's 16 KiB per-datapoint limit. That
 * makes the limit structural rather than defensive: a row cannot exceed it,
 * because no slot can exceed its own bound and the bounds already fit. The
 * alternative — truncating a finished row at 16 KiB — decides which field to
 * lose at the moment it is too late to say so.
 *
 * ## What may never appear here
 *
 * No slot may be named for a reserved field, and `defineSchema` refuses one both
 * at compile time (the `ReservedSlotIsNotWritable` witness, the same idiom core's
 * `LoggableFields` uses) and at load. Beyond names, the rule these schemas were
 * designed to: nothing on them holds a prompt, a message, free text, an email, a
 * token or a header value. The two identifiers that could smuggle user text —
 * a workspace id and an admin's address — are declared as digests and are
 * written through `analyticsDigest`.
 */
import type { ReservedLogField } from '@kinu.run/core/obs';
import { assertWithinPlatformLimits } from './limits';
import { assertPublishableNames } from './privacy';

/** The Env members that hold an Analytics Engine dataset. Named as a union so a
 *  schema cannot point at a binding the Worker does not declare. */
export type AnalyticsBindingName = 'AGENT_METRICS' | 'FEEDBACK_MARKERS' | 'CONTROL_PLANE_OPS';

/** One string column. `maxBytes` is what makes the 16 KiB per-datapoint budget a
 *  property of the schema instead of a check on the way out. */
export interface BlobSlot {
  readonly name: string;
  readonly maxBytes: number;
}

/** One numeric column. Numbers are fixed-width on the wire, so a double slot has
 *  no byte budget to declare — which is also why anything unbounded belongs in a
 *  double if it can be counted rather than in a blob if it can be named. */
export interface DoubleSlot {
  readonly name: string;
}

/** The single indexed column. AE's sampling key and its only high-cardinality
 *  filter, capped by the platform at 96 bytes. */
export interface IndexSlot {
  readonly name: string;
  readonly maxBytes: number;
}

export interface AnalyticsSchema {
  readonly binding: AnalyticsBindingName;
  /** The PRODUCTION dataset name, and the base every other deployment's name is
   *  derived from — see `analyticsDataset`. Writers never read it: they write
   *  through `binding`, which wrangler already points at the right dataset for
   *  the environment being deployed. Only the SQL read path names a dataset. */
  readonly dataset: string;
  readonly index: IndexSlot;
  /** Slot order IS `blob1..blobN`. */
  readonly blobs: readonly BlobSlot[];
  /** Slot order IS `double1..doubleN`. */
  readonly doubles: readonly DoubleSlot[];
}

export type BlobName<S extends AnalyticsSchema> = S['blobs'][number]['name'];
export type DoubleName<S extends AnalyticsSchema> = S['doubles'][number]['name'];
export type IndexName<S extends AnalyticsSchema> = S['index']['name'];

/**
 * A complete row for one dataset. Every slot is REQUIRED: a schema's whole
 * purpose is that position N always means the same thing, and an optional slot
 * would let one call site write `provider` into a row where another left it
 * absent — after which `blob7` means two things depending on which call site
 * produced the row. A field with nothing to say passes the empty string or zero,
 * which is a statement rather than a gap.
 */
export type AnalyticsRow<S extends AnalyticsSchema> =
  & { readonly [K in BlobName<S>]: string }
  & { readonly [K in DoubleName<S>]: number }
  & { readonly [K in IndexName<S>]: string };

declare const reservedSlot: unique symbol;

/**
 * Uninhabited. It is the required type of a schema whose slot names include a
 * reserved field, so such a schema does not compile — the same construction
 * core's `LoggableFields` uses, for the same reason: a name-based ban that is
 * only a convention gets violated by the call site that most needed it.
 */
export interface ReservedSlotIsNotWritable {
  readonly [reservedSlot]: 'reserved slot name';
}

type SlotName<S extends AnalyticsSchema> = BlobName<S> | DoubleName<S> | IndexName<S>;

/**
 * Pin a schema. `const` type parameter so the slot names survive as literals —
 * without it every name widens to `string` and `AnalyticsRow` degenerates to an
 * open map, which is exactly the shape this file exists to prevent.
 *
 * The runtime assertions duplicate what the type system already refuses, and
 * deliberately: the type check is erased before anything runs, so a test cannot
 * prove the ban fires. `limits.ts` and `privacy.ts` hold them, beside the facts
 * each enforces, and both are reachable by a test for that reason.
 */
function defineSchema<const S extends AnalyticsSchema>(
  schema: S
    & (Extract<SlotName<S>, ReservedLogField> extends never ? unknown : ReservedSlotIsNotWritable),
): S {
  const pinned: S = schema;
  assertWithinPlatformLimits({
    dataset: pinned.dataset,
    blobBytes: pinned.blobs.map((slot) => slot.maxBytes),
    doubles: pinned.doubles.length,
    indexes: [pinned.index],
  });
  assertPublishableNames(pinned.dataset, [
    pinned.index.name,
    ...pinned.blobs.map((slot) => slot.name),
    ...pinned.doubles.map((slot) => slot.name),
  ]);
  return pinned;
}

/** The SQL column a named blob occupies. 1-based, because AE's columns are. */
export function blobColumn<S extends AnalyticsSchema>(schema: S, name: BlobName<S>): string {
  const at = schema.blobs.findIndex((slot) => slot.name === name);
  if (at < 0) throw new RangeError(`${schema.dataset}: no blob slot named "${String(name)}"`);
  return `blob${at + 1}`;
}

/** The SQL column a named double occupies. */
export function doubleColumn<S extends AnalyticsSchema>(schema: S, name: DoubleName<S>): string {
  const at = schema.doubles.findIndex((slot) => slot.name === name);
  if (at < 0) throw new RangeError(`${schema.dataset}: no double slot named "${String(name)}"`);
  return `double${at + 1}`;
}

/** AE's one indexed column. A function rather than the constant `'index1'` so a
 *  reader names the CONCEPT it is filtering on and stays correct if the platform
 *  ever admits a second index. */
export function indexColumn(_schema: AnalyticsSchema): string {
  return 'index1';
}

/**
 * A dataset-name suffix: empty for production, `_staging` and its like
 * elsewhere. Bounded and lowercase because the value is interpolated into SQL
 * and comes from a deployment var — narrow input, but a var is still a string
 * somebody edits.
 */
const DATASET_SUFFIX = /^(?:|_[a-z][a-z0-9_]{0,23})$/;

/**
 * The dataset a READER must name for this deployment.
 *
 * ONE PLACE, because the name is declared twice and nothing held the two equal:
 * `wrangler.jsonc` binds `AGENT_METRICS` to `kinu_agent_metrics_staging` under
 * `env.staging` while the query builder spelled the production name, and staging
 * shares production's account — so staging wrote rows no reader named and its
 * admin panels would have presented production's numbers as its own.
 * `scripts/analytics-datasets.test.ts` asserts, per environment, that every
 * wrangler binding's dataset equals the schema's base plus that suffix.
 *
 * A malformed suffix THROWS rather than falling back to '': falling back is
 * exactly the defect — reading production from staging — and the value is our
 * own deployment config, held correct by the gate.
 */
export function analyticsDataset(schema: AnalyticsSchema, suffix: string): string {
  if (!DATASET_SUFFIX.test(suffix)) {
    throw new RangeError(`"${suffix}" is not an analytics dataset suffix`);
  }
  return schema.dataset + suffix;
}

/**
 * Agent operational metrics: one row per turn, per model request, per tool call,
 * per first token, and one per diagnostic event that reaches the sink.
 *
 * `kind` discriminates them. It is blob1 because it is the first predicate of
 * every query — a mixed-shape dataset whose discriminator is buried is one whose
 * aggregates quietly pool a turn's `durationMs` with a tool call's.
 *
 * INDEXED ON THE WORKSPACE DIGEST, which is the whole reason this is a separate
 * dataset. AE samples per index value, so one workspace running a swarm is
 * sampled alone and every other workspace's counts stay exact.
 */
export const AGENT_METRICS_SCHEMA = defineSchema({
  binding: 'AGENT_METRICS',
  dataset: 'kinu_agent_metrics',
  index: { name: 'workspace', maxBytes: 32 },
  blobs: [
    { name: 'kind', maxBytes: 16 },
    { name: 'family', maxBytes: 32 },
    { name: 'event', maxBytes: 96 },
    { name: 'outcome', maxBytes: 16 },
    { name: 'code', maxBytes: 16 },
    { name: 'boundary', maxBytes: 48 },
    { name: 'agentKind', maxBytes: 24 },
    { name: 'provider', maxBytes: 48 },
    { name: 'model', maxBytes: 128 },
    // `tool` and `source` are disjoint by `kind`, which is what keeps either from
    // becoming a bag: `tool` is the tool's name and is set only on a `tool` row;
    // `source` is the producer or operation a row is attributed to — which spend
    // source asked for a `model` row, which lifecycle verb produced an `event`
    // row. One row never carries both.
    { name: 'tool', maxBytes: 64 },
    { name: 'source', maxBytes: 48 },
    // WHY a refusal was refused, as one closed word. `code` names the CLASS of
    // failure from core's nine-member vocabulary; a denial's reason is the arm
    // that decided it, and `tier_too_low` versus `unrecognized_workspace` imply
    // opposite responses while both are `denied`. APPENDED rather than inserted:
    // slot order IS the wire format, so a new slot may only go last.
    { name: 'reason', maxBytes: 32 },
  ],
  doubles: [
    // Always 1. Present so `SUM(_sample_interval * count)` reads as a weighted
    // count of ROWS while every other double keeps its own meaning — and so a
    // future pre-aggregated row can carry a real multiplicity without changing
    // one query.
    { name: 'count' },
    { name: 'durationMs' },
    { name: 'ttftMs' },
    { name: 'steps' },
    { name: 'toolCalls' },
    // Core's `Usage` field names verbatim (packages/core/src/usage.ts
    // USAGE_FIELDS). One token vocabulary in the repository: a dataset that
    // renamed them would be the tenth restatement of the same provider report.
    { name: 'input' },
    { name: 'output' },
    { name: 'cacheRead' },
    { name: 'cacheWrite' },
    { name: 'reasoning' },
    { name: 'neurons' },
    // A price is something WE computed, not something the provider reported, and
    // it exists only where the catalog rate was the call's own — a judge runs
    // cross-family on purpose, so pricing it at the actor's rate would put a
    // fabricated number in the dataset. `priced` is the witness: an average cost
    // divides by `SUM(_sample_interval * priced)`, never by the row count, so an
    // unpriced call cannot read as a free one.
    { name: 'usd' },
    { name: 'priced' },
    // Which delivery attempt a row is reporting, where the producer counts them.
    // A durable recovery announcement is retried until its host accepts it, so
    // "how many rows" and "how many incidents" are different questions, and this
    // slot is what tells them apart. APPENDED, like `reason` above: slot order IS
    // the wire format. Zero on every row whose producer counts no attempts.
    { name: 'attempts' },
  ],
});

/**
 * Feedback markers: one row per submission, accepted or rejected.
 *
 * A MARKER, not a report. The note, the screenshot and the route the person was
 * on live in R2 and in the control plane's own row; what reaches here is that a
 * report happened, how big it was, and whether we kept it. `noteLength` is a
 * character count precisely so the question "are people writing real reports"
 * can be answered without the reports.
 *
 * REJECTIONS ARE ROWS TOO. `storage_unavailable` and `row_write_failed` mean a
 * report was lost rather than refused, and pooling those with a client error
 * would make both rates unreadable.
 *
 * INDEXED ON THE SUBMISSION ID, which looks like the wrong choice and is the
 * right one: AE samples the index values that accumulate events, so a
 * unique-per-row index is the one shape that is never sampled, and feedback
 * counts must be exact. Every grouping anyone wants — outcome, reason, route
 * family — is a blob.
 */
export const FEEDBACK_MARKERS_SCHEMA = defineSchema({
  binding: 'FEEDBACK_MARKERS',
  dataset: 'kinu_feedback_markers',
  index: { name: 'feedbackId', maxBytes: 64 },
  blobs: [
    { name: 'kind', maxBytes: 16 },
    { name: 'outcome', maxBytes: 16 },
    { name: 'rejectReason', maxBytes: 32 },
    // The FIRST path segment, mapped onto a closed union. Never the route: a
    // workspace slug is mission-derived, and no redactor can recognise user text
    // inside a path.
    { name: 'routeFamily', maxBytes: 24 },
  ],
  doubles: [
    { name: 'count' },
    { name: 'screenshotBytes' },
    { name: 'noteLength' },
    { name: 'annotated' },
    // 1 when the submission CARRIED a screenshot. Presence and size are two
    // facts, and the marker held only one of them: a refusal decided before the
    // bytes were measured wrote 0 bytes, which is indistinguishable from a
    // note-only report — so the screenshot-refusal population, the one these
    // columns exist to describe, counted itself as having no screenshots.
    // APPENDED, because slot order is the wire format.
    { name: 'screenshot' },
  ],
});

/**
 * Control-plane operations: one row per privileged mutation and per release
 * transition, successful or refused.
 *
 * INDEXED ON THE ACTOR DIGEST rather than the address. Per-actor audit without
 * storing who: a reader holding an admin's email can digest it and filter, and
 * the dataset alone names nobody.
 *
 * `target` is a digest for the same reason `workspace` is one on the agent
 * dataset. `targetKind` is the plain word, because 'workspace' is our
 * vocabulary and not the user's.
 */
export const CONTROL_PLANE_OPS_SCHEMA = defineSchema({
  binding: 'CONTROL_PLANE_OPS',
  dataset: 'kinu_control_plane_ops',
  index: { name: 'actor', maxBytes: 32 },
  blobs: [
    { name: 'kind', maxBytes: 16 },
    { name: 'operation', maxBytes: 64 },
    { name: 'outcome', maxBytes: 16 },
    { name: 'code', maxBytes: 16 },
    { name: 'targetKind', maxBytes: 24 },
    { name: 'reason', maxBytes: 48 },
    { name: 'target', maxBytes: 32 },
  ],
  doubles: [
    { name: 'count' },
    { name: 'durationMs' },
    { name: 'affected' },
  ],
});

/**
 * Every dataset, keyed by the binding that carries it. `writer.ts` builds the
 * one plane from this list, so a dataset added here is wired — and a binding
 * wrangler declares that no schema claims fails the same equality from the other
 * side (`scripts/analytics-datasets.test.ts`).
 */
export const ANALYTICS_SCHEMAS = [
  AGENT_METRICS_SCHEMA,
  FEEDBACK_MARKERS_SCHEMA,
  CONTROL_PLANE_OPS_SCHEMA,
] as const;

