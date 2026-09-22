/**
 * Workspace fork — the row shapes, and nothing else.
 *
 * Declarations only: the reads in `identity/fork-plan.ts`, the wire in
 * `identity/fork-transfer.ts` and the write in `identity/fork-writer.ts` bring
 * the queries.
 */

import * as v from 'valibot';

/**
 * What a fork copies, as valibot schemas.
 *
 * These are the CANONICAL declaration. Every TypeScript type below is inferred
 * from them, and `identity/fork-transfer.ts` builds its frame union out of the
 * same row schemas — so the rows a fork reads, the rows it puts on a wire and
 * the rows it writes are one authority with no second transcription to drift.
 *
 * Everything is JSON-serializable, so a snapshot also survives a transport that
 * only carries structured clones.
 */

/** The source workspace's identity and the entry the fork is cut at — the
 *  fork's lineage parent, and its boundary. */
export const ForkSnapshotHeadSchema = v.object({
  source: v.object({ workspaceId: v.string(), workspaceName: v.string() }),
  cut: v.object({ messageId: v.string(), createdAtMs: v.number() }),
});

/**
 * One carried message, whole: its identity, its envelope and its sealed
 * content.
 *
 * `request_id`, `output_slot` and `ingress_id` are deliberately absent: a
 * request is a source-side execution record that does not cross, and an ingress
 * id is the admission identity of a turn the fork never ran. The target row
 * carries null for all three.
 *
 * `content_path` crosses RELATIVE to the source actor's artifact directory and
 * is re-rooted under the target's, because an absolute path names a directory
 * that belongs to the workspace it came from. Only a sealed message crosses: an
 * open one still streams, and a fork requires an idle source.
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

/**
 * One entry of the carried public chain, root first.
 *
 * `session_id` is not carried: the chain is by definition the chat session's,
 * and the write stamps it. The context columns are not carried either — they
 * name revisions of the SOURCE's context history, which does not cross; the
 * write points the cut entry at the fork's own fresh context instead.
 */
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

/** One member of the working context the cut entry recorded, at the revision it
 *  recorded. Positions are preserved: the membership IS the model's message
 *  order. */
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

/** One crafted tool, snapshotted — the fork evolves it independently. */
export const ForkCraftedToolRowSchema = v.object({
  name: v.string(),
  description: v.string(),
  params: v.nullable(v.string()),
  code: v.string(),
  scope: v.string(),
  created_at: v.number(),
  updated_at: v.number(),
});

/** One actor_config row. The shell-approval authority keys never appear here:
 *  they are withheld at the READ, in {@link snapshotWorkspaceForFork}. */
export const ForkConfigRowSchema = v.object({ key: v.string(), value: v.string() });

/** One inherited file. A fork carries FILES, read through the workspace
 *  filesystem rather than lifted out of one storage engine's row encoding. */
export const ForkFileSchema = v.object({ path: v.string(), content: v.string() });

/**
 * The whole of what a fork copies, in one value.
 *
 * This is what the IN-PROCESS fork uses, where both databases are open in the
 * same process and there is no wire to bound. A hosted fork never materializes
 * it on either side — see `identity/fork-transfer.ts`.
 *
 * `artifacts` are the payload files the carried rows reference, by a path
 * relative to the artifact directory that owns them; `files` are workspace
 * paths. Two lists rather than one flagged list, because the two paths are read
 * against different roots and a single list would make that depend on a field.
 */
export const ForkSnapshotSchema = v.object({
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
