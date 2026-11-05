/** A provider's failure as the model menu carries it: the app reads it with no provider code loaded. */
import * as v from 'valibot';

/** A provider whose probe threw; reported, not thrown, so one broken provider cannot empty the menu. */
export const ProviderFailureSchema = v.object({
  provider: v.string(),
  label: v.optional(v.string()),
  reason: v.string(),
});

export type ProviderFailure = v.InferOutput<typeof ProviderFailureSchema>;
