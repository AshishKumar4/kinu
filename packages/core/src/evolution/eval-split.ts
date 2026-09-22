/** Budgeted, disjoint GEPA train/val split drawn from graded `turn_outcomes` turns; advisor notes backfill negatives. */

import * as v from 'valibot';
import type { ModelMessage } from 'ai';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { ToolCallRecord } from './types';
import {
  ADVISOR_CLASS_LABEL, ADVISOR_EVENT_TYPE, AdvisorRowDataSchema,
  type AdvisorNoteClass, type AdvisorSeverity,
} from '../advisor/review';
import { delegationFeatures, renderDelegationFeatures } from './delegation-features';
import { conversationTurnPair } from '../identity/conversation-store';
import type { SessionTranscriptReader } from '../session/transcript';
import { RunEventRecorder } from '../events/recorder';
import { parseJsonValue, projectJsonValue, JsonObjectSchema, type JsonValue } from '../utils/json';
import {
  listTurnOutcomes, NEGATIVE_TURN_OUTCOMES,
  type OutcomeEvalInstance, type OutcomeEvalSplit, type OutcomeSplitDegeneracy,
  type TurnOutcome, type TurnOutcomeRow,
} from './outcomes';

interface StoredRunEvent {
  type: string;
}

const StoredRunEventSchema = v.object({
  type: v.string(),
});

const ChatRunStartSchema = v.object({
  type: v.literal('run_start'),
  caused_by: v.literal('chat'),
  userMessage: v.string(),
});

/** Null when the row is not an event shape read here; non-JSON payloads propagate as ledger corruption. */
function parseRunEvent(payload: string): StoredRunEvent | null {
  const parsed = v.safeParse(StoredRunEventSchema, parseJsonValue(payload));

  return parsed.success ? parsed.output : null;
}

/** Tool calls from a turn's durable step transcript, paired on the provider's call id. */
function toolCallsFromTranscript(messages: readonly ModelMessage[]): ToolCallRecord[] {
  const results = new Map<string, JsonValue>();

  for (const message of messages) {
    if (message.role !== 'tool') continue;

    for (const part of message.content) {
      if (part.type === 'tool-result') results.set(part.toolCallId, projectJsonValue({ value: part.output }));
    }
  }

  const calls: ToolCallRecord[] = [];

  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;

    for (const part of message.content) {
      if (part.type !== 'tool-call') continue;
      const args = v.safeParse(JsonObjectSchema, part.input);
      calls.push({
        name: part.toolName,
        args: args.success ? args.output : {},
        result: results.get(part.toolCallId) ?? null,
      });
    }
  }

  return calls;
}

/** Non-scoring process evidence from the message + run ledgers. Read failures propagate: a catch would report "no tools ran". */
async function turnProcessEvidence(
  sql: SqlExecutor, actor: ActorHandle, transcript: SessionTranscriptReader, turnId: string | null,
): Promise<string | undefined> {
  if (!turnId) return undefined;
  const pair = await conversationTurnPair(transcript, turnId);

  if (!pair || pair.request === null || pair.startedAtMs === null) return undefined;

  const from = new Date(pair.startedAtMs).toISOString();
  const to = new Date(pair.endedAtMs).toISOString();
  // `run_events` is actor-scoped and nothing else re-verifies the binding before these reads.
  actor.assertCurrent();

  const starts = sql<{ runId: string; payload: string }>`
    SELECT run_id AS runId, payload FROM run_events
    WHERE actor_id = ${actor.actorId} AND type = 'run_start'
      AND ts >= ${from} AND ts <= ${to}
    ORDER BY ts DESC LIMIT 20`;

  const expectedUserMessage = pair.request.slice(0, 500);

  const runId = starts.find(({ payload }) => {
    const parsed = v.safeParse(ChatRunStartSchema, parseJsonValue(payload));

    return parsed.success && parsed.output.userMessage === expectedUserMessage;
  })?.runId;

  if (!runId) return undefined;

  const rows = sql<{ payload: string; ts: string }>`
    SELECT payload, ts FROM run_events
    WHERE actor_id = ${actor.actorId} AND run_id = ${runId}
    ORDER BY event_index`;

  const events = rows.map((row) => ({ event: parseRunEvent(row.payload), at: Date.parse(row.ts) }))
    .filter((row): row is { event: StoredRunEvent; at: number } => row.event !== null && Number.isFinite(row.at));

  if (events.length === 0) return undefined;

  const toolCalls = toolCallsFromTranscript(new RunEventRecorder(sql, actor).transcript(runId));
  const steps = events.filter(({ event }) => event.type === 'step_finish').length;
  const startAt = events.find(({ event }) => event.type === 'run_start')?.at ?? events[0].at;

  const endAt = [...events].reverse().find(({ event }) => event.type === 'run_end')?.at ??
    events[events.length - 1]?.at ?? startAt;

  return renderDelegationFeatures(delegationFeatures({
    toolCalls,
    steps,
    durationMs: Math.max(0, endAt - startAt),
  }));
}

/** An advisor-flagged turn the outcome ledger never graded (wakes, one-shots, serial work the ledger cannot see). */
export interface AdvisorNegativeRow {
  readonly id: string;
  readonly turnId: string;
  readonly note: string;
  readonly severity: AdvisorSeverity;
  readonly noteClass: AdvisorNoteClass;
  readonly userMessage: string;
  readonly assistantResponse: string;
  readonly createdAt: number;
}

interface RawAdvisorRow {
  id: string; note: string; data: string; createdAt: number; turnId: string;
}

/**
 * Advisor notes for turns absent from `turn_outcomes`, newest first. The `NOT EXISTS`
 * keeps a turn from landing in both train and val; notes with no transcript pair are
 * dropped; a payload failing `AdvisorRowDataSchema` throws.
 */
async function advisorNegatives(
  sql: SqlExecutor, actor: ActorHandle, transcript: SessionTranscriptReader, limit: number,
): Promise<AdvisorNegativeRow[]> {
  if (limit <= 0) return [];
  actor.assertCurrent();

  const rows = sql<RawAdvisorRow>`
    SELECT e.id AS id, e.message AS note, e.data AS data, e.created_at AS createdAt,
           json_extract(e.data, '$.turnId') AS turnId
    FROM evolution_events e
    WHERE e.actor_id = ${actor.actorId} AND e.type = ${ADVISOR_EVENT_TYPE}
      AND json_extract(e.data, '$.turnId') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM turn_outcomes o
        WHERE o.actor_id = ${actor.actorId}
          AND o.turn_id = json_extract(e.data, '$.turnId'))
    ORDER BY e.created_at DESC, e.id DESC LIMIT ${limit}`;

  const negatives: AdvisorNegativeRow[] = [];

  for (const row of rows) {
    const pair = await conversationTurnPair(transcript, row.turnId);

    if (!pair || pair.request === null) continue;
    const data = v.parse(AdvisorRowDataSchema, parseJsonValue(row.data));

    negatives.push({
      id: row.id,
      turnId: row.turnId,
      note: row.note,
      severity: data.severity,
      noteClass: data.class,
      userMessage: pair.request,
      assistantResponse: pair.response ?? '',
      createdAt: row.createdAt,
    });
  }

  return negatives;
}

/** Share of drawn failures held out of the reflection minibatch for scoring. */
const NEGATIVE_HOLDOUT_SHARE = 1 / 3;

interface EvalDraw {
  readonly rowId: string;
  readonly createdAt: number;
  readonly turnId: string | null;
  readonly input: string;
  readonly response: string;
  readonly outcome: TurnOutcome;
  readonly complaint: string | null;
  readonly critic: 'user' | 'advisor';
  readonly extraEvidence: readonly string[];
}

function ledgerDraw(row: TurnOutcomeRow): EvalDraw {
  return {
    rowId: row.id, createdAt: row.createdAt, turnId: row.turnId,
    input: row.userMessage, response: row.assistantResponse,
    outcome: row.outcome, complaint: row.followup, critic: 'user',
    extraEvidence: [],
  };
}

/** `corrected` is the verdict, not who gave it; `critic` carries who. */
function advisorDraw(row: AdvisorNegativeRow): EvalDraw {
  return {
    rowId: row.id, createdAt: row.createdAt, turnId: row.turnId,
    input: row.userMessage, response: row.assistantResponse,
    outcome: 'corrected', complaint: row.note, critic: 'advisor',
    extraEvidence: [
      `No user verdict. Flagged by the turn reviewer (${row.severity}): `
      + ADVISOR_CLASS_LABEL[row.noteClass],
    ],
  };
}

function splitDegeneracy(negatives: number, holdoutCount: number, valSize: number): OutcomeSplitDegeneracy | null {
  if (negatives === 0) return valSize === 0 ? 'no_labeled_turns' : 'no_negatives';

  if (holdoutCount === 0) return 'no_held_out_negatives';

  return null;
}

/** Draw a budgeted, disjoint train/val split. Negatives take up to half the budget;
 *  the newest go to `val` (temporal holdout), the rest to `train`. Accepted turns fill
 *  the rest as `val` regression guards. Advisor notes only backfill slots the ledger
 *  leaves empty. Too little evidence to hold out is reported via `degeneracy`. */
export async function buildOutcomeEvalSplit(
  sql: SqlExecutor, actor: ActorHandle, transcript: SessionTranscriptReader, budget: number,
): Promise<OutcomeEvalSplit> {
  const size = Math.max(2, Math.floor(budget));
  const ledgerNegatives = listTurnOutcomes(sql, actor, { limit: size, outcomes: NEGATIVE_TURN_OUTCOMES });
  const accepted = listTurnOutcomes(sql, actor, { limit: size, outcomes: ['accepted'] });
  const advisorRows = await advisorNegatives(sql, actor, transcript, size - ledgerNegatives.length);

  // Array.sort is stable, so equal-age rows keep their query order.
  const negatives = [...ledgerNegatives.map(ledgerDraw), ...advisorRows.map(advisorDraw)]
    .sort((a, b) => b.createdAt - a.createdAt);

  const negativeShare = Math.min(negatives.length, Math.ceil(size / 2));
  const acceptedCount = Math.min(accepted.length, size - negativeShare);
  const negativeCount = Math.min(negatives.length, size - acceptedCount);

  const toInstance = async (draw: EvalDraw, i: number, kind: string): Promise<OutcomeEvalInstance> => ({
    id: `${kind}-${i}-${draw.rowId}`,
    input: draw.input,
    evidence: [
      `Outcome: ${draw.outcome}`,
      ...draw.extraEvidence,
      await turnProcessEvidence(sql, actor, transcript, draw.turnId),
    ].filter((line): line is string => line !== undefined).join('\n'),
    expected: {
      outcome: draw.outcome,
      recordedResponse: draw.response,
      followup: draw.complaint,
      critic: draw.critic,
    },
  });

  const drawnNegatives = negatives.slice(0, negativeCount);

  // A single failure stays in train; selection is then blind to improvement.
  const holdoutCount = drawnNegatives.length >= 2
    ? Math.max(1, Math.round(drawnNegatives.length * NEGATIVE_HOLDOUT_SHARE))
    : 0;

  const train: OutcomeEvalInstance[] = [];

  for (const [i, draw] of drawnNegatives.slice(holdoutCount).entries()) train.push(await toInstance(draw, i, 'neg'));

  const val: OutcomeEvalInstance[] = [];

  for (const [i, draw] of drawnNegatives.slice(0, holdoutCount).entries()) val.push(await toInstance(draw, i, 'held'));

  for (const [i, row] of accepted.slice(0, acceptedCount).entries()) val.push(await toInstance(ledgerDraw(row), i, 'pos'));

  return {
    train, val,
    heldOutNegatives: holdoutCount,
    degeneracy: splitDegeneracy(drawnNegatives.length, holdoutCount, val.length),
  };
}
