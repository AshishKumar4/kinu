/**
 * The agent's questions to the owner. `ask_owner` has no executor: its call is left unpaired, the turn stops on that
 * step, and the store holds the questions until the owner answers in the attention stack. Every later request reads
 * the call's result from here through the one repair that pairs interrupted calls, so the model sees the call and its
 * answer as one pair and stored history is never edited. A resume turn, opened with no input of its own, continues.
 */

import { markStoreChanged } from '@kinu.run/agent-utils';
import { Effect } from 'effect';
import * as v from 'valibot';
import type { ActorHandle } from '../identity/actor-handle';
import { KinuError } from '../obs/error';
import { argumentDigest } from '../safety/argument-digest';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { WorkMode } from '../types/turn';
import { AskOwnerInputSchema, OwnerQuestionSchema, type OwnerQuestion } from '../types/owner-questions';
import type { JsonValue } from '../utils/json';
import { nanoid } from '../utils/nanoid';

/** The `kinuEvent` of the turn an answer starts: it continues from the answered call, with no input of its own. */
export const OWNER_ANSWER_SIGNAL = 'owner_answer';

/** One question's answer: the options chosen, by label, and what the owner typed for "Other" or as a note. */
const OwnerAnswerSchema = v.strictObject({
  id: v.pipe(v.string(), v.nonEmpty()),
  selected: v.pipe(v.array(v.pipe(v.string(), v.nonEmpty())), v.maxLength(4)),
  other: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(4000))),
  note: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(2000))),
});

export const OwnerAnswersSchema = v.pipe(v.array(OwnerAnswerSchema), v.minLength(1), v.maxLength(4));

export type OwnerAnswer = v.InferOutput<typeof OwnerAnswerSchema>;

/** `in_chat`: the owner wrote in the chat while the questions were open, which answers them there. */
export type QuestionStatus = 'open' | 'answered' | 'dismissed' | 'in_chat';

const StatusSchema = v.picklist(['open', 'answered', 'dismissed', 'in_chat']);

/** One call's questions, as the store keeps them. `id` is the store's, so a provider reusing call ids names no other. */
const AskedQuestionsSchema = v.object({
  id: v.string(),
  actor: v.string(),
  callId: v.string(),
  turnId: v.string(),
  /** The asking turn's mode, which the turn its answer starts runs in. */
  mode: v.picklist(['plan', 'build']),
  questions: v.array(OwnerQuestionSchema),
  status: StatusSchema,
  answers: v.nullable(OwnerAnswersSchema),
  askedAt: v.number(),
  closedAt: v.nullable(v.number()),
});

export type AskedQuestions = v.InferOutput<typeof AskedQuestionsSchema>;

/** An agent's questions, with who asked: `agent` is its name, `actor` its id, null for the workspace's own. */
export const AskingAgentSchema = v.object({ asked: AskedQuestionsSchema, agent: v.string(), actor: v.nullable(v.string()) });

export type AskingAgent = v.InferOutput<typeof AskingAgentSchema>;

/** One `ask_owner` call as the step that made it holds it, its input as JSON. */
export interface AskCall {
  readonly toolCallId: string;
  readonly input: JsonValue;
}

interface Row {
  actor_id: string; id: string; call_id: string; turn_id: string; mode: string; questions_json: string; status: string;
  answers_json: string | null; asked_at: number; closed_at: number | null;
}

function asked(row: Row): AskedQuestions {
  return {
    id: row.id, actor: row.actor_id, callId: row.call_id, turnId: row.turn_id, mode: row.mode === 'plan' ? 'plan' : 'build',
    questions: v.parse(v.array(OwnerQuestionSchema), JSON.parse(row.questions_json)),
    status: v.parse(StatusSchema, row.status),
    answers: row.answers_json === null ? null : v.parse(OwnerAnswersSchema, JSON.parse(row.answers_json)),
    askedAt: row.asked_at, closedAt: row.closed_at,
  };
}

export function initOwnerQuestionsTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS owner_questions (
    actor_id       TEXT NOT NULL,
    id             TEXT NOT NULL,
    call_id        TEXT NOT NULL,
    turn_id        TEXT NOT NULL,
    mode           TEXT NOT NULL,
    digest         TEXT NOT NULL,
    questions_json TEXT NOT NULL,
    status         TEXT NOT NULL,
    answers_json   TEXT,
    asked_at       INTEGER NOT NULL,
    closed_at      INTEGER,
    resumed_at     INTEGER,
    PRIMARY KEY (actor_id, id)
  )`);
  execRaw('CREATE INDEX IF NOT EXISTS idx_owner_questions_call ON owner_questions(actor_id, call_id, digest)');
  execRaw('CREATE INDEX IF NOT EXISTS idx_owner_questions_open ON owner_questions(actor_id, status, asked_at)');
}

/** The call's own digest: a repair finds its row by call id and input, as providers reuse call ids across turns. */
const callDigest = (input: JsonValue): string => argumentDigest({ tool: 'ask_owner', args: input });

/** A question's answer in words, the options by label, then what the owner typed. */
function answerLine(question: OwnerQuestion, answer: OwnerAnswer | undefined): string {
  if (answer === undefined) return `${question.id}: (no answer)`;
  const chosen = question.multi === true ? `[${answer.selected.join(', ')}]` : answer.selected[0] ?? '';
  const typed = answer.other === undefined ? '' : `"${answer.other}"`;
  const said = [chosen, typed].filter((part) => part !== '' && part !== '[]').join(' and ') || '(nothing chosen)';

  return `${question.id}: ${said}${answer.note === undefined ? '' : ` (note: ${answer.note})`}`;
}

/** The call's result once the questions closed, as the model reads it; null while they are open. */
function questionsOutcome(row: AskedQuestions): string | null {
  if (row.status === 'open') return null;

  if (row.status === 'dismissed') {
    return 'The owner dismissed these questions without answering. Use your best judgement and say what you chose, or stop if the work needs their decision.';
  }

  if (row.status === 'in_chat') return 'The owner answered in the chat instead of choosing here: their message follows.';

  return `The owner answered:\n${row.questions.map((question) => answerLine(question, row.answers?.find((answer) => answer.id === question.id))).join('\n')}`;
}

/** Whether `answers` answers each of `questions` with options it offers, one apiece unless it allows several. */
function answersRefusal(questions: readonly OwnerQuestion[], answers: readonly OwnerAnswer[]): string | null {
  for (const question of questions) {
    const answer = answers.find((each) => each.id === question.id);

    if (answer === undefined) return `question ${question.id} has no answer`;
    const labels = new Set(question.options.map((option) => option.label));
    const stray = answer.selected.find((label) => !labels.has(label));

    if (stray !== undefined) return `question ${question.id} has no option "${stray}"`;

    if (question.multi !== true && answer.selected.length + (answer.other === undefined ? 0 : 1) > 1) return `question ${question.id} takes one choice`;

    if (question.multi !== true && answer.selected.length === 0 && answer.other === undefined) return `question ${question.id} needs a choice or a written answer`;
  }

  const unknown = answers.find((answer) => !questions.some((question) => question.id === answer.id));

  return unknown === undefined ? null : `there is no question ${unknown.id}`;
}

/** One actor's questions, in that actor's own storage, so a request's repair reads them synchronously. */
export class OwnerQuestionStore {
  constructor(private readonly sql: SqlExecutor, private readonly actor: ActorHandle, private readonly now: () => number = Date.now) {}

  get actorId(): string {
    return this.actor.actorId;
  }

  /** Keeps each valid call's questions, once: a replayed step's call is the row it already made. */
  ask(calls: readonly AskCall[], turn: { readonly turnId: string; readonly mode: WorkMode }): AskedQuestions[] {
    this.actor.assertCurrent();
    const made: AskedQuestions[] = [];

    for (const call of calls) {
      const input = v.safeParse(AskOwnerInputSchema, call.input);

      if (!input.success) continue;
      const digest = callDigest(call.input);
      const existing = this.byCall(call.toolCallId, digest);

      if (existing !== null) {
        made.push(existing);
        continue;
      }

      const id = `ask-${nanoid(10)}`;
      void this.sql`INSERT INTO owner_questions(actor_id,id,call_id,turn_id,mode,digest,questions_json,status,asked_at)
        VALUES(${this.actorId},${id},${call.toolCallId},${turn.turnId},${turn.mode},${digest},${JSON.stringify(input.output.questions)},'open',${this.now()})`;
      markStoreChanged(this.sql);
      const row = this.get(id);

      if (row !== null) made.push(row);
    }

    return made;
  }

  get(id: string): AskedQuestions | null {
    this.actor.assertCurrent();
    const row = this.sql<Row>`SELECT * FROM owner_questions WHERE actor_id=${this.actorId} AND id=${id}`[0];

    return row === undefined ? null : asked(row);
  }

  private byCall(callId: string, digest: string): AskedQuestions | null {
    const row = this.sql<Row>`SELECT * FROM owner_questions WHERE actor_id=${this.actorId} AND call_id=${callId} AND digest=${digest}
      ORDER BY asked_at DESC LIMIT 1`[0];

    return row === undefined ? null : asked(row);
  }

  /** The repair's lookup: the result of an `ask_owner` call left unpaired, once its questions closed. */
  outcome(call: AskCall): string | null {
    this.actor.assertCurrent();
    const row = this.byCall(call.toolCallId, callDigest(call.input));

    return row === null ? null : questionsOutcome(row);
  }

  /** Questions waiting on the owner (`open`), or answers whose turn has not opened (`answered`). */
  private waiting(status: 'open' | 'answered'): AskedQuestions[] {
    this.actor.assertCurrent();

    return this.sql<Row>`SELECT * FROM owner_questions WHERE actor_id=${this.actorId} AND status=${status} AND resumed_at IS NULL ORDER BY asked_at`.map(asked);
  }

  open(): AskedQuestions[] {
    return this.waiting('open');
  }

  hasOpen(): boolean {
    this.actor.assertCurrent();

    return this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM owner_questions WHERE actor_id=${this.actorId} AND status='open'`[0]?.n !== 0;
  }

  /** The most recent questions, closed ones too, for the transcript's record of each. */
  recent(limit = 50): AskedQuestions[] {
    this.actor.assertCurrent();

    return this.sql<Row>`SELECT * FROM owner_questions WHERE actor_id=${this.actorId} ORDER BY asked_at DESC LIMIT ${limit}`.map(asked);
  }

  /** The owner's answer, read at the RPC with {@link OwnerAnswersSchema}; it owes a resume turn until {@link markResumed}. */
  answer(id: string, answers: readonly OwnerAnswer[]): Effect.Effect<void, KinuError> {
    return Effect.suspend(() => {
      this.actor.assertCurrent();
      const current = this.get(id);

      if (current === null) return Effect.fail(new KinuError('missing', `There are no questions ${id}.`));

      if (current.status !== 'open') return Effect.fail(new KinuError('denied', 'These questions are already closed.'));
      const refusal = answersRefusal(current.questions, answers);

      if (refusal !== null) return Effect.fail(new KinuError('bad_input', refusal));
      void this.sql`UPDATE owner_questions SET status='answered', answers_json=${JSON.stringify(answers)}, closed_at=${this.now()}
        WHERE actor_id=${this.actorId} AND id=${id} AND status='open'`;
      markStoreChanged(this.sql);

      return Effect.void;
    });
  }

  /** Closes the open questions without an answer: `dismissed` by the owner or a Stop, `in_chat` by a message. */
  close(status: 'dismissed' | 'in_chat', id?: string): AskedQuestions[] {
    this.actor.assertCurrent();
    const open = this.open().filter((row) => id === undefined || row.id === id);

    if (open.length === 0) return [];
    const at = this.now();

    for (const row of open) void this.sql`UPDATE owner_questions SET status=${status}, closed_at=${at} WHERE actor_id=${this.actorId} AND id=${row.id} AND status='open'`;
    markStoreChanged(this.sql);

    return open.map((row) => ({ ...row, status, closedAt: at }));
  }

  /** Answered questions whose resume turn never opened: a process died between the answer and the wake. */
  owedResumes(): AskedQuestions[] {
    return this.waiting('answered');
  }

  markResumed(id: string): void {
    this.actor.assertCurrent();
    void this.sql`UPDATE owner_questions SET resumed_at=${this.now()} WHERE actor_id=${this.actorId} AND id=${id} AND resumed_at IS NULL`;
  }
}

/** One line for the transcript's record of an answer, which the model never reads. */
export function answeredSummary(row: AskedQuestions): string {
  return row.questions.map((question) => {
    const answer = row.answers?.find((each) => each.id === question.id);
    const said = [...answer?.selected ?? [], ...(answer?.other === undefined ? [] : [answer.other])].join(', ');

    return `${question.header ?? question.question}: ${said}`;
  }).join(' · ');
}
