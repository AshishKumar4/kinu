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
// CADENCE, not every turn. One turn is thin evidence — a fresh workspace's
// "hello" produced two facts restating an empty workspace — and a model call
// per turn is the cost. A run is due on any of three triggers, all decided by
// {@link sleepTimeDue}, and every trigger reads the same evidence: the
// completed turns since the last run, oldest first, at most
// `SLEEP_TIME_CADENCE.everyTurns` of them ({@link sleepTimeWindow}).
//
//   1. Turn count — the third completed turn since the last run.
//   2. Idle — a completed turn followed by `SLEEP_TIME_CADENCE.idleMs` with no
//      new user input.
//   3. Tab closed — the actor's last client connection closed and stayed
//      closed for `SLEEP_TIME_CADENCE.closeGraceMs`; a reload reopens inside it.
//
// A workspace's first turn never runs it. The explicit `memory save` tool is
// the path for anything a user wants kept now.
//
// Kinu implements this as a sibling of the detached outcome review
// (`AgentOrchestrator`'s detached `engine.reviewTurn`) — same forked pattern, additional work.
// The keyed world model is its lever; long-conversation summarization is owned
// by Session compaction (configureSession), so there is no parallel prose summary.
//
// Output: updated agent_facts (upsert new observations, decay stale facts).

import * as v from 'valibot';
import type { LLM } from '../types/primitives';
import type { FactsStore } from './facts';
import { normalizeFactKey } from './facts';
import type { TranscriptRow } from '../utils/ui-message';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured';
import { tolerate } from '../obs/index';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window';
import { JsonValueSchema, type JsonValue } from '../utils/json';

/** The cadence, as one record: the three thresholds {@link sleepTimeDue}
 *  compares against, published together so a backend and a test read the
 *  same numbers the rule does. */
export const SLEEP_TIME_CADENCE = {
  /** A run is due once this many completed turns have accrued since the last
   *  one, and no run reads more than this many turns. */
  everyTurns: 3,
  /** A completed turn followed by this long with no new user input is due. */
  idleMs: 10 * 60_000,
  /** The grace after the last client connection closes: a reload reopens
   *  inside it and runs nothing; a connection that stays gone runs the
   *  pending turns. */
  closeGraceMs: 60_000,
} as const;

/** What one trigger evaluation knows. The two durations are absent when their
 *  trigger is not the one asking — a turn-count check carries neither. */
export interface SleepTimeTrigger {
  /** Completed turns of this actor's conversation. */
  readonly completedTurns: number;
  /** `completedTurns` as it stood when the last run landed; null before any run. */
  readonly lastRunTurn: number | null;
  /** Milliseconds since the last turn completed with no user input since. */
  readonly idleMs?: number;
  /** Milliseconds since the last client connection closed with none reopened. */
  readonly lastConnectionClosedMs?: number;
}

/**
 * Whether a run is due — the ONE rule every trigger asks.
 *
 * Never on a workspace's first turn, and never with nothing unprocessed: an
 * idle or closed-tab wake over turns a run already read would pay for the
 * model call and change nothing.
 */
export function sleepTimeDue(trigger: SleepTimeTrigger): boolean {
  if (trigger.completedTurns < 2) return false;
  const unprocessed = trigger.completedTurns - (trigger.lastRunTurn ?? 0);

  if (unprocessed <= 0) return false;

  return unprocessed >= SLEEP_TIME_CADENCE.everyTurns
    || (trigger.idleMs ?? 0) >= SLEEP_TIME_CADENCE.idleMs
    || (trigger.lastConnectionClosedMs ?? 0) >= SLEEP_TIME_CADENCE.closeGraceMs;
}

/**
 * When a backend's durable wake for the timed triggers is owed, or null.
 *
 * `settledAt` is when the newest UNPROCESSED turn completed — a backend records
 * it when a completed turn is left unprocessed and clears it when a run lands,
 * so its presence is what says a wake has work behind it. `closedAt` is when
 * the last client connection closed while that was so. The fold answers the
 * same question the wake's phase asks, which is what keeps an armed wake from
 * firing every second over nothing.
 */
export function sleepTimeWakeAt(arm: { readonly settledAt: number | null; readonly closedAt: number | null }): number | null {
  if (arm.settledAt === null) return null;
  const idle = arm.settledAt + SLEEP_TIME_CADENCE.idleMs;

  return arm.closedAt === null ? idle : Math.min(idle, arm.closedAt + SLEEP_TIME_CADENCE.closeGraceMs);
}

/** One completed turn as the compute reads it. */
export interface SleepTimeTurn {
  /** What the user asked — the opening message and any steer that landed. */
  readonly task: string;
  /** The assistant's answer. */
  readonly output: string;
  /** Tool calls that ran during the turn (names only — full args/results elided). */
  readonly toolCalls: readonly string[];
}

/** The evidence one run reads, and the counts the trigger rule needs. */
export interface SleepTimeWindow {
  /** Completed turns in the rows read. A caller that bounds its read gets a
   *  count that saturates at the bound, and every comparison the rule makes
   *  is against {@link SLEEP_TIME_CADENCE.everyTurns} or 2, so a read covering one
   *  more answer than the interval decides the same way the whole transcript
   *  would. */
  readonly completedTurns: number;
  readonly lastRunTurn: number | null;
  /** The newest completed turn's answer id — the key a run over this window is
   *  recorded under, so the next window starts after it. Null with no turn. */
  readonly newestId: string | null;
  /** The turns since the last run, oldest first, at most {@link SLEEP_TIME_CADENCE.everyTurns}. */
  readonly turns: readonly SleepTimeTurn[];
  /** A user row newer than every answer: a turn admitted and not yet answered,
   *  so the conversation is not idle whatever the clock says. */
  readonly inputPending: boolean;
}

/**
 * The window over a transcript, read newest first.
 *
 * A turn is an assistant row and the user rows before it back to the previous
 * answer — the opening message and its steers. User rows newer than the newest
 * answer are a turn still running and belong to no window. `processed` is the
 * durable record that a run was keyed on that answer; the walk stops there,
 * because everything older was that run's evidence or an earlier one's.
 */
export function sleepTimeWindow(
  newestFirst: readonly TranscriptRow[],
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
    inputPending: newestFirst.length > 0 && newestFirst[0]!.role === 'user',
  };
}

export interface SleepTimeInput {
  /** The completed turns since the last run, oldest first. */
  turns: readonly SleepTimeTurn[];
  /** Current facts to consider for update/decay. */
  currentFacts: ReadonlyArray<{ key: string; value: JsonValue; confidence: number }>;
}

export interface SleepTimeUpdate {
  /** Facts to upsert or update. */
  upserts: Array<{ key: string; value: JsonValue; confidence: number; rationale: string }>;
  /** Fact keys to decay confidence on (stale / not re-observed). */
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

/** The model's answer, and equally what a caller that PERSISTED one reads back: a
 *  stored update is a model output from an earlier activation, so it is parsed
 *  rather than trusted — the whole point of storing it is that nobody re-derives
 *  it. Exported for that second reader; a duplicate schema beside it would be a
 *  second answer to what an update is. */
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
  // The judge call's own failure belongs to the caller: laundering a failed LLM
  // request into "the model said nothing useful" is how a broken fast model
  // reads as a quiet turn. Only the model's ANSWER may be unusable, and null is
  // what that means.
  const text = await judge.complete(PROMPT(input));
  const object = tolerate(() => extractJsonObject(text), 'malformed-input');
  const update = v.safeParse(SleepTimeUpdateSchema, object);

  return update.success ? update.output : null;
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
