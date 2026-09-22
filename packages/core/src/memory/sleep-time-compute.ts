// Sleep-time compute (arXiv:2504.13171): between turns, a background fork rewrites agent_facts
// so the next turn starts from a denser state. Runs on a cadence ({@link sleepTimeDue}), never
// on a workspace's first turn; long-conversation summarization belongs to Session compaction.

import * as v from 'valibot';
import type { LLM } from '../types/primitives';
import type { FactsStore } from './facts';
import { normalizeFactKey } from './facts';
import type { ConversationProjection } from '../session/transcript';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured';
import { tolerate } from '../obs/index';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window';
import { JsonValueSchema, type JsonValue } from '../utils/json';

export const SLEEP_TIME_CADENCE = {
  everyTurns: 3,
  idleMs: 10 * 60_000,
  closeGraceMs: 60_000,
} as const;

export interface SleepTimeTrigger {
  readonly completedTurns: number;
  readonly lastRunTurn: number | null;
  readonly idleMs?: number;
  readonly lastConnectionClosedMs?: number;
}

/** Never on a workspace's first turn, and never with nothing unprocessed. */
export function sleepTimeDue(trigger: SleepTimeTrigger): boolean {
  if (trigger.completedTurns < 2) return false;
  const unprocessed = trigger.completedTurns - (trigger.lastRunTurn ?? 0);

  if (unprocessed <= 0) return false;

  return unprocessed >= SLEEP_TIME_CADENCE.everyTurns
    || (trigger.idleMs ?? 0) >= SLEEP_TIME_CADENCE.idleMs
    || (trigger.lastConnectionClosedMs ?? 0) >= SLEEP_TIME_CADENCE.closeGraceMs;
}

/** `settledAt` is set only while a completed turn is unprocessed, so an armed wake never fires over nothing. */
export function sleepTimeWakeAt(arm: { readonly settledAt: number | null; readonly closedAt: number | null }): number | null {
  if (arm.settledAt === null) return null;
  const idle = arm.settledAt + SLEEP_TIME_CADENCE.idleMs;

  return arm.closedAt === null ? idle : Math.min(idle, arm.closedAt + SLEEP_TIME_CADENCE.closeGraceMs);
}

export interface SleepTimeTurn {
  readonly task: string;
  readonly output: string;
  readonly toolCalls: readonly string[];
}

export interface SleepTimeWindow {
  /** Saturates at the caller's read bound; a read covering `everyTurns` + 1 answers decides as the full transcript would. */
  readonly completedTurns: number;
  readonly lastRunTurn: number | null;
  /** Key the run is recorded under; the next window starts after it. */
  readonly newestId: string | null;
  readonly turns: readonly SleepTimeTurn[];
  /** A pending user row: the conversation is not idle whatever the clock says. */
  readonly inputPending: boolean;
}

/** The walk stops at the answer the last run was keyed on; user rows newer than the newest answer belong to no window. */
export function sleepTimeWindow(
  newestFirst: readonly ConversationProjection[],
  processed: (answerId: string) => boolean,
): SleepTimeWindow {
  let completedTurns = 0;

  for (const row of newestFirst) if (row.role === 'assistant') completedTurns++;
  const since: SleepTimeTurn[] = [];
  let current: { output: string; toolCalls: readonly string[]; task: string[] } | null = null;
  let lastRunTurn: number | null = null;

  const close = (): void => {
    if (current === null) return;
    since.push({ task: current.task.reverse().join('\n'), output: current.output, toolCalls: current.toolCalls });
    current = null;
  };

  for (const row of newestFirst) {
    if (row.role === 'assistant') {
      close();

      if (processed(row.id)) {
        lastRunTurn = completedTurns - since.length;
        break;
      }

      current = { output: row.content, toolCalls: row.toolCalls, task: [] };
    } else if (current !== null) {
      current.task.push(row.content);
    }
  }

  close();
  const newest = newestFirst.find((row) => row.role === 'assistant');

  return {
    completedTurns,
    lastRunTurn,
    newestId: newest?.id ?? null,
    turns: since.slice(0, SLEEP_TIME_CADENCE.everyTurns).reverse(),
    inputPending: newestFirst.length > 0 && newestFirst[0].role === 'user',
  };
}

export interface SleepTimeInput {
  turns: readonly SleepTimeTurn[];
  currentFacts: ReadonlyArray<{ key: string; value: JsonValue; confidence: number }>;
}

export interface SleepTimeUpdate {
  upserts: Array<{ key: string; value: JsonValue; confidence: number; rationale: string }>;
  decay: string[];
}

const renderTurn = (turn: SleepTimeTurn, index: number): string => `Turn ${index + 1}:
- Task: ${evidenceWindow(turn.task, EVIDENCE_BUDGETS.outcomeUserMessage)}
- Output: ${evidenceWindow(turn.output, EVIDENCE_BUDGETS.outcomeAssistantResponse)}
- Tools used: ${turn.toolCalls.join(', ') || '(none)'}`;

const PROMPT = (i: SleepTimeInput) => `You are a background memory-compression agent. Between user turns, you
update the agent's persistent state so the next turn starts smarter.

You distill reusable, durable knowledge only: what the user told the agent
about themselves, their project, their constraints and preferences; decisions
made; workflows, pitfalls and resolved failures the agent found. You NEVER
record transient chatter, greetings, restatements of the conversation, what
is unknown or not yet said, or the state of a new or empty workspace. Most
turns carry no durable signal; then you return empty upserts.

Recent turns (oldest first):
${i.turns.map(renderTurn).join('\n\n') || '(none)'}

Current facts in agent's world model:
${i.currentFacts.slice(0, 30).map((fact) => {
  const text = v.safeParse(v.string(), fact.value);

  return `  ${fact.key} = ${text.success ? text.output : JSON.stringify(fact.value)} (conf ${fact.confidence.toFixed(2)})`;
}).join('\n') || '  (none)'}

Existing fact keys (reuse these exact keys when updating the same subject; do not mint variants):
${i.currentFacts.map(f => `  ${f.key}`).join('\n') || '  (none)'}

Decide:
1. What durable facts did these turns establish? (user preferences, project
   state, dates, URLs, current configuration). Upsert with high confidence
   (0.8–1.0). DON'T duplicate existing facts.
2. Which existing facts should DECAY (lower confidence) because they weren't
   re-observed in these turns and may be stale? List their keys.

JSON shape:
{
  "upserts": [{"key": "...", "value": ..., "confidence": 0.8, "rationale": "..."}],
  "decay": ["fact-key-1", "fact-key-2"]
}
${jsonObjectOnlyInstruction()}`;

/** Also parses persisted updates: a stored update is model output and is not trusted. */
export const SleepTimeUpdateSchema: v.GenericSchema<SleepTimeUpdate> = v.object({
  upserts: v.array(v.object({
    key: v.pipe(v.string(), v.minLength(1)),
    value: JsonValueSchema,
    confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    rationale: v.string(),
  })),
  decay: v.array(v.pipe(v.string(), v.minLength(1))),
});

export async function runSleepTimeCompute(
  judge: LLM,
  input: SleepTimeInput,
): Promise<SleepTimeUpdate | null> {
  // Judge-call failures propagate; only an unusable answer maps to null.
  const text = await judge.complete(PROMPT(input));
  const object = tolerate(() => extractJsonObject(text), 'malformed-input');
  const update = v.safeParse(SleepTimeUpdateSchema, object);

  return update.success ? update.output : null;
}

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
