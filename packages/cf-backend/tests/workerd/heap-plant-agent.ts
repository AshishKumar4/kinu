/**
 * Main's isolate as `scripts/worker-heap.ts` loads it: the shipped facet, a buffer the gate plants in it to prove it
 * reads this isolate's heap, not another's, and the count of its tool calls that came back failed.
 */
import { parseJsonValue, type JsonValue } from '@kinu.run/core';
import { AgentFacet as Shipped } from '../../src/agent-facet/agent-facet';

/** Held for the isolate's life, as a leak would be. */
const planted: Uint8Array[] = [];

/** The tool results in `value` that carry an error: a call whose execution rejected, as the model was told of it. */
function failedResults(value: JsonValue): number {
  if (Array.isArray(value)) return value.reduce<number>((sum, each) => sum + failedResults(each), 0);

  if (typeof value !== 'object' || value === null) return 0;
  const { output } = value;

  const failed = value.type === 'tool-result' && typeof output === 'object' && output !== null && !Array.isArray(output)
    && (output.type === 'error-text' || output.type === 'error-json');

  return (failed ? 1 : 0) + Object.values(value).reduce<number>((sum, each) => sum + failedResults(each), 0);
}

export class AgentFacet extends Shipped {
  async plant(bytes: number): Promise<void> {
    planted.push(new Uint8Array(bytes).fill(7));
  }

  /** Its tool calls that came back failed, over every step its ledger records. */
  async failedToolCalls(): Promise<number> {
    let failed = 0;

    for (const row of this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM run_events WHERE type = 'step_finish'")) {
      failed += failedResults(parseJsonValue(row.payload));
    }

    return failed;
  }
}
