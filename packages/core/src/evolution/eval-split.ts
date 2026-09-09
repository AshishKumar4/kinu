/**
 * GEPA / section-trial eval data — the budgeted, disjoint train/val split
 * drawn from the graded turns of the `turn_outcomes` ledger (upstream
 * gepa-ai/gepa eval discipline), with advisor notes backfilling the negatives
 * pool from turns the ledger never graded.
 */

import * as v from 'valibot';
import type { ModelMessage } from 'ai';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../state/actor-handle';
import type { ToolCallRecord } from './types';
import {
  ADVISOR_CLASS_LABEL, ADVISOR_EVENT_TYPE, AdvisorRowDataSchema,
  type AdvisorNoteClass, type AdvisorSeverity,
} from '../advisor/review';
import { delegationFeatures, renderDelegationFeatures } from './delegation-features';
import { conversationTurnPair, hasPaneStore } from '../identity/conversation-store';
import { RunEventRecorder } from '../events/recorder';
import { parseJsonValue, projectJsonValue, JsonObjectSchema, type JsonValue } from '../utils/json';
import { uiMessageText } from '../utils/ui-message';
import {
  listTurnOutcomes, NEGATIVE_TURN_OUTCOMES,
  type OutcomeEvalInstance, type OutcomeEvalSplit, type OutcomeSplitDegeneracy,
  type TurnOutcome, type TurnOutcomeRow,
} from './outcomes';

/** Only the discriminant and the timestamp are read here: what a turn DID now
 *  comes from the step transcript, not from event names. */
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

/** One stored run event, or null when the row is not an event shape this reads.
 *  A payload that is not JSON at all is corruption of a ledger this process
 *  wrote, so it propagates rather than being counted as "no such event". */
function parseRunEvent(payload: string): StoredRunEvent | null {
  const parsed = v.safeParse(StoredRunEventSchema, parseJsonValue(payload));
  return parsed.success ? parsed.output : null;
}

/**
 * The tool calls a turn's durable step transcript records — name, real
 * arguments, and the tool's own output, paired on the provider's call id.
 *
 * Reconstructing them from `tool_call_end` rows instead gave every call an
 * empty `args`, and `delegationFeatures`' fingerprint is null for an
 * argument-less call — so the redundancy and loop counts in a corpus row could
 * never be anything but zero, whatever the turn actually did.
 */
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

/** Reconstruct non-scoring process evidence from the existing message + run
 *  ledgers. Both tables are created by `initWorkspaceSchema` on every backend,
 *  so a failed read here is a real fault and is NOT caught: a blanket catch
 *  would report it as "this turn ran no tools". */
function turnProcessEvidence(
  sql: SqlExecutor, actor: ActorHandle, turnId: string | null,
): string | undefined {
  if (!turnId) return undefined;
  // INNER-join semantics preserved: a turn with no user row behind it has no
  // window and no evidence.
  const pair = conversationTurnPair(sql, actor, turnId);
  if (!pair || pair.request === null || pair.startedAtMs === null) return undefined;

  const from = new Date(pair.startedAtMs).toISOString();
  const to = new Date(pair.endedAtMs).toISOString();
  // One check for both raw reads below. `run_events` is actor-scoped and this is
  // a free function rather than a store, so nothing else re-verifies the binding
  // before the statements run.
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

  // The turn's real trajectory, from the rows written as each step finished.
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

/** A turn the advisor complained about and the outcome ledger never graded.
 *
 *  `turn_outcomes` grades a turn from the user's NEXT message, so three classes
 *  of turn are structurally ungradable by it: a programmatic wake, a one-shot
 *  invocation, and a turn where the agent ground serially through work a
 *  delegation or search capability was there for. Nothing in the follow-up
 *  says that. The advisor is a second model that read the turn as it happened
 *  and can. */
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
  id: string; note: string; data: string; createdAt: number;
  turnId: string; userMessage: string; assistantResponse: string;
}

/** The pane arm selects the raw serialized UI message under the same column
 *  names; its text parts are flattened here so both arms return one shape. */
function flattenAdvisorTexts(row: RawAdvisorRow): RawAdvisorRow {
  return {
    ...row,
    assistantResponse: uiMessageText(row.assistantResponse),
    userMessage: uiMessageText(row.userMessage),
  };
}

/**
 * Advisor notes that grade a turn nothing else graded, newest first.
 *
 * Two joins and one exclusion carry the whole rule:
 *
 *   - The `messages` join is where the conversation comes from. The row stores
 *     the note and a turn id, never a copy of the text, so there is exactly one
 *     place the words the agent read live. It also silently excludes a note with
 *     no turn id, which is correct: a note about a turn with no durable id has
 *     no conversation to be scored against.
 *   - `NOT EXISTS` over `turn_outcomes` is what keeps this ADDITIONAL. Where the
 *     ledger spoke about a turn — for or against — the ledger is the verdict and
 *     a reviewer's second opinion is not counted beside it. Without this a turn
 *     the user corrected could be drawn twice, land in `train` as a ledger row
 *     and in `val` as an advisor row, and quietly break the one property the
 *     split exists to hold.
 *
 * The payload goes through the schema its own writer types against
 * (`AdvisorRowDataSchema`), so a row that fails to parse is corruption and
 * throws, exactly as `toLessonRow` treats a malformed `turn_ids`. A row whose
 * payload carries no turn id cannot reach the parse at all — the join drops it
 * first.
 */
function advisorNegatives(sql: SqlExecutor, actor: ActorHandle, limit: number): AdvisorNegativeRow[] {
  if (limit <= 0) return [];
  actor.assertCurrent();
  // The conversation comes from the canonical store: the pane's serialized UI
  // rows where the backend keeps one, plain `messages` otherwise — the same
  // authority every other conversational reader answers from.
  //
  // BOTH arms carry the actor predicate. The host owns the pane table's
  // definition (identity/fork.ts `ensurePaneTable`) and keys it
  // `(actor_id, id)` for the same reason `messages` is keyed that way — a pane
  // message id is minted per actor and the ancestry walk climbs `parent_id` to
  // `id`.
  const rows = hasPaneStore(sql)
    ? sql<RawAdvisorRow>`
        SELECT e.id AS id, e.message AS note, e.data AS data, e.created_at AS createdAt,
               turn.id AS turnId, turn.content AS assistantResponse, ask.content AS userMessage
        FROM evolution_events e
        JOIN assistant_messages turn ON turn.actor_id = ${actor.actorId}
          AND turn.id = json_extract(e.data, '$.turnId')
        JOIN assistant_messages ask ON ask.actor_id = turn.actor_id AND ask.id = turn.parent_id
        WHERE e.actor_id = ${actor.actorId} AND e.type = ${ADVISOR_EVENT_TYPE}
          AND NOT EXISTS (
            SELECT 1 FROM turn_outcomes o
            WHERE o.actor_id = ${actor.actorId} AND o.turn_id = turn.id)
        ORDER BY e.created_at DESC, e.id DESC LIMIT ${limit}`.map(flattenAdvisorTexts)
    : sql<RawAdvisorRow>`
        SELECT e.id AS id, e.message AS note, e.data AS data, e.created_at AS createdAt,
               turn.id AS turnId, turn.content AS assistantResponse, ask.content AS userMessage
        FROM evolution_events e
        JOIN messages turn ON turn.actor_id = ${actor.actorId}
          AND turn.id = json_extract(e.data, '$.turnId')
        JOIN messages ask ON ask.actor_id = turn.actor_id AND ask.id = turn.parent_id
        WHERE e.actor_id = ${actor.actorId} AND e.type = ${ADVISOR_EVENT_TYPE}
          AND NOT EXISTS (
            SELECT 1 FROM turn_outcomes o
            WHERE o.actor_id = ${actor.actorId} AND o.turn_id = turn.id)
        ORDER BY e.created_at DESC, e.id DESC LIMIT ${limit}`;
  return rows.map((row) => {
    const data = v.parse(AdvisorRowDataSchema, parseJsonValue(row.data));
    return {
      id: row.id,
      turnId: row.turnId,
      note: row.note,
      severity: data.severity,
      noteClass: data.class,
      userMessage: row.userMessage,
      assistantResponse: row.assistantResponse,
      createdAt: row.createdAt,
    };
  });
}

/** Share of the drawn failures held OUT of the reflection minibatch and
 *  scored on instead. A third keeps most of the (scarce) failures available
 *  to learn from while still leaving a real held-out set — at the default
 *  budget, 8 to train on and 4 to be judged on. */
const NEGATIVE_HOLDOUT_SHARE = 1 / 3;

/**
 * One eval instance's worth of a graded turn, whoever graded it.
 *
 * Three producers, one shape: a ledger failure, an advisor note about a turn the
 * ledger never graded, and an accepted turn drawn as a regression guard. The
 * partition below then sorts and slices ONE list, which is why a merged pool
 * cannot come to disagree with itself about which turn is newest.
 */
interface EvalDraw {
  readonly rowId: string;
  readonly createdAt: number;
  readonly turnId: string | null;
  readonly input: string;
  readonly response: string;
  readonly outcome: TurnOutcome;
  readonly complaint: string | null;
  readonly critic: 'user' | 'advisor';
  /** Evidence above the outcome line — what this producer knows and the others
   *  do not. */
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

/**
 * `corrected` is the ledger's word for "this turn landed badly", and that is
 * what a note says. It is the verdict, never a claim about who gave it: the
 * ledger already records `execution`-sourced rows as `corrected` with nobody
 * having corrected anything. `critic` carries who, the evidence line says the
 * user never graded this turn, and the scoring prompt reads both.
 */
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

/** Draw a budgeted, DISJOINT train/val split from the graded turns.
 *
 *  Negatives come first (up to half the budget — they are the optimization
 *  targets) and are then partitioned: the newest go to `val` as held-out
 *  failures, the rest to `train`. Holding out the newest is a temporal
 *  holdout — a candidate proves itself on failures more recent than the ones
 *  it was written against. Accepted turns fill the remaining budget as `val`
 *  regression guards. Newest turns win throughout.
 *
 *  Advisor notes BACKFILL the negatives pool: they are drawn only for the slots
 *  the outcome ledger leaves empty, and only about turns the ledger never
 *  graded. So a workspace with real user corrections optimises against those and
 *  a reviewer's opinion never displaces one; a workspace whose turns no user
 *  ever graded, which is every headless run, has something to optimise toward
 *  instead of an empty train set and a refusal.
 *
 *  No instance is ever in both sets: a winner selected on `val` was never
 *  reflected on during training. When the evidence is too thin to hold anything
 *  out, the split says so via `degeneracy` instead of quietly overlapping. */
export function buildOutcomeEvalSplit(sql: SqlExecutor, actor: ActorHandle, budget: number): OutcomeEvalSplit {
  const size = Math.max(2, Math.floor(budget));
  const ledgerNegatives = listTurnOutcomes(sql, actor, { limit: size, outcomes: NEGATIVE_TURN_OUTCOMES });
  const accepted = listTurnOutcomes(sql, actor, { limit: size, outcomes: ['accepted'] });
  // Enough to fill every negative slot the ledger cannot, before the clamps
  // below decide how many of those slots the final draw actually has.
  const advisorRows = advisorNegatives(sql, actor, size - ledgerNegatives.length);

  // Array.sort is stable, so rows of equal age keep the `created_at DESC, id
  // DESC` order their own query already imposed.
  const negatives = [...ledgerNegatives.map(ledgerDraw), ...advisorRows.map(advisorDraw)]
    .sort((a, b) => b.createdAt - a.createdAt);

  const negativeShare = Math.min(negatives.length, Math.ceil(size / 2));
  const acceptedCount = Math.min(accepted.length, size - negativeShare);
  // Negatives backfill what the accepted pool can't cover (and vice versa).
  const negativeCount = Math.min(negatives.length, size - acceptedCount);

  const toInstance = (draw: EvalDraw, i: number, kind: string): OutcomeEvalInstance => ({
    id: `${kind}-${i}-${draw.rowId}`,
    input: draw.input,
    evidence: [
      `Outcome: ${draw.outcome}`,
      ...draw.extraEvidence,
      turnProcessEvidence(sql, actor, draw.turnId),
    ].filter((line): line is string => line !== undefined).join('\n'),
    expected: {
      outcome: draw.outcome,
      recordedResponse: draw.response,
      followup: draw.complaint,
      critic: draw.critic,
    },
  });

  const drawnNegatives = negatives.slice(0, negativeCount);
  // A single failure cannot be both trained on and held out, so it stays in
  // train and the split reports that selection is blind to improvement.
  const holdoutCount = drawnNegatives.length >= 2
    ? Math.max(1, Math.round(drawnNegatives.length * NEGATIVE_HOLDOUT_SHARE))
    : 0;

  const train = drawnNegatives.slice(holdoutCount).map((r, i) => toInstance(r, i, 'neg'));
  const val = [
    ...drawnNegatives.slice(0, holdoutCount).map((r, i) => toInstance(r, i, 'held')),
    ...accepted.slice(0, acceptedCount).map((r, i) => toInstance(ledgerDraw(r), i, 'pos')),
  ];

  const degeneracy: OutcomeSplitDegeneracy | null =
    drawnNegatives.length === 0
      ? (val.length === 0 ? 'no_labeled_turns' : 'no_negatives')
      : holdoutCount === 0 ? 'no_held_out_negatives' : null;

  return { train, val, heldOutNegatives: holdoutCount, degeneracy };
}
