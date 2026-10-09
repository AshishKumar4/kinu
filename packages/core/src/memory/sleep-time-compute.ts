// Sleep-time compute (arXiv:2504.13171): between turns, a fork rewrites agent_facts and proposes the account's; the lane is
// orchestrator/sleep-time-lane.ts. Its rules are mnemopi's extraction prompt (oh-my-pi 317f2b8653, MIT,
// packages/coding-agent/src/prompts/system/memory-extraction-system.md): stated, stable facts only, never inferred.

import * as v from 'valibot';
import { Effect } from 'effect';
import type { LLM } from '../types/primitives';
import type { FactsStore, Veracity } from './facts';
import { normalizeFactKey, VERACITIES } from './facts';
import type { AccountProposal } from './account';
import { turnAuthor } from '../utils/ui-message';
import type { ConversationProjection } from '../session/transcript';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../providers/structured';
import { KinuError, settleSync } from '../obs/index';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../utils/evidence-window';
import { JsonValueSchema, type JsonValue } from '../utils/json';
import { SLEEP_TIME_PROMPT_OPENING } from '../utils/prompt-sections';

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
  /** The owner's own words in the turn (`turnAuthor` operator): the only source an account fact is proposed from. */
  readonly ownerWords: string;
}

export interface SleepTimeWindow {
  /** Saturates at the caller's read bound. */
  readonly completedTurns: number;
  readonly lastRunTurn: number | null;
  /** Key the run is recorded under; the next window starts after it. */
  readonly newestId: string | null;
  readonly turns: readonly SleepTimeTurn[];
  /** A pending user row: the conversation is not idle whatever the clock says. */
  readonly inputPending: boolean;
}

/** Stops at the answer the last run was keyed on; user rows past the newest answer are in no window. */
export function sleepTimeWindow(
  newestFirst: readonly ConversationProjection[],
  processed: (answerId: string) => boolean,
): SleepTimeWindow {
  let completedTurns = 0;

  for (const row of newestFirst) if (row.role === 'assistant') completedTurns++;
  const since: SleepTimeTurn[] = [];
  let current: { output: string; toolCalls: readonly string[]; task: string[]; owner: string[] } | null = null;
  let lastRunTurn: number | null = null;

  const close = (): void => {
    if (current === null) return;
    since.push({ task: current.task.reverse().join('\n'), output: current.output, toolCalls: current.toolCalls, ownerWords: current.owner.reverse().join('\n') });
    current = null;
  };

  for (const row of newestFirst) {
    if (row.role === 'assistant') {
      close();

      if (processed(row.id)) {
        lastRunTurn = completedTurns - since.length;
        break;
      }

      current = { output: row.content, toolCalls: row.toolCalls, task: [], owner: [] };
    } else if (current !== null) {
      current.task.push(row.content);

      if (turnAuthor(row) === 'operator') current.owner.push(row.content);
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
  /** The account's facts, so a proposal reuses their keys and never repeats one; absent where no account is wired. */
  accountFacts?: ReadonlyArray<{ key: string; value: JsonValue }>;
}

export interface SleepTimeUpdate {
  upserts: Array<{ key: string; value: JsonValue; confidence: number; rationale: string; importance?: number; veracity?: Veracity }>;
  decay: string[];
  /** Facts about the owner themselves, for the owner to approve; never written by this pass. */
  account?: Array<{ key: string; value: JsonValue; importance?: number; rationale: string }>;
}

const renderTurn = (turn: SleepTimeTurn, index: number): string => `Turn ${index + 1}:
- Task: ${evidenceWindow(turn.task, EVIDENCE_BUDGETS.outcomeUserMessage)}
- Owner's own words: ${turn.ownerWords === '' ? '(none: the task came from the harness or another agent)' : evidenceWindow(turn.ownerWords, EVIDENCE_BUDGETS.outcomeUserMessage)}
- Output: ${evidenceWindow(turn.output, EVIDENCE_BUDGETS.outcomeAssistantResponse)}
- Tools used: ${turn.toolCalls.join(', ') || '(none)'}`;

const renderFactLine = (fact: { key: string; value: JsonValue }): string => {
  const text = v.safeParse(v.string(), fact.value);

  return `  ${fact.key} = ${text.success ? text.output : JSON.stringify(fact.value)}`;
};

/** The account section, only where an account is wired. */
const ACCOUNT_PROMPT = (i: SleepTimeInput): string => (i.accountFacts === undefined ? '' : `

The owner's account memory, shared by every workspace and agent of theirs:
${i.accountFacts.map(renderFactLine).join('\n') || '  (none)'}

3. Which facts about the OWNER THEMSELVES did the owner's own words state? Their
   name, preferences, how they want answers, standing instructions to every
   agent, and the people and projects in their life. Only from "Owner's own
   words", never from a task the harness or an agent wrote, and never what is
   only about this workspace's project. These go to "account" and are only
   proposed: the owner approves each before it is kept. Reuse an account key
   when the same subject changed; skip one the account already holds as is.`);

const PROMPT = (i: SleepTimeInput) => `${SLEEP_TIME_PROMPT_OPENING} Between user turns, you
update the agent's persistent state so the next turn starts smarter.

You distill reusable, durable knowledge only: what the user told the agent
about themselves, their project, their constraints and preferences; decisions
made; workflows, pitfalls and resolved failures the agent found. You NEVER
record transient chatter, greetings, restatements of the conversation, what
is unknown or not yet said, or the state of a new or empty workspace. Most
turns carry no durable signal; then you return empty upserts.

Keep only what is explicitly stated: stable facts, explicit instructions,
stable preferences, dates, deadlines, paths, ports and versions. Never infer,
explain or invent; ignore greetings, acknowledgements and one-off plans. When
a value is corrected, keep only the latest. Preserve names, numbers, paths,
versions, dates and the original language exactly.

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
   (0.8-1.0). DON'T duplicate existing facts. "importance" (0 to 1) is how much
   it matters when recalled; "veracity" is "stated" when the turns say it
   outright and "tool" when it was read from a tool's output.
2. Which existing facts should DECAY (lower confidence) because they weren't
   re-observed in these turns and may be stale? List their keys.${ACCOUNT_PROMPT(i)}

JSON shape:
{
  "upserts": [{"key": "...", "value": ..., "confidence": 0.8, "importance": 0.5, "veracity": "stated", "rationale": "..."}],
  "decay": ["fact-key-1", "fact-key-2"]${i.accountFacts === undefined ? '' : ',\n  "account": [{"key": "...", "value": ..., "importance": 0.7, "rationale": "..."}]'}
}
${jsonObjectOnlyInstruction()}`;

/** Also parses persisted updates: a stored update is model output and is not trusted. */
const Unit = v.pipe(v.number(), v.minValue(0), v.maxValue(1));

export const SleepTimeUpdateSchema: v.GenericSchema<SleepTimeUpdate> = v.object({
  upserts: v.array(v.object({
    key: v.pipe(v.string(), v.minLength(1)),
    value: JsonValueSchema,
    confidence: Unit,
    rationale: v.string(),
    importance: v.optional(Unit),
    veracity: v.optional(v.picklist(VERACITIES)),
  })),
  decay: v.array(v.pipe(v.string(), v.minLength(1))),
  account: v.optional(v.array(v.object({
    key: v.pipe(v.string(), v.minLength(1)),
    value: JsonValueSchema,
    importance: v.optional(Unit),
    rationale: v.string(),
  }))),
});

export async function runSleepTimeCompute(
  judge: LLM,
  input: SleepTimeInput,
): Promise<SleepTimeUpdate> {
  const text = await judge.complete(PROMPT(input));

  return settleSync(Effect.try({
    try: () => v.parse(SleepTimeUpdateSchema, extractJsonObject(text)),
    catch: (cause) => new KinuError('bad_input', 'the sleep-time compute returned no usable update', { cause }),
  }));
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
      ...(u.importance !== undefined && { importance: u.importance }),
      veracity: u.veracity ?? 'stated',
      origin: { by: 'background' },
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

/**
 * The account facts an update proposes, held to the window that produced it: none unless the owner spoke in it, as the
 * pass reads the owner's words and nothing else for the account. Keys normalized; an empty one is dropped.
 */
export function accountProposals(update: SleepTimeUpdate, turns: readonly SleepTimeTurn[]): AccountProposal[] {
  if (!turns.some((turn) => turn.ownerWords.trim() !== '')) return [];

  return (update.account ?? []).flatMap((fact) => {
    const key = normalizeFactKey(fact.key);

    return key === '' ? [] : [{ kind: 'fact' as const, key, value: fact.value, ...(fact.importance !== undefined && { importance: fact.importance }) }];
  });
}

