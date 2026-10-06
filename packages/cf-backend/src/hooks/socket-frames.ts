import { useEffect, useRef } from "react";
import * as v from "valibot";
import {
  CHANGES_MOVED_EVENT, JobOutputFrameSchema, LIVE_READS, PlanReviewSchema, PROVIDER_WAIT_SOURCES,
  READS_CHANGED_EVENT, SLATES_CHANGED_EVENT, TurnClaimFrameSchema, WorkspacePlanReferenceSchema,
} from "@kinu.run/core";
import { Effect } from "effect";
import { detach, tolerate } from "@kinu.run/core/obs";

const MctsRowSchema = v.object({
  id: v.string(),
  parent_id: v.nullable(v.string()),
  root_id: v.optional(v.nullable(v.string())),
  depth: v.number(),
  visits: v.number(),
  value: v.number(),
  own_score: v.nullable(v.number()),
  status: v.picklist(["open", "pruned", "terminal", "failed", "running"]),
  action: v.string(),
  task: v.string(),
  observation: v.string(),
  created_at: v.optional(v.number()),
});

const MctsProgressUsageSchema = v.object({
  input: v.optional(v.number()),
  output: v.optional(v.number()),
  cacheRead: v.optional(v.number()),
  cacheWrite: v.optional(v.number()),
  cacheWrite1h: v.optional(v.number()),
  reasoning: v.optional(v.number()),
  neurons: v.optional(v.number()),
});

const MctsProgressHeadSchema = v.object({
  rootId: v.string(),
  task: v.string(),
  rationale: v.string(),
  status: v.string(),
  spawnedAt: v.number(),
  heads: v.array(v.object({
    id: v.string(),
    parentId: v.nullable(v.string()),
    depth: v.number(),
    task: v.string(),
    rationale: v.string(),
    status: v.string(),
    summary: v.nullable(v.string()),
    errorMessage: v.nullable(v.string()),
    usage: MctsProgressUsageSchema,
    wallClockMs: v.number(),
    spawnedAt: v.number(),
    lastStepAt: v.nullable(v.number()),
    decisions: v.array(v.object({
      question: v.string(),
      choice: v.string(),
      rationale: v.string(),
    })),
  })),
  merge: v.nullable(v.object({
    narrative: v.string(),
  })),
});

const MctsProgressMessageSchema = v.object({
  type: v.literal("mcts-progress"),
  rootId: v.string(),
  isolateGen: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  pushSeq: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  nodes: v.array(MctsRowSchema),
  head: v.nullable(MctsProgressHeadSchema),
});

export type MctsProgress = v.InferOutput<typeof MctsProgressMessageSchema>;

export const SubordinateActivityEventSchema = v.object({
  type: v.literal("subordinate_event"),
  id: v.string(),
  kind: v.picklist(["task", "report"]),
  subordinate: v.string(),
  status: v.optional(v.string()),
  content: v.string(),
  task: v.optional(v.string()),
  timestamp: v.number(),
});

/** Exported so a pushing caller (the gallery fixture) builds the frame through this schema;
 *  a stale event name would otherwise be silently dropped. */

export const WorkspacePlanUpdatedFrameSchema = v.strictObject({
  type: v.literal("workspace_plan_updated"),
  reference: WorkspacePlanReferenceSchema,
});

const SocketMessageSchema = v.variant("type", [
  v.object({ type: v.literal("workspace_renamed"), displayName: v.optional(v.string()) }),
  // Arrival is what the chat pane waits on; the payload is the SDK's business.
  v.looseObject({ type: v.literal("cf_agent_chat_messages") }),
  v.object({
    type: v.literal("cf_agent_use_chat_response"),
    error: v.optional(v.boolean()), done: v.optional(v.boolean()), body: v.optional(v.string()),
    id: v.optional(v.string()),
  }),
  // For a retained terminal record the id is the failed turn's, matching the error frame that
  // follows: that tells a replay from a live failure.
  v.object({ type: v.literal("cf_agent_stream_resuming"), id: v.string() }),
  MctsProgressMessageSchema,
  v.object({
    type: v.literal("device_consent"), consentId: v.string(), deviceLabel: v.string(),
    method: v.optional(v.string()), command: v.string(),
    workspaceName: v.optional(v.nullable(v.string())),
  }),
  v.object({ type: v.literal("device_consent_resolved"), consentId: v.string() }),
  v.object({
    type: v.literal("device_unavailable"),
    devices: v.array(v.object({ id: v.string(), label: v.string(), lastSeenAt: v.nullable(v.number()) })),
  }),
  v.object({ type: v.literal("device_available"), deviceId: v.string(), label: v.string() }),
  v.object({ type: v.literal("model_fallback"), message: v.string() }),
  // Waiting on the provider (429/529 sleep, backoff, sibling cooldown), not thinking. `attempt`
  // is 0 when the wait precedes the first attempt.
  v.object({
    type: v.literal("provider_wait"),
    provider: v.string(),
    modelId: v.optional(v.string()),
    waitMs: v.number(),
    attempt: v.number(),
    status: v.optional(v.number()),
    source: v.picklist(PROVIDER_WAIT_SOURCES),
    actorId: v.optional(v.string()),
  }),
  v.object({ type: v.literal("work_cancelled") }),
  v.object({ type: v.literal(READS_CHANGED_EVENT), reads: v.array(v.picklist(LIVE_READS)) }),
  JobOutputFrameSchema,
  v.object({ type: v.literal(SLATES_CHANGED_EVENT), ids: v.array(v.string()) }),
  v.object({ type: v.literal(CHANGES_MOVED_EVENT) }),
  v.object({
    type: v.literal("branch_status"), branchId: v.string(), task: v.optional(v.string()),
    status: v.optional(v.string()), takeSetId: v.optional(v.string()),
    turnId: v.optional(v.string()), message: v.optional(v.string()),
  }),
  v.object({ type: v.literal("head_activity"), headId: v.string() }),
  /** Best-effort paint of a head's provider deltas; the durable step is the truth. */
  v.object({
    type: v.literal("head_stream"), headId: v.string(),
    kind: v.picklist(["text", "reasoning"]), delta: v.string(),
  }),
  v.object({
    type: v.literal("steer_status"), steerId: v.string(), text: v.string(),
    status: v.picklist(["queued", "landed", "returned", "turn"]),
    /** On `landed`: the step the model read it in. */
    atStep: v.optional(v.number()),
    /** Declared so `v.object` keeps the stamp; see {@link admitsActorFrame}. */
    actorId: v.optional(v.string()),
  }),
  /** Loose: {@link parseSignalCardEvent} owns the payload; this hook reads only the actor stamp. */
  v.looseObject({ type: v.literal("signal_card"), actorId: v.optional(v.string()) }),
  v.object({ type: v.literal("plan_updated"), plan: PlanReviewSchema }),
  WorkspacePlanUpdatedFrameSchema,
  TurnClaimFrameSchema,
  SubordinateActivityEventSchema,
  v.object({
    type: v.literal("executor-output"), executor: v.string(), command: v.string(),
    stdout: v.optional(v.string()), stderr: v.optional(v.string()),
    exitCode: v.optional(v.number()), timestamp: v.number(),
  }),
]);

export type SocketFrame = v.InferOutput<typeof SocketMessageSchema>;

/** Which actor a pane speaks for: the workspace's own, or one hosted agent once its id is known. */
export interface PaneIdentity {
  readonly isSubordinate: boolean;
  readonly ownActorId: string | null;
}

function parseSocketMessage(data: MessageEvent["data"]) {
  const text = v.safeParse(v.string(), data);

  if (!text.success) return null;

  // Non-JSON is not ours; any other failure is a real fault, not "no message".
  const decoded = v.safeParse(
    SocketMessageSchema,
    tolerate<unknown>(() => JSON.parse(text.output), "malformed-input"),
  );

  return decoded.success ? decoded.output : null;
}

/**
 * One Durable Object broadcasts to every socket, so hosted actors' frames (`signal_card`,
 * `steer_status`) carry an actor stamp. Unstamped frames are the workspace's own. `provider_wait`'s
 * `actorId` is not ownership. The workspace pane admits no stamped frame; an agent pane admits
 * its own actor's; an unresolved pane admits none.
 */
function admitsActorFrame(msg: SocketFrame, pane: PaneIdentity): boolean {
  if (msg.type !== "signal_card" && msg.type !== "steer_status") return true;

  if (msg.actorId === undefined) return true;

  return pane.isSubordinate && pane.ownActorId === msg.actorId;
}

/** The socket's one reader: one parse per frame, then `paneFrame` only for what the pane may see. Never re-subscribes. */
export function useSocketFrames(socket: EventTarget, pane: () => PaneIdentity, receivers: {
  readonly everyFrame: (frame: SocketFrame) => void;
  readonly paneFrame: (frame: SocketFrame) => Promise<void>;
}): void {
  const latest = useRef({ pane, receivers });
  latest.current = { pane, receivers };

  useEffect(() => {
    const received = (event: Event) => detach(Effect.promise(async () => {
      const frame = event instanceof MessageEvent ? parseSocketMessage(event.data) : null;

      if (frame === null) return;
      const { receivers: now, pane: identity } = latest.current;

      now.everyFrame(frame);

      if (admitsActorFrame(frame, identity())) await now.paneFrame(frame);
    }));

    socket.addEventListener("message", received);

    return () => socket.removeEventListener("message", received);
  }, [socket]);
}
