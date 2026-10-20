/** What waits on the owner as an agent reads it (`agent.waitingOnOwner`), and the one-shot wait it can arm on it. */
import * as v from 'valibot';

export const OwnerWaitSchema = v.object({
  /** Stable across reads: what `agent.wakeWhenOwnerDone({ key })` names. */
  key: v.string(),
  kind: v.picklist(['command', 'write', 'plan', 'consent', 'question']),
  /** The ask in its own fields: the command, the file, the plan's title, the device and its command, or the
   *  questions asked. */
  what: v.string(),
  /** Epoch ms it was asked at. */
  since: v.number(),
  /** The agent that asked, by name; null for the workspace's own asks (a device consent). */
  askedBy: v.nullable(v.string()),
});

export type OwnerWait = v.InferOutput<typeof OwnerWaitSchema>;

/** Kept as the agent's actor_config row. `key`: the one row it waits on, with `what` it was; null, everything it reads. */
export const OwnerWaitWatchSchema = v.object({ id: v.string(), key: v.nullable(v.string()), what: v.nullable(v.string()), armedAt: v.number() });

export type OwnerWaitWatch = v.InferOutput<typeof OwnerWaitWatchSchema>;
