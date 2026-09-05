import * as v from 'valibot';

const RestoreCountSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

/** What one container-side restore cost, counted where the bytes moved.
 *  `serialRemoteOps` is the longest chain of store reads one path awaited in
 *  sequence; a pooled walk keeps it below `totalRemoteOps`. */
export const CandidateRestoreWorkSchema = v.object({
  serialRemoteOps: RestoreCountSchema,
  totalRemoteOps: RestoreCountSchema,
  metadataBytes: RestoreCountSchema,
  payloadBytes: RestoreCountSchema,
  cpuSteps: RestoreCountSchema,
  replayUnits: RestoreCountSchema,
});
export type CandidateRestoreWork = v.InferOutput<typeof CandidateRestoreWorkSchema>;

/** The evidence the restore bound is checked against. */
export const CandidateRestoreBoundSchema = v.object({
  openReads: RestoreCountSchema,
  layersConsulted: v.nullable(RestoreCountSchema),
  maxNodeDepth: v.nullable(RestoreCountSchema),
  nodeFetches: v.nullable(RestoreCountSchema),
  pathsResolved: RestoreCountSchema,
});
export type CandidateRestoreBound = v.InferOutput<typeof CandidateRestoreBoundSchema>;

/** The counted restore as it travels: the work row beside its bound evidence. */
export const RestoreReceiptSchema = v.object({
  work: CandidateRestoreWorkSchema,
  bound: CandidateRestoreBoundSchema,
});
export type RestoreReceipt = v.InferOutput<typeof RestoreReceiptSchema>;

/** Render a counted restore as the one token the attach detail carries. */
export function renderRestoreReceipt(receipt: RestoreReceipt): string {
  return JSON.stringify(v.parse(RestoreReceiptSchema, receipt));
}

/** Read back what the attach detail carried. It throws on anything else. */
export function parseRestoreReceipt(text: string): RestoreReceipt {
  return v.parse(RestoreReceiptSchema, JSON.parse(text));
}
