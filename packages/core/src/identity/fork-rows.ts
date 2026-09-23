/** Workspace fork row shapes; queries live in fork-plan, fork-transfer and fork-writer. */

import * as v from 'valibot';

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
  recorded_at: v.number(),
  envelope_json: v.string(),
  sealed_at: v.number(),
  content_json: v.nullable(v.string()),
  content_path: v.nullable(v.string()),
  content_digest: v.nullable(v.string()),
});

/** One entry of the carried chain, root first. Session and context columns do not cross;
 *  the write stamps the session and points the cut entry at the fork's fresh context. */
export const ForkConversationEntryRowSchema = v.object({
  id: v.string(),
  parent_id: v.nullable(v.string()),
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

/** One row of the FTS content table behind memory search. */
export const ForkMemoryChunkRowSchema = v.object({
  id: v.string(),
  path: v.string(),
  start_line: v.number(),
  end_line: v.number(),
  hash: v.string(),
  text: v.string(),
  updated_at: v.number(),
});

/** One crafted tool, snapshotted; the fork evolves it independently. */
export const ForkCraftedToolRowSchema = v.object({
  name: v.string(),
  description: v.string(),
  params: v.nullable(v.string()),
  code: v.string(),
  scope: v.string(),
  created_at: v.number(),
  updated_at: v.number(),
});

/** One actor_config row; shell-approval keys are withheld at the read in {@link snapshotWorkspaceForFork}. */
export const ForkConfigRowSchema = v.object({ key: v.string(), value: v.string() });

/** One inherited file, read through the workspace filesystem. */
const ForkFileSchema = v.object({ path: v.string(), content: v.string() });

/**
 * Everything a fork copies, for the in-process fork; a hosted fork streams instead (fork-transfer.ts).
 * `artifacts` are relative to the owning artifact directory, `files` are workspace paths.
 */
const ForkSnapshotSchema = v.object({
  ...ForkSnapshotHeadSchema.entries,
  sessionMessages: v.array(ForkSessionMessageRowSchema),
  conversationEntries: v.array(ForkConversationEntryRowSchema),
  conversationEntryParts: v.array(ForkConversationEntryPartRowSchema),
  contextMembers: v.array(ForkContextMemberRowSchema),
  files: v.array(ForkFileSchema),
  artifacts: v.array(ForkFileSchema),
  memoryChunks: v.array(ForkMemoryChunkRowSchema),
  craftedTools: v.array(ForkCraftedToolRowSchema),
  agentConfig: v.array(ForkConfigRowSchema),
});

export type ForkSnapshotHead = v.InferOutput<typeof ForkSnapshotHeadSchema>;

export type ForkSnapshot = v.InferOutput<typeof ForkSnapshotSchema>;

export type ForkSessionMessageRow = v.InferOutput<typeof ForkSessionMessageRowSchema>;

export type ForkConversationEntryRow = v.InferOutput<typeof ForkConversationEntryRowSchema>;

export type ForkConversationEntryPartRow = v.InferOutput<typeof ForkConversationEntryPartRowSchema>;

export type ForkContextMemberRow = v.InferOutput<typeof ForkContextMemberRowSchema>;

export type ForkMemoryChunkRow = v.InferOutput<typeof ForkMemoryChunkRowSchema>;

export type ForkCraftedToolRow = v.InferOutput<typeof ForkCraftedToolRowSchema>;

export type ForkConfigRow = v.InferOutput<typeof ForkConfigRowSchema>;

export type ForkFile = v.InferOutput<typeof ForkFileSchema>;
