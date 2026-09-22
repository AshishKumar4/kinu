import * as v from 'valibot';
import { JsonObjectSchema } from '../utils/json';

export const ChatHistoryEntrySchema = v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  role: v.picklist(['user', 'assistant', 'system']),
  content: v.string(),
  createdAt: v.union([v.string(), v.number()]),
  /** Author and event markers must survive paging as well as live delivery. */
  metadata: v.optional(JsonObjectSchema),
  /** Content spilled to a file its actor no longer has a bound plane for; drawn as unavailable. */
  unavailable: v.optional(v.literal(true)),
});

export type ChatHistoryEntry = v.InferOutput<typeof ChatHistoryEntrySchema>;
