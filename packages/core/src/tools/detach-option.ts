import type { ToolExecutionOptions } from 'ai';
import * as v from 'valibot';

/** Fires when a job takes the call. */
export const DETACH_OPTION = 'kinuDetach';

const DetachOptionsSchema = v.object({ [DETACH_OPTION]: v.optional(v.instance(AbortSignal)) });

export function readDetachSignal(options: ToolExecutionOptions | undefined): AbortSignal | undefined {
  const parsed = v.safeParse(DetachOptionsSchema, options);

  return parsed.success ? parsed.output[DETACH_OPTION] : undefined;
}
