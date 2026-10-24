/** One schedule a workspace blueprint seeds (`blueprints/workspace.ts`), as the workspace keeps its watchers. */
import * as v from 'valibot';
import { ScheduleTierSchema } from './profile';
import { WatchCheckSchema } from './watch';

export const BlueprintScheduleSchema = v.object({
  label: v.string(),
  cron: v.string(),
  /** The IANA zone whose wall clock `cron` names; absent, UTC. */
  timeZone: v.optional(v.string()),
  /** The connection (an MCP preset id) the schedule watches: it runs only while the owner holds it. */
  connection: v.optional(v.string()),
  prompt: v.string(),
  /** Makes it a watcher, as `agent.schedule`'s check does: only what the check found wakes the agent (`events/ingress/watch.ts`). */
  check: v.optional(WatchCheckSchema),
  tier: v.optional(ScheduleTierSchema),
});

export type BlueprintSchedule = v.InferOutput<typeof BlueprintScheduleSchema>;
