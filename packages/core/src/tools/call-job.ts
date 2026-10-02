import type { ToolExecutionOptions } from 'ai';
import * as v from 'valibot';

export interface CallJob {
  readonly id: string;
  readonly detached: AbortSignal;
}

export const CALL_JOB_OPTION = 'kinuJob';

const CallJobOptionsSchema = v.object({
  [CALL_JOB_OPTION]: v.optional(v.object({ id: v.string(), detached: v.instance(AbortSignal) })),
});

export function readCallJob(options: ToolExecutionOptions | undefined): CallJob | undefined {
  const parsed = v.safeParse(CallJobOptionsSchema, options);

  return parsed.success ? parsed.output[CALL_JOB_OPTION] : undefined;
}
