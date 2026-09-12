/** The served chat-history row, declared at the platform layer: the status
 *  read-model writes it and the UI-message walk reads it. */

import type { JsonObject } from '../utils/json';

export interface ChatHistoryEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string | number;
  /**
   * The stored row's own metadata, where the row carried any.
   *
   * The chat classifies a programmatic turn from written markers — the author
   * stamp, the `kinuEvent` name — and for a row that arrived by this walk
   * rather than over the socket, this is the only place those markers can come
   * from. Dropping them is why a fork-interrupted notice kept its card while it
   * was live and lost it the moment the operator scrolled back to it.
   *
   * The field's one reader is the served transcript: `getChatHistoryPage`
   * feeds `mergeTranscript`, and the pane classifies the restored half from
   * it. The CLI reads stored rows only to rebuild the model's context, and
   * there the markers ride the row's own text, so it has no reader for this
   * field. That asymmetry is declared here on purpose, not omitted.
   */
  metadata?: JsonObject;
}
