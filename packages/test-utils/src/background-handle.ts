import * as v from 'valibot';
import type { AdoptsJobs, BackgroundHandle } from '@kinu.run/core';

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

/** An actor's jobs where a fixture keeps none: a process it would start is refused, as one past the job cap is. */
export const NO_JOBS: AdoptsJobs = {
  adopt: async () => ({ detached: false, reason: 'this fixture keeps no jobs' }),
};

/** An actor's jobs with room for every process it starts, each taken under one fixture id; nothing drives them. */
export const JOBS_WITH_ROOM: AdoptsJobs = {
  adopt: async (request) => ({ detached: true, jobId: request.jobId }),
};
