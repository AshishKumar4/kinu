/**
 * The three Analytics Engine datasets and their slot layouts. Positions derive from named slots
 * (`blobColumn(schema, 'provider')`), so writer and reader cannot silently transpose columns.
 * Separate datasets because AE samples per index value: audit rows must not share a sampling
 * population with turn streams. No slot holds free text; workspace and actor ids are digests.
 */
import type { ReservedLogField } from '../log';
import { assertWithinPlatformLimits } from './limits';
import { assertPublishableNames } from './privacy';

export type AnalyticsBindingName = 'AGENT_METRICS' | 'FEEDBACK_MARKERS' | 'CONTROL_PLANE_OPS';

/** Blob budgets must sum within the per-datapoint limit, so a row cannot exceed it. */
export interface BlobSlot {
  readonly name: string;
  readonly maxBytes: number;
}

export interface DoubleSlot {
  readonly name: string;
}

/** AE's sampling key and only high-cardinality filter. */
export interface IndexSlot {
  readonly name: string;
  readonly maxBytes: number;
}

export interface AnalyticsSchema {
  readonly binding: AnalyticsBindingName;
  /** Read only by SQL; `scripts/analytics-datasets.test.ts` holds it equal to wrangler's. */
  readonly dataset: string;
  readonly index: IndexSlot;
  /** Order is `blob1..blobN`: append only, it is the wire format. */
  readonly blobs: readonly BlobSlot[];
  /** Order is `double1..doubleN`: append only. */
  readonly doubles: readonly DoubleSlot[];
}

export type BlobName<S extends AnalyticsSchema> = S['blobs'][number]['name'];

export type DoubleName<S extends AnalyticsSchema> = S['doubles'][number]['name'];

export type IndexName<S extends AnalyticsSchema> = S['index']['name'];

/** Every slot required, so position N always means one thing; pass `''` or 0 when empty. */
export type AnalyticsRow<S extends AnalyticsSchema> =
  & { readonly [K in BlobName<S>]: string }
  & { readonly [K in DoubleName<S>]: number }
  & { readonly [K in IndexName<S>]: string };

declare const reservedSlot: unique symbol;

/** Uninhabited: a schema naming a reserved log field does not compile (as `LoggableFields`). */
export interface ReservedSlotIsNotWritable {
  readonly [reservedSlot]: 'reserved slot name';
}

type SlotName<S extends AnalyticsSchema> = BlobName<S> | DoubleName<S> | IndexName<S>;

/**
 * `const` keeps slot names literal; without it `AnalyticsRow` widens to an open map. Runtime
 * checks repeat the type-level ban because types are erased and untestable.
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

/** 1-based, as AE's columns are. */
export function blobColumn<S extends AnalyticsSchema>(schema: S, name: BlobName<S>): string {
  const at = schema.blobs.findIndex((slot) => slot.name === name);

  if (at < 0) throw new RangeError(`${schema.dataset}: no blob slot named "${String(name)}"`);

  return `blob${at + 1}`;
}

export function doubleColumn<S extends AnalyticsSchema>(schema: S, name: DoubleName<S>): string {
  const at = schema.doubles.findIndex((slot) => slot.name === name);

  if (at < 0) throw new RangeError(`${schema.dataset}: no double slot named "${String(name)}"`);

  return `double${at + 1}`;
}

export function indexColumn(_schema: AnalyticsSchema): string {
  return 'index1';
}

/**
 * Rows discriminated by `kind`; every query must filter on it. Indexed on the workspace digest so
 * a busy workspace is sampled alone.
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
    // Disjoint by `kind`: `tool` only on tool rows; `source` is the producer or lifecycle verb.
    { name: 'tool', maxBytes: 64 },
    { name: 'source', maxBytes: 48 },
    // The deciding arm of a refusal, one closed word; `code` is only the failure class.
    { name: 'reason', maxBytes: 32 },
  ],
  doubles: [
    // Always 1, so `SUM(_sample_interval * count)` is a weighted row count.
    { name: 'count' },
    { name: 'durationMs' },
    { name: 'ttftMs' },
    { name: 'steps' },
    { name: 'toolCalls' },
    // Core's `Usage` field names verbatim (`USAGE_FIELDS`).
    { name: 'input' },
    { name: 'output' },
    { name: 'cacheRead' },
    { name: 'cacheWrite' },
    { name: 'reasoning' },
    { name: 'neurons' },
    // `usd` only when the catalog rate was the call's own; average cost divides by
    // `SUM(_sample_interval * priced)`, so an unpriced call never reads as free.
    { name: 'usd' },
    { name: 'priced' },
    // Delivery attempt, separating rows from incidents; 0 where the producer counts none.
    { name: 'attempts' },
  ],
});

/**
 * One marker per submission, never the report itself. Indexed on the unique submission id so it
 * is never sampled and counts stay exact.
 */
export const FEEDBACK_MARKERS_SCHEMA = defineSchema({
  binding: 'FEEDBACK_MARKERS',
  dataset: 'kinu_feedback_markers',
  index: { name: 'feedbackId', maxBytes: 64 },
  blobs: [
    { name: 'kind', maxBytes: 16 },
    { name: 'outcome', maxBytes: 16 },
    { name: 'rejectReason', maxBytes: 32 },
    // Closed union from the first path segment; never the route (slugs are user text).
    { name: 'routeFamily', maxBytes: 24 },
  ],
  doubles: [
    { name: 'count' },
    { name: 'screenshotBytes' },
    { name: 'noteLength' },
    { name: 'annotated' },
    // Presence, separate from size: a refusal can precede measuring the bytes.
    { name: 'screenshot' },
  ],
});

/** Indexed on the actor digest: a reader holding an email can digest it and filter. */
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

/** `writer.ts` builds its plane from this list; `scripts/analytics-datasets.test.ts` checks it. */
export const ANALYTICS_SCHEMAS = [
  AGENT_METRICS_SCHEMA,
  FEEDBACK_MARKERS_SCHEMA,
  CONTROL_PLANE_OPS_SCHEMA,
] as const;

