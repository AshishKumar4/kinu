/**
 * When a streamed step's buffered output is written: the stream buffer and a backend's tab-replay store
 * flush at the same stream positions, so a resumed step and a reconnecting tab agree on what survived.
 */
import type { TextStreamPart, ToolSet, UIMessageChunk } from 'ai';

const FLUSH_EVERY = 10;

export type PartialFlushSignal = 'content' | 'settled' | 'none';

/** First content flushes, then every {@link FLUSH_EVERY}, and a settled tool result at once; a step boundary resets. */
export interface PartialFlushCadence {
  flushes(signal: PartialFlushSignal): boolean;
  reset(): void;
}

export function partialFlushCadence(): PartialFlushCadence {
  let sinceFlush = 0;
  let flushedContent = false;

  return {
    flushes: (signal) => {
      if (signal === 'none') return false;
      sinceFlush += 1;

      if (signal !== 'settled' && flushedContent && sinceFlush < FLUSH_EVERY) return false;
      sinceFlush = 0;
      flushedContent = true;

      return true;
    },
    reset: () => {
      sinceFlush = 0;
      flushedContent = false;
    },
  };
}

/** Model stream parts and the UI chunks the SDK makes of them, by type: each part and its chunk weigh the same. */
const SETTLED: ReadonlySet<string> = new Set(['tool-result', 'tool-error', 'tool-output-denied', 'tool-output-available', 'tool-output-error']);

const CONTENT: ReadonlySet<string> = new Set(['text-delta', 'reasoning-delta', 'tool-call', 'tool-input-available']);

export function flushSignal(part: TextStreamPart<ToolSet> | UIMessageChunk): PartialFlushSignal {
  if (SETTLED.has(part.type)) return 'settled';

  return CONTENT.has(part.type) ? 'content' : 'none';
}
