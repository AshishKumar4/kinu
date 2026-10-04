/** Satisfaction per day, as `qualitySeries` (evolution/ratings.ts) computes it and every surface reads it back. */

import * as v from 'valibot';

const IntervalSchema = v.object({ mean: v.number(), lo: v.number(), hi: v.number(), n: v.number() });

/** One day of the quality series, as a remote surface reads it back. */
export const QualityDaySchema = v.object({
  /** UTC date, YYYY-MM-DD. */
  day: v.string(),
  satisfaction: IntervalSchema,
  corrected: IntervalSchema,
  rated: v.number(),
  thumbs: v.number(),
  /** Turns reviewed that day, rated or not. */
  turns: v.number(),
});

export type QualityDay = v.InferOutput<typeof QualityDaySchema>;
