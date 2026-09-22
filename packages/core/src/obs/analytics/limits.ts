/**
 * Workers Analytics Engine limits, quoted from
 * https://developers.cloudflare.com/analytics/analytics-engine/limits/ (retrieved 2026-08-24).
 * `writeDataPoint` drops an oversized point silently, so they are enforced here where a violation
 * can still be reported.
 */

/** "Analytics Engine will accept up to twenty blobs, twenty doubles, and one index per call to
 *  `writeDataPoint`." */
const MAX_BLOBS = 20;

const MAX_DOUBLES = 20;

const MAX_INDEXES = 1;

/**
 * "The total size of all blobs in a request must not exceed 16 KB", per data point. Read as KiB,
 * the safer of the two readings. Also bounds one browser render-failure report body.
 */
export const MAX_BLOB_BYTES = 16 * 1024;

/** "Each index must not be more than 96 bytes." */
const MAX_INDEX_BYTES = 96;

/** "You can write a maximum of 250 data points per Worker invocation." A window, not a value:
 *  enforced by the writer's budget, not by the schema check. */
export const MAX_WRITES_PER_INVOCATION = 250;

/** Primitives, so this module need not import the schemas that import it. */
export interface SlotCensus {
  readonly dataset: string;
  readonly blobBytes: readonly number[];
  readonly doubles: number;
  readonly indexes: readonly { readonly name: string; readonly maxBytes: number }[];
}

/** Refuse, at module load, a dataset the platform would silently truncate or drop. */
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

  // A second index slot would be silently dropped on the wire.
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

/** `quantileExactWeighted` takes a fraction; `95` returns a column of nulls, not an error. */
export function assertQuantileLevel(level: number): void {
  if (!(level > 0 && level < 1)) {
    throw new RangeError(`a quantile must be strictly between 0 and 1, not ${level}`);
  }
}
