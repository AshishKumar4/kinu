/**
 * Main's isolate as `scripts/worker-heap.ts` loads it: the shipped facet, a buffer the gate plants in it to prove it
 * reads this isolate's heap, not another's, the count of its tool calls that came back failed, and a fault the gate
 * arms in its advisor's model calls to read what an advisor's failure reaches.
 */
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai';
import { parseJsonValue, type JsonValue } from '@kinu.run/core';
import { AgentFacet as Shipped } from '../../src/agent-facet/agent-facet';
import type { AgentProviderDeps, AgentProviderRegistry } from '../../src/providers/agent-registry';

/** Each buffer the gate plants, under the marker it finds it by: held for the isolate's life, as a leak would be. */
const planted: Record<string, Uint8Array>[] = [];

/** What an armed advisor call does: `throw` fails the call; `uncaught` throws from a timer and rejects a promise no one
 *  awaits, then lets the call answer. */
export type AdvisorFault = 'throw' | 'uncaught';

/** Armed by the gate, for every advisor call from then on: module state, so an isolate reset disarms it. */
let armed: AdvisorFault | null = null;

/** Rejected promises kept and never awaited, as a forgotten one is. */
const unheard: Promise<never>[] = [];

/** The advisor's calls, alone, offer its `advise` tool. */
const ADVISOR_FAULT: LanguageModelMiddleware = {
  transformParams: async ({ params }) => {
    if (armed === null || !(params.tools ?? []).some((offered) => offered.name === 'advise')) return params;

    if (armed === 'throw') throw new Error('advisor fault probe: the call threw');
    setTimeout(() => { throw new Error('advisor fault probe: uncaught in a timer'); }, 0);
    unheard.push(Promise.reject(new Error('advisor fault probe: a rejection no one awaits')));

    return params;
  },
};

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
  async plant(marker: string, bytes: number): Promise<void> {
    planted.push({ [marker]: new Uint8Array(bytes).fill(7) });
  }

  /** The buffers planted since this isolate loaded: none after a reset. */
  async plantedCount(): Promise<number> {
    return planted.length;
  }

  async armAdvisorFault(fault: AdvisorFault | null): Promise<void> {
    armed = fault;
  }

  protected override models(deps: Omit<AgentProviderDeps, 'env'>): AgentProviderRegistry {
    const shipped = super.models(deps);

    return {
      ...shipped,
      resolveModel: (spec, affinity): LanguageModel => {
        const model = shipped.resolveModel(spec, affinity);

        return typeof model === 'string' ? model : wrapLanguageModel({ model, middleware: ADVISOR_FAULT });
      },
    };
  }

  /** Its tool calls that came back failed, over every step its ledger records. */
  async failedToolCalls(): Promise<number> {
    const failed = new Set<string>();
    const stepped = new Set<string>();

    // The tool messages the run's finished steps name, by reference: its ledger, not every message the transcript holds.
    for (const row of this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM run_events WHERE type = 'step_finish'")) {
      const step = parseJsonValue(row.payload);
      const parts = typeof step === 'object' && step !== null && !Array.isArray(step) ? step.parts : null;

      for (const part of Array.isArray(parts) ? parts : []) {
        if (typeof part === 'object' && part !== null && !Array.isArray(part) && typeof part.messageId === 'string') stepped.add(part.messageId);
      }
    }

    for (const row of this.ctx.storage.sql.exec<{ message_id: string; content_json: string }>("SELECT message_id, content_json FROM session_messages WHERE role = 'tool' AND content_json IS NOT NULL")) {
      if (stepped.has(row.message_id)) failedResults(parseJsonValue(row.content_json), failed);
    }

    return failed.size;
  }
}
