/**
 * Compaction types — shared between core and adapters.
 */

export interface CompactableMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly id?: string;
  readonly toolName?: string;
}

export interface CompactionConfig {
  /** When false, shouldCompact() always returns false. Default true. */
  enabled?: boolean;
  /** Token headroom; never compact within `contextWindow - reserveTokens`. Default 20000. */
  reserveTokens?: number;
  /** Total tokens of recent tail to preserve verbatim. Default 8000. */
  keepRecentTokens?: number;
  /** Count of first-N messages to preserve verbatim. Default 3. */
  keepFirstMessages?: number;
  /** Rough chars-per-token estimator (used when no explicit token counter). Default 4. */
  charsPerToken?: number;
  /** Model id for the summarization call. Adapter-specific. */
  summarizationModel?: string;
}

export interface CompactionResult {
  /** The new messages array (head + summary message + tail). */
  readonly messages: CompactableMessage[];
  /** The LLM-generated summary text. */
  readonly summary: string;
  /** How many middle messages were dropped + replaced. */
  readonly droppedCount: number;
}

/** Summarize a sequence of messages into a single string. Adapter-supplied. */
export type SummarizeFn = (messages: readonly CompactableMessage[]) => Promise<string>;
