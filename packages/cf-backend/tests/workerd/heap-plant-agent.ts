/**
 * Main's isolate as `scripts/worker-heap.ts` loads it: the shipped facet, a buffer the gate plants in it to prove it
 * reads this isolate's heap, not another's, and the count of its tool calls that came back failed.
 */
import { parseJsonValue, type JsonValue } from '@kinu.run/core';
import { AgentFacet as Shipped } from '../../src/agent-facet/agent-facet';

/** Held for the isolate's life, as a leak would be. */
const planted: Uint8Array[] = [];

/** The tool results in `value` that carry an error: a call whose execution rejected, as the model was told of it. */
/** The ids of the failed tool results in `value`: a call is one failure however many times its result is stored. */
function failedResults(value: JsonValue, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const each of value) failedResults(each, into);

    return;
  }

  if (typeof value !== 'object' || value === null) return;
  const { output, toolCallId } = value;

  const failed = value.type === 'tool-result' && typeof output === 'object' && output !== null && !Array.isArray(output)
    && (output.type === 'error-text' || output.type === 'error-json');

  if (failed && typeof toolCallId === 'string') into.add(toolCallId);

  for (const each of Object.values(value)) failedResults(each, into);
}

export class AgentFacet extends Shipped {
  async plant(bytes: number): Promise<void> {
    planted.push(new Uint8Array(bytes).fill(7));
  }

  /** Its tool calls that came back failed, over every step its ledger records. */
  async failedToolCalls(): Promise<number> {
    const failed = new Set<string>();

    // A step's tool results are its transcript's tool messages; a step's run event names them by reference only.
    for (const row of this.ctx.storage.sql.exec<{ content_json: string }>("SELECT content_json FROM session_messages WHERE role = 'tool' AND content_json IS NOT NULL")) {
      failedResults(parseJsonValue(row.content_json), failed);
    }

    return failed.size;
  }
}
