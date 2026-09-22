/** The served chat-history row, declared at the platform layer: the status
 *  read-model writes it and the UI-message walk reads it. */

import * as v from 'valibot';
import { JsonObjectSchema } from '../utils/json';

export const ChatHistoryEntrySchema = v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  role: v.picklist(['user', 'assistant', 'system']),
  content: v.string(),
  createdAt: v.union([v.string(), v.number()]),
  /** Author and event markers must survive paging as well as live delivery. */
  metadata: v.optional(JsonObjectSchema),
  /** The row exists and its content cannot be read by this reader: spilled to
   *  a file its actor no longer has a bound plane for. Drawn as unavailable. */
  unavailable: v.optional(v.literal(true)),
});

export type ChatHistoryEntry = v.InferOutput<typeof ChatHistoryEntrySchema>;
