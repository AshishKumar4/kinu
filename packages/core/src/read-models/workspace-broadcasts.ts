/**
 * The frames a workspace broadcasts to every client of its socket, decoded once here: the browser and the terminal
 * read the same contract, and each renders the frames it shows. A frame of the chat transport itself is the
 * transport's, not this module's.
 */
import * as v from 'valibot';
import { JobOutputFrameSchema } from '../jobs/live-output';
import { PlanReviewSchema } from '../plans/review';
import { PROVIDER_WAIT_SOURCES } from '../providers/types';
import { SLATES_CHANGED_EVENT } from '../slates/rpc';
import { WorkspacePlanReferenceSchema } from '../subordinates/inspection';
import { LIVE_READS, READS_CHANGED_EVENT } from './live-reads';
import { TurnClaimFrameSchema } from './turn-liveness';
import { CHANGES_MOVED_EVENT } from './workspace-diff';

const MctsRowSchema = v.object({
  id: v.string(),
  parent_id: v.nullable(v.string()),
  root_id: v.optional(v.nullable(v.string())),
  depth: v.number(),
  visits: v.number(),
  value: v.number(),
  own_score: v.nullable(v.number()),
  status: v.picklist(['open', 'pruned', 'terminal', 'failed', 'running']),
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

const MctsProgressFrameSchema = v.object({
  type: v.literal('mcts-progress'),
  rootId: v.string(),
  isolateGen: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  pushSeq: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  nodes: v.array(MctsRowSchema),
  head: v.nullable(MctsProgressHeadSchema),
});

export type MctsProgress = v.InferOutput<typeof MctsProgressFrameSchema>;

export const SubordinateActivityEventSchema = v.object({
  type: v.literal('subordinate_event'),
  id: v.string(),
  kind: v.picklist(['task', 'report']),
  subordinate: v.string(),
  status: v.optional(v.string()),
  content: v.string(),
  task: v.optional(v.string()),
  timestamp: v.number(),
});

/** Exported so a pushing caller (the gallery fixture) builds the frame through this schema. */
export const WorkspacePlanUpdatedFrameSchema = v.strictObject({
  type: v.literal('workspace_plan_updated'),
  reference: WorkspacePlanReferenceSchema,
});

const BranchStatusFrameSchema = v.variant('status', [
  v.object({ type: v.literal('branch_status'), status: v.literal('running'), branchId: v.string(), task: v.string() }),
  v.object({
    type: v.literal('branch_status'), status: v.literal('settled'), branchId: v.string(), task: v.string(),
    takeSetId: v.string(), turnId: v.string(),
  }),
  v.object({
    type: v.literal('branch_status'), status: v.literal('error'), branchId: v.string(), task: v.string(),
    message: v.optional(v.string(), 'branch failed'),
  }),
]);

export const WorkspaceBroadcastSchema = v.variant('type', [
  v.object({ type: v.literal('workspace_renamed'), displayName: v.optional(v.string()) }),
  MctsProgressFrameSchema,
  v.object({
    type: v.literal('device_consent'), consentId: v.string(), deviceLabel: v.string(),
    method: v.optional(v.string()), command: v.string(),
    workspaceName: v.optional(v.nullable(v.string())),
  }),
  v.object({ type: v.literal('device_consent_resolved'), consentId: v.string() }),
  v.object({
    type: v.literal('device_unavailable'),
    devices: v.array(v.object({ id: v.string(), label: v.string(), lastSeenAt: v.nullable(v.number()) })),
  }),
  v.object({ type: v.literal('device_available'), deviceId: v.string(), label: v.string() }),
  v.object({ type: v.literal('model_fallback'), message: v.string() }),
  // Waiting on the provider (429/529 sleep, backoff, sibling cooldown), not thinking. `attempt` is 0 when the wait
  // precedes the first attempt.
  v.object({
    type: v.literal('provider_wait'),
    provider: v.string(),
    modelId: v.optional(v.string()),
    waitMs: v.number(),
    attempt: v.number(),
    status: v.optional(v.number()),
    source: v.picklist(PROVIDER_WAIT_SOURCES),
    actorId: v.optional(v.string()),
  }),
  v.object({ type: v.literal('work_cancelled') }),
  v.object({ type: v.literal(READS_CHANGED_EVENT), reads: v.array(v.picklist(LIVE_READS)) }),
  JobOutputFrameSchema,
  v.object({ type: v.literal(SLATES_CHANGED_EVENT), ids: v.array(v.string()) }),
  v.object({ type: v.literal(CHANGES_MOVED_EVENT) }),
  BranchStatusFrameSchema,
  v.object({ type: v.literal('head_activity'), headId: v.string() }),
  /** Best-effort paint of a head's provider deltas; the durable step is the truth. */
  v.object({
    type: v.literal('head_stream'), headId: v.string(),
    kind: v.picklist(['text', 'reasoning']), delta: v.string(),
  }),
  v.object({
    type: v.literal('steer_status'), steerId: v.string(), text: v.string(),
    status: v.picklist(['queued', 'landed', 'returned', 'turn']),
    /** On `landed`: the step the model read it in. */
    atStep: v.optional(v.number()),
    /** A hosted actor's own steer carries its actor; the workspace's carries none. */
    actorId: v.optional(v.string()),
  }),
  /** Loose: `parseSignalCardEvent` owns the payload; the socket reads only the actor stamp. */
  v.looseObject({ type: v.literal('signal_card'), actorId: v.optional(v.string()) }),
  v.object({ type: v.literal('plan_updated'), plan: PlanReviewSchema }),
  WorkspacePlanUpdatedFrameSchema,
  TurnClaimFrameSchema,
  SubordinateActivityEventSchema,
  v.object({ type: v.literal('context_fill'), contextTokens: v.optional(v.number()), contextWindow: v.optional(v.number()) }),
  v.object({
    type: v.literal('executor-output'), executor: v.string(), command: v.string(),
    stdout: v.optional(v.string()), stderr: v.optional(v.string()),
    exitCode: v.optional(v.number()), timestamp: v.number(),
  }),
]);

export type WorkspaceBroadcast = v.InferOutput<typeof WorkspaceBroadcastSchema>;
