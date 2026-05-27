// Sleep-time compute — between-turn background memory compression.
//
// Paper: "Sleep-time Compute: Beyond Inference Scaling at Test-time"
// (arXiv:2504.13171). Productized as Letta's sleep-time agents. Reported
// ~50% test-time token reduction at matched performance on a coding task.
//
// Mechanism: while the agent is idle between user turns, a background fork
// re-reads recent activity and rewrites the agent_facts world model + the
// scratch memory block so the next turn starts from a denser, cleaner state.
// The user never waits for this — it runs as fire-and-forget in onTurnCompleteAsync.
//
// Proteus implements this as a thin layer on top of the existing background
// review (`EvolutionEngine.onTurnCompleteAsync`) — same fork, additional work.
//
// Outputs:
//   - Updated agent_facts (upsert new observations, decay stale facts)
//   - Compressed `scratch` context block (last turn's findings summarized)
//   - Optional working_set update (rotating LRU of active items)

import type { LLM } from '../types/primitives.js';
import type { FactsStore } from './facts.js';

export interface SleepTimeInput {
  /** Last completed turn's task. */
  task: string;
  /** Last turn's assistant output. */
  output: string;
  /** Tool calls that ran during the turn (names only — full args/results elided). */
  toolCalls: string[];
  /** Current facts to consider for update/decay. */
  currentFacts: ReadonlyArray<{ key: string; value: unknown; confidence: number }>;
}

export interface SleepTimeUpdate {
  /** Facts to upsert or update. */
  upserts: Array<{ key: string; value: unknown; confidence: number; rationale: string }>;
  /** Fact keys to decay confidence on (stale / not re-observed). */
  decay: string[];
  /** Compressed scratch block (will replace, not append). */
  scratchUpdate?: string;
  /** Items to add to working_set (rotating LRU). */
  workingSetAdds?: string[];
}

const PROMPT = (i: SleepTimeInput) => `You are a background memory-compression agent. Between user turns, you
update the agent's persistent state so the next turn starts smarter.

Recent turn:
- Task: ${i.task.slice(0, 1000)}
- Output: ${i.output.slice(0, 2000)}
- Tools used: ${i.toolCalls.join(', ') || '(none)'}

Current facts in agent's world model:
${i.currentFacts.slice(0, 30).map(f => `  ${f.key} = ${typeof f.value === 'string' ? f.value : JSON.stringify(f.value)} (conf ${f.confidence.toFixed(2)})`).join('\n') || '  (none)'}

Decide:
1. What new facts should be remembered from this turn? (user preferences,
   project state, dates, URLs, current configuration). Upsert with high
   confidence (0.8–1.0). DON'T duplicate existing facts.
2. Which existing facts should DECAY (lower confidence) because they weren't
   re-observed in this turn and may be stale? List their keys.
3. Compress the turn's findings into a 100–300 word scratchpad summary the
   next turn can read.

Respond ONLY with this JSON:
{
  "upserts": [{"key": "...", "value": ..., "confidence": 0.8, "rationale": "..."}],
  "decay": ["fact-key-1", "fact-key-2"],
  "scratchUpdate": "<100-300 words>",
  "workingSetAdds": ["short item 1", "short item 2"]
}`;

export async function runSleepTimeCompute(
  judge: LLM,
  input: SleepTimeInput,
): Promise<SleepTimeUpdate | null> {
  try {
    const text = await judge.complete(PROMPT(input));
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as Partial<SleepTimeUpdate>;
    return {
      upserts: Array.isArray(parsed.upserts) ? parsed.upserts.filter(u =>
        u && typeof u.key === 'string' && u.key.length > 0 && typeof u.confidence === 'number'
      ) : [],
      decay: Array.isArray(parsed.decay)
        ? parsed.decay.filter((k): k is string => typeof k === 'string' && k.length > 0)
        : [],
      scratchUpdate: typeof parsed.scratchUpdate === 'string' ? parsed.scratchUpdate : undefined,
      workingSetAdds: Array.isArray(parsed.workingSetAdds)
        ? parsed.workingSetAdds.filter((s): s is string => typeof s === 'string')
        : undefined,
    };
  } catch {
    return null;
  }
}

/** Apply a SleepTimeUpdate to the facts store + (optionally) the Think
 *  Session blocks via a host-provided setBlock callback. The block-write is
 *  optional because tests / non-CF runtimes may not have Think Session. */
export function applySleepTimeUpdate(
  facts: FactsStore,
  update: SleepTimeUpdate,
  setBlock?: (name: string, content: string) => void | Promise<void>,
): { upserted: number; decayed: number; blocksWritten: number; skipped: number } {
  // Pre-flight: drop any upserts whose value can't be serialized. Without
  // this, the first bad value crashes the loop and leaves the store in a
  // partial state (some upserted, the rest unprocessed).
  const safeUpserts = update.upserts.filter((u) => {
    if (typeof u.key !== 'string' || u.key.length === 0) return false;
    try { JSON.stringify(u.value); return true; }
    catch { return false; }
  });
  const skipped = update.upserts.length - safeUpserts.length;
  let upserted = 0;
  for (const u of safeUpserts) {
    facts.upsert(u.key, u.value, { confidence: u.confidence, source: 'sleep-time-compute' });
    upserted++;
  }
  // Decay = re-upsert with lower confidence (preserves value, weakens belief).
  let decayed = 0;
  for (const k of update.decay) {
    const cur = facts.recall(k);
    if (!cur) continue;
    facts.upsert(k, cur.value, {
      confidence: Math.max(0, cur.confidence - 0.2),
      source: cur.source,
    });
    decayed++;
  }
  let blocksWritten = 0;
  if (setBlock) {
    if (update.scratchUpdate) {
      const r = setBlock('scratch', update.scratchUpdate);
      if (r instanceof Promise) void r;
      blocksWritten++;
    }
    if (update.workingSetAdds && update.workingSetAdds.length > 0) {
      const r = setBlock('working_set', update.workingSetAdds.map((s, i) => `${i + 1}. ${s}`).join('\n'));
      if (r instanceof Promise) void r;
      blocksWritten++;
    }
  }
  return { upserted, decayed, blocksWritten, skipped };
}
