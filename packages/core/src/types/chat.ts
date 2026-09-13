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
});

export type ChatHistoryEntry = v.InferOutput<typeof ChatHistoryEntrySchema>;
