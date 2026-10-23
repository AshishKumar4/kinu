import * as v from 'valibot';

/** What a watcher runs before it fires: a program body, as eval's, and the namespaces it reads (events/ingress/watch.ts). */
export const WatchCheckSchema = v.object({
  code: v.pipe(v.string(), v.minLength(1)),
  reads: v.optional(v.array(v.string())),
});

export type WatchCheck = v.InferOutput<typeof WatchCheckSchema>;
