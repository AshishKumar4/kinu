/**
 * Workers Analytics Engine's own limits, as named constants rather than numbers
 * spelled at the call sites that must respect them.
 *
 * Every value here is quoted from
 * https://developers.cloudflare.com/analytics/analytics-engine/limits/
 * (retrieved 2026-08-24, page last updated 2026-04-23). They are PLATFORM
 * facts, not choices, which is why they live apart from the schemas: a schema
 * may be redesigned, these may only be re-measured.
 *
 * WHAT HAPPENS WHEN ONE IS EXCEEDED is the reason to enforce them here at all.
 * `writeDataPoint` returns `void` and reports nothing — the docs say to look in
 * tail logs — so an oversized point is dropped SILENTLY. A dataset that reads
 * empty and a dataset that reads short are indistinguishable to whoever queries
 * it later, which makes the platform's own enforcement useless as a signal. Ours
 * is checked where it can still be reported.
 */

/**
 * The five limits below are PRIVATE, and `assertWithinPlatformLimits` is what a
 * caller reaches instead.
 *
 * Nothing outside this file has any use for the numbers themselves: a schema does
 * not choose them, and a reader who wants to know whether a dataset fits asks the
 * guard rather than doing the arithmetic again. `MAX_WRITES_PER_INVOCATION` is the
 * exception and is exported, because a window is state rather than a check and
 * `writer.ts` has to size one.
 */

/** Blobs accepted per data point. "Analytics Engine will accept up to twenty
 *  blobs, twenty doubles, and one index per call to `writeDataPoint`." */
const MAX_BLOBS = 20;

/** Doubles accepted per data point, same sentence. */
const MAX_DOUBLES = 20;

/** Indexes accepted per data point, same sentence. AE's sampling key. */
const MAX_INDEXES = 1;

/**
 * "The total size of all blobs in a request must not exceed 16 KB. The 16 KB
 * size limit for the blobs field applies to each individual data point."
 *
 * KiB rather than KB: the platform writes "16 KB" and the enforcement is on
 * bytes, so the smaller reading of the two is the safe one to build to.
 */
const MAX_BLOB_BYTES = 16 * 1024;

/** "Each index must not be more than 96 bytes." */
const MAX_INDEX_BYTES = 96;

/**
 * "You can write a maximum of 250 data points per Worker invocation (client
 * HTTP request). Each call to `writeDataPoint` counts towards this limit."
 *
 * The one limit here that is about a WINDOW rather than a value, and therefore
 * the one that cannot be enforced by a static schema check — see
 * `writer.ts`'s budget for how far our window can be made to match the
 * platform's, and where it deliberately stops trying.
 */
export const MAX_WRITES_PER_INVOCATION = 250;

/**
 * The slot census one dataset declares, as the primitives every limit above is
 * stated over.
 *
 * PRIMITIVES RATHER THAN THE SCHEMA TYPE, so enforcement can live beside the
 * numbers it enforces without this module importing the module that imports it.
 * `dataset` is carried only to name the offender: a refusal that does not say
 * which dataset is wrong makes the reader open all three.
 */
export interface SlotCensus {
  readonly dataset: string;
  /** Each blob slot's byte budget, in declaration order. */
  readonly blobBytes: readonly number[];
  /** How many double slots the dataset declares. */
  readonly doubles: number;
  /** The indexed slots, which the platform caps at one. */
  readonly indexes: readonly { readonly name: string; readonly maxBytes: number }[];
}

/**
 * Refuse a dataset the platform would silently truncate or drop.
 *
 * HERE rather than at the declaration, because this file is where the numbers are
 * quoted and "ours is checked where it can still be reported" is the whole reason
 * they are named. A schema is checked once at module load, so a violation is a
 * startup failure carrying a message rather than a dataset that reads short.
 */
export function assertWithinPlatformLimits(census: SlotCensus): void {
  const { dataset } = census;
  if (census.blobBytes.length > MAX_BLOBS) {
    throw new RangeError(
      `${dataset}: ${census.blobBytes.length} blob slots exceeds the platform's ${MAX_BLOBS}`,
    );
  }
  if (census.doubles > MAX_DOUBLES) {
    throw new RangeError(
      `${dataset}: ${census.doubles} double slots exceeds the platform's ${MAX_DOUBLES}`,
    );
  }
  for (const index of census.indexes) {
    if (index.maxBytes > MAX_INDEX_BYTES) {
      throw new RangeError(
        `${dataset}: index "${index.name}" declares ${index.maxBytes} bytes, `
        + `over the platform's ${MAX_INDEX_BYTES}`,
      );
    }
  }
  // The platform takes ONE index per data point, and a schema holds exactly one —
  // so this is the assertion that the shape and the platform's count agree,
  // checked rather than assumed. A future second slot would be silently dropped
  // on the wire while every writer believed it was projecting.
  if (census.indexes.length !== MAX_INDEXES) {
    throw new RangeError(
      `${dataset}: ${census.indexes.length} index slots, but the platform takes ${MAX_INDEXES}`,
    );
  }
  let budget = 0;
  for (const bytes of census.blobBytes) budget += bytes;
  if (budget > MAX_BLOB_BYTES) {
    throw new RangeError(
      `${dataset}: blob slots declare ${budget} bytes in total, `
      + `over the platform's ${MAX_BLOB_BYTES} per data point`,
    );
  }
}

/**
 * The domain of a quantile level. `quantileExactWeighted(level)` takes a
 * FRACTION, and the mistake it invites is a percentage: `95` passes every type
 * this repository has and returns a column of nulls rather than an error, so the
 * reader gets a p95 panel that is empty and looks correct.
 *
 * A platform fact like the counts above — the aggregate function's own domain,
 * not a choice of ours — which is why it is refused here and not at the panel.
 */
export function assertQuantileLevel(level: number): void {
  if (!(level > 0 && level < 1)) {
    throw new RangeError(`a quantile must be strictly between 0 and 1, not ${level}`);
  }
}
