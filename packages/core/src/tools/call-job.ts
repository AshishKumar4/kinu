import type { ToolExecutionOptions } from 'ai';
import * as v from 'valibot';
import { OutputSinkSchema, type OutputSink } from '../types/primitives';

export interface CallJob {
  readonly id: string;
  readonly detached: AbortSignal;
  readonly output: OutputSink;
}

export const CALL_JOB_OPTION = 'kinuJob';

const CallJobOptionsSchema = v.object({
  [CALL_JOB_OPTION]: v.optional(v.object({ id: v.string(), detached: v.instance(AbortSignal), output: OutputSinkSchema })),
});

export function readCallJob(options: ToolExecutionOptions<unknown> | undefined): CallJob | undefined {
  const parsed = v.safeParse(CallJobOptionsSchema, options);

  return parsed.success ? parsed.output[CALL_JOB_OPTION] : undefined;
}
