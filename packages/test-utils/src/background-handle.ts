import * as v from 'valibot';
import type { BackgroundHandle } from '@kinu.run/core';

const BackgroundHandleSchema: v.GenericSchema<BackgroundHandle> = v.object({
  background: v.literal(true),
  jobId: v.string(),
  kind: v.string(),
  message: v.string(),
});

/** Whether a tool's answer is the handle a detached job hands back in place of its result. */
export function isBackgroundHandle<T>(value: T): value is T & BackgroundHandle {
  return v.safeParse(BackgroundHandleSchema, value).success;
}
