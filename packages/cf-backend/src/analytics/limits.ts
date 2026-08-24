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

/** Blobs accepted per data point. "Analytics Engine will accept up to twenty
 *  blobs, twenty doubles, and one index per call to `writeDataPoint`." */
export const MAX_BLOBS = 20;

/** Doubles accepted per data point, same sentence. */
export const MAX_DOUBLES = 20;

/** Indexes accepted per data point, same sentence. AE's sampling key. */
export const MAX_INDEXES = 1;

/**
 * "The total size of all blobs in a request must not exceed 16 KB. The 16 KB
 * size limit for the blobs field applies to each individual data point."
 *
 * KiB rather than KB: the platform writes "16 KB" and the enforcement is on
 * bytes, so the smaller reading of the two is the safe one to build to.
 */
export const MAX_BLOB_BYTES = 16 * 1024;

/** "Each index must not be more than 96 bytes." */
export const MAX_INDEX_BYTES = 96;

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
