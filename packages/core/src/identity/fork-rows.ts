/** Workspace fork row shapes; queries live in fork-plan, fork-transfer and fork-writer. */

import * as v from 'valibot';
import { JsonValueSchema } from '../utils/json';

// Canonical declaration: TS types and the fork-transfer frame union derive from these schemas. All JSON-serializable.

/** The source identity and the cut entry: the fork's lineage parent and boundary. */
export const ForkSnapshotHeadSchema = v.object({
  source: v.object({ workspaceId: v.string(), workspaceName: v.string() }),
  cut: v.object({ messageId: v.string(), createdAtMs: v.number() }),
});

/**
 * One carried sealed message. `request_id`, `output_slot` and `ingress_id` do not cross (target stores null);
 * `content_path` crosses relative to the source artifact directory and is re-rooted under the target's.
 */
export const ForkSessionMessageRowSchema = v.object({
  message_id: v.string(),
  role: v.picklist(['system', 'user', 'assistant', 'tool']),
  native_content_kind: v.picklist(['string', 'parts']),
  origin: v.picklist(['input', 'output', 'edit', 'context_transform', 'render']),
  envelope_json: v.string(),
  sealed_at: v.number(),
  content_json: v.nullable(v.string()),
  content_path: v.nullable(v.string()),
  content_digest: v.nullable(v.string()),
});

/** One entry of the carried chat, oldest first. Session and context columns do not cross;
 *  the write stamps the session and points the cut entry at the fork's fresh context. */
export const ForkConversationEntryRowSchema = v.object({
  id: v.string(),
  position: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  role: v.picklist(['user', 'assistant', 'system', 'tool']),
  turn_id: v.nullable(v.string()),
  run_id: v.nullable(v.string()),
  metadata_json: v.nullable(v.string()),
  metadata_path: v.nullable(v.string()),
  metadata_digest: v.nullable(v.string()),
  recorded_at: v.number(),
});

/** One part reference of one carried entry: which message, which part. */
export const ForkConversationEntryPartRowSchema = v.object({
  entry_id: v.string(),
  position: v.number(),
  message_id: v.string(),
  part_no: v.number(),
  text_start: v.nullable(v.number()),
  text_length: v.nullable(v.number()),
});

/** One member of the cut entry's working context; positions are the model's message order. */
export const ForkContextMemberRowSchema = v.object({
  entry_id: v.string(),
  position: v.number(),
  message_id: v.string(),
});

/** One crafted tool, snapshotted; the fork evolves it independently. */
export const ForkCraftedToolRowSchema = v.object({
  name: v.string(),
  description: v.string(),
  code: v.string(),
  created_at: v.number(),
  updated_at: v.number(),
});

/** One actor_config row; shell-approval keys are withheld at the source's read (fork-sections.ts). */
export const ForkConfigRowSchema = v.object({ key: v.string(), value: v.string() });

/** One lesson as it stood at the cut: one corroborated after it crosses provisional. Its turns are cited by id. */
export const ForkLessonRowSchema = v.object({
  id: v.string(),
  turn_ids: v.string(),
  text: v.string(),
  source: v.string(),
  status: v.picklist(['provisional', 'corroborated']),
  created_at: v.number(),
  corroborated_at: v.nullable(v.number()),
});

/** One tool lesson at its current revision: the store keeps no earlier one. */
export const ForkToolLessonRowSchema = v.object({
  id: v.string(),
  tool: v.string(),
  text: v.string(),
  revision: v.number(),
  helpful: v.number(),
  harmful: v.number(),
  turn_ids: v.string(),
  status: v.picklist(['active', 'retired']),
  created_at: v.number(),
  updated_at: v.number(),
});

/** One memory fact as last observed: the store keeps no earlier value. */
export const ForkFactRowSchema = v.object({
  key: v.string(),
  value_json: v.string(),
  confidence: v.number(),
  source: v.nullable(v.string()),
  last_observed_at: v.number(),
  importance: v.number(),
  veracity: v.string(),
  origin_json: v.nullable(v.string()),
});

/** One of the `db` tool's tables, as its declaration's JSON text (the store checks it as it checks any declaration),
 *  and when the source declared it, which orders the fork's listing as it ordered the source's. */
export const ForkAppTableRowSchema = v.object({ declaration: v.string(), created_at: v.number() });

/** One row of one of the `db` tool's tables, in the store's own codec (a blob as base64, JSON decoded). */
export const ForkAppRowSchema = v.object({ table: v.string(), row: v.record(v.string(), JsonValueSchema) });

export type ForkSnapshotHead = v.InferOutput<typeof ForkSnapshotHeadSchema>;

export type ForkSessionMessageRow = v.InferOutput<typeof ForkSessionMessageRowSchema>;

export type ForkConversationEntryRow = v.InferOutput<typeof ForkConversationEntryRowSchema>;

export type ForkConversationEntryPartRow = v.InferOutput<typeof ForkConversationEntryPartRowSchema>;

export type ForkContextMemberRow = v.InferOutput<typeof ForkContextMemberRowSchema>;


export type ForkCraftedToolRow = v.InferOutput<typeof ForkCraftedToolRowSchema>;

export type ForkConfigRow = v.InferOutput<typeof ForkConfigRowSchema>;

export type ForkLessonRow = v.InferOutput<typeof ForkLessonRowSchema>;

export type ForkToolLessonRow = v.InferOutput<typeof ForkToolLessonRowSchema>;

export type ForkFactRow = v.InferOutput<typeof ForkFactRowSchema>;

export type ForkAppRow = v.InferOutput<typeof ForkAppRowSchema>;

export type ForkAppTableRow = v.InferOutput<typeof ForkAppTableRowSchema>;
