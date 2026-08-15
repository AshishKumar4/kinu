// Sleep-time compute — between-turn background memory compression.
//
// Paper: "Sleep-time Compute: Beyond Inference Scaling at Test-time"
// (arXiv:2504.13171). Productized as Letta's sleep-time agents. Reported
// ~50% test-time token reduction at matched performance on a coding task.
//
// Mechanism: while the agent is idle between user turns, a background fork
// re-reads recent activity and rewrites the agent_facts world model so the
// next turn starts from a denser, cleaner state. The user never waits for this
// — it runs fire-and-forget after the turn completes.
//
// Proteus implements this as a sibling of the detached outcome review
// (`AgentOrchestrator`'s detached `engine.reviewTurn`) — same forked pattern, additional work.
// The keyed world model is its lever; long-conversation summarization is owned
// by Session compaction (configureSession), so there is no parallel prose summary.
//
// Output: updated agent_facts (upsert new observations, decay stale facts).

import * as v from 'valibot';
import type { LLM } from '../types/primitives.js';
import type { FactsStore } from './facts.js';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured.js';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window.js';
import { JsonValueSchema, type JsonValue } from '../utils/json.js';

export interface SleepTimeInput {
  /** Last completed turn's task. */
  task: string;
  /** Last turn's assistant output. */
  output: string;
  /** Tool calls that ran during the turn (names only — full args/results elided). */
  toolCalls: string[];
  /** Current facts to consider for update/decay. */
  currentFacts: ReadonlyArray<{ key: string; value: JsonValue; confidence: number }>;
}

export interface SleepTimeUpdate {
  /** Facts to upsert or update. */
  upserts: Array<{ key: string; value: JsonValue; confidence: number; rationale: string }>;
  /** Fact keys to decay confidence on (stale / not re-observed). */
  decay: string[];
}

const PROMPT = (i: SleepTimeInput) => `You are a background memory-compression agent. Between user turns, you
update the agent's persistent state so the next turn starts smarter.

Recent turn:
- Task: ${evidenceWindow(i.task, EVIDENCE_BUDGETS.outcomeUserMessage)}
- Output: ${evidenceWindow(i.output, EVIDENCE_BUDGETS.outcomeAssistantResponse)}
- Tools used: ${i.toolCalls.join(', ') || '(none)'}

Current facts in agent's world model:
${i.currentFacts.slice(0, 30).map((fact) => {
  const text = v.safeParse(v.string(), fact.value);
  return `  ${fact.key} = ${text.success ? text.output : JSON.stringify(fact.value)} (conf ${fact.confidence.toFixed(2)})`;
}).join('\n') || '  (none)'}

Existing fact keys (reuse these exact keys when updating the same subject; do not mint variants):
${i.currentFacts.map(f => `  ${f.key}`).join('\n') || '  (none)'}

Decide:
1. What new facts should be remembered from this turn? (user preferences,
   project state, dates, URLs, current configuration). Upsert with high
   confidence (0.8–1.0). DON'T duplicate existing facts.
2. Which existing facts should DECAY (lower confidence) because they weren't
   re-observed in this turn and may be stale? List their keys.

JSON shape:
{
  "upserts": [{"key": "...", "value": ..., "confidence": 0.8, "rationale": "..."}],
  "decay": ["fact-key-1", "fact-key-2"]
}
${jsonObjectOnlyInstruction()}`;

const SleepTimeUpdateSchema: v.GenericSchema<SleepTimeUpdate> = v.object({
  upserts: v.array(v.object({
    key: v.pipe(v.string(), v.minLength(1)),
    value: JsonValueSchema,
    confidence: v.number(),
    rationale: v.string(),
  })),
  decay: v.array(v.pipe(v.string(), v.minLength(1))),
});

function normalizeFactKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, '_');
}

export async function runSleepTimeCompute(
  judge: LLM,
  input: SleepTimeInput,
): Promise<SleepTimeUpdate | null> {
  try {
    const text = await judge.complete(PROMPT(input));
    return v.parse(SleepTimeUpdateSchema, extractJsonObject(text));
  } catch {
    return null;
  }
}

/** Apply a SleepTimeUpdate to the facts store. */
export function applySleepTimeUpdate(
  facts: FactsStore,
  update: SleepTimeUpdate,
) {
  // Whitespace-only keys can pass the textual schema but normalize to no key.
  const safeUpserts = update.upserts.flatMap((u) => {
    const key = normalizeFactKey(u.key);
    if (key.length === 0) return [];
    return [{ ...u, key }];
  });
  const skipped = update.upserts.length - safeUpserts.length;
  let upserted = 0;
  for (const u of safeUpserts) {
    const result = facts.upsert(u.key, u.value, {
      confidence: u.confidence,
      source: 'sleep-time-compute',
    });
    if (result !== 'unchanged') upserted++;
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
  return { upserted, decayed, skipped };
}
