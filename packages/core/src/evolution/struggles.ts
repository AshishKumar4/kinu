/**
 * Struggles: where a turn fought its tools (docs/EVOLUTION-REDESIGN.md §2). The turn's steering detector owns what
 * counts as one; a struggle never decides satisfaction. A turn that struggled records its struggles, tool errors and
 * steps (`turn_struggles`) and teaches one lesson about the tool it fought (`tool_lessons`), an
 * itemized bullet as in ACE's evolving playbooks (Zhang et al., arXiv:2510.04618): edited in place as a new revision,
 * scored by the later turns that were shown it and used its tool, retired when it hurts more than it helps.
 */

import * as v from 'valibot';
import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { CompletedTurn } from './types';
import type { TurnSteeringTrigger } from '../events/types';
import type { ShownLesson } from '../types/dynamic-context';
import { sqlCheckList } from '../identity/schema';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../utils/evidence-window';
import { parseJsonValue, type JsonValue } from '../utils/json';
import { nowMs } from '../utils/date';
import { jsonObjectOnlyInstruction } from '../providers/structured';

/** The steering triggers, plus an input its tool's schema refused before the tool ran. */
const STRUGGLE_KINDS = [
  'repeated_failure', 'repeated_call', 'schema_refusal', 'no_progress',
] as const satisfies readonly (TurnSteeringTrigger | 'schema_refusal')[];

export const StruggleSchema = v.object({
  kind: v.picklist(STRUGGLE_KINDS),
  /** Null for `no_progress`, which no one tool owns. */
  tool: v.nullable(v.string()),
  count: v.number(),
  /** The failure text, or the repeated call's arguments. */
  sample: v.string(),
});

export type Struggle = v.InferOutput<typeof StruggleSchema>;

/** Uses after which a lesson that hurt more often than it helped retires. */
const LESSON_TRIAL_USES = 5;

/** Lessons shown per step, newest first, and the most a reflector reads about one tool. */
export const MAX_TOOL_LESSONS = 5;

/** The struggled tool's calls a reflector reads, the last ones. */
const REFLECTOR_CALLS = 8;

const LESSON_MAX_CHARS = 300;

export function initStruggleTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS turn_struggles (
    actor_id   TEXT NOT NULL,
    turn_id    TEXT NOT NULL,
    errors     INTEGER NOT NULL,
    steps      INTEGER NOT NULL,
    struggles  TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, turn_id)
  )`);
  execRaw('CREATE INDEX IF NOT EXISTS idx_turn_struggles_actor ON turn_struggles(actor_id, created_at)');
  execRaw(`CREATE TABLE IF NOT EXISTS tool_lessons (
    actor_id   TEXT NOT NULL,
    id         TEXT NOT NULL,
    tool       TEXT NOT NULL,
    text       TEXT NOT NULL,
    revision   INTEGER NOT NULL,
    helpful    INTEGER NOT NULL,
    harmful    INTEGER NOT NULL,
    turn_ids   TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN (${sqlCheckList(['active', 'retired'])})),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, id)
  )`);
  execRaw('CREATE INDEX IF NOT EXISTS idx_tool_lessons_actor ON tool_lessons(actor_id, status, updated_at DESC)');
}

type ReviewedTurn = CompletedTurn & { readonly turnId: string };

/** Whether a turn has anything to learn from: a struggle, or a shown lesson whose tool it used and so scores. A turn
 *  with neither records nothing and owes no effect. */
export function owesTurnLessons(turn: Pick<CompletedTurn, 'struggles' | 'shownLessons' | 'toolCalls'>): boolean {
  return (turn.struggles ?? []).length > 0 || ((turn.shownLessons ?? []).length > 0 && turn.toolCalls.length > 0);
}

/** One row per struggling turn. */
export function recordTurnStruggles(sql: SqlExecutor, actor: ActorHandle, turn: ReviewedTurn, now = nowMs()): void {
  actor.assertCurrent();

  if ((turn.struggles ?? []).length === 0) return;
  const errors = turn.toolCalls.filter((call) => call.outcome?.success === false).length;

  void sql`INSERT INTO turn_struggles (actor_id, turn_id, errors, steps, struggles, created_at)
    VALUES (${actor.actorId}, ${turn.turnId}, ${errors}, ${turn.steps}, ${JSON.stringify(turn.struggles ?? [])}, ${now})
    ON CONFLICT(actor_id, turn_id) DO NOTHING`;
}

/** One lesson at one revision; a rewrite is a new revision with no evidence yet. */
export interface ToolLesson {
  readonly id: string;
  readonly revision: number;
  readonly tool: string;
  readonly text: string;
  readonly helpful: number;
  readonly harmful: number;
  readonly turnIds: readonly string[];
}

type ToolLessonRow = { id: string; revision: number; tool: string; text: string; helpful: number; harmful: number; turn_ids: string };

const lessonOf = (row: ToolLessonRow): ToolLesson => ({
  id: row.id, revision: row.revision, tool: row.tool, text: row.text, helpful: row.helpful, harmful: row.harmful,
  turnIds: v.parse(v.array(v.string()), parseJsonValue(row.turn_ids)),
});

/** The newest `limit` active lessons about `tools`. */
export function listToolLessons(sql: SqlExecutor, actor: ActorHandle, tools: readonly string[], limit: number): ToolLesson[] {
  actor.assertCurrent();

  return sql<ToolLessonRow>`
    SELECT id, revision, tool, text, helpful, harmful, turn_ids FROM tool_lessons
    WHERE actor_id = ${actor.actorId} AND status = 'active' AND tool IN (SELECT value FROM json_each(${JSON.stringify(tools)}))
    ORDER BY updated_at DESC, id DESC LIMIT ${limit}`
    .map(lessonOf);
}

export function shownLesson(lesson: ToolLesson): ShownLesson {
  return { id: lesson.id, revision: lesson.revision, line: `\`${lesson.tool}\`: ${lesson.text}` };
}

/** Each lesson the turn was shown, at the revision it saw: helpful when the turn then used its tool without
 *  struggling with it, harmful when it struggled again. A lesson rewritten since, one the turn never used the tool
 *  of, and the one the turn taught are not scored. */
export function scoreToolLessons(sql: SqlExecutor, actor: ActorHandle, turn: ReviewedTurn): void {
  const used = new Set(turn.toolCalls.map((call) => call.name));
  const struggled = new Set((turn.struggles ?? []).map((struggle) => struggle.tool));
  const now = nowMs();

  for (const shown of turn.shownLessons ?? []) {
    const [row] = sql<ToolLessonRow>`
      SELECT id, revision, tool, text, helpful, harmful, turn_ids FROM tool_lessons
      WHERE actor_id = ${actor.actorId} AND id = ${shown.id} AND revision = ${shown.revision} AND status = 'active'`;

    const lesson = row === undefined ? undefined : lessonOf(row);

    if (lesson === undefined || !used.has(lesson.tool) || lesson.turnIds.includes(turn.turnId)) continue;
    const harmed = struggled.has(lesson.tool);
    const helpful = lesson.helpful + (harmed ? 0 : 1);
    const harmful = lesson.harmful + (harmed ? 1 : 0);
    const status = helpful + harmful >= LESSON_TRIAL_USES && harmful > helpful ? 'retired' : 'active';

    void sql`UPDATE tool_lessons SET helpful = ${helpful}, harmful = ${harmful}, status = ${status}, updated_at = ${now}
      WHERE actor_id = ${actor.actorId} AND id = ${lesson.id} AND revision = ${lesson.revision}`;
  }
}

/** The tool struggle a turn teaches from: the longest, then by kind; a stall alone teaches nothing. */
export function teachingStruggle(struggles: readonly Struggle[]): Struggle & { readonly tool: string } | null {
  const rank = (struggle: Struggle): number => STRUGGLE_KINDS.indexOf(struggle.kind);

  const ranked = struggles
    .flatMap((struggle) => (struggle.tool === null ? [] : [{ ...struggle, tool: struggle.tool }]))
    .sort((a, b) => b.count - a.count || rank(a) - rank(b));

  return ranked[0] ?? null;
}

const STRUGGLE_TEXT = {
  repeated_failure: (count: number) => `failed ${String(count)} times in a row`,
  repeated_call: (count: number) => `ran ${String(count)} times with the same arguments and returned the same output`,
  schema_refusal: (count: number) => `was called ${String(count)} time(s) with input its schema refused`,
  no_progress: (count: number) => `went ${String(count)} steps with nothing new`,
} satisfies Record<Struggle['kind'], (count: number) => string>;

export function struggleLessonPrompt(
  turn: CompletedTurn, struggle: Struggle & { readonly tool: string }, known: readonly ToolLesson[],
): string {
  const window = (value: JsonValue | undefined): string => evidenceWindow(JSON.stringify(value ?? null), EVIDENCE_BUDGETS.patternToolCall);

  const calls = turn.toolCalls
    .filter((call) => call.name === struggle.tool)
    .slice(-REFLECTOR_CALLS)
    .map((call) => `- ${call.name}(${window(call.args)}) -> ${call.outcome?.success === false ? 'failed' : 'ok'}: ${window(call.result)}`);

  const lessons = known.map((lesson) => `- [${lesson.id}] ${lesson.text} (helped ${String(lesson.helpful)}, hurt ${String(lesson.harmful)})`);

  return `\`${struggle.tool}\` ${STRUGGLE_TEXT[struggle.kind](struggle.count)} in one turn.\n`
    + `Sample: ${evidenceWindow(struggle.sample, EVIDENCE_BUDGETS.patternToolCall)}\n`
    + `The user asked: "${evidenceWindow(turn.userMessage, EVIDENCE_BUDGETS.outcomeUserMessage)}"\n`
    + `The calls, in order:\n${calls.join('\n')}\n\n`
    + `What earlier turns learned about \`${struggle.tool}\`:\n${lessons.join('\n') || 'Nothing yet.'}\n\n`
    + `Write one lesson, at most ${String(LESSON_MAX_CHARS)} characters, that would have spared this turn the struggle: `
    + 'when to do what with this tool, for later turns that see none of the evidence above. '
    + 'If a lesson above covers it but was wrong or incomplete, rewrite that one instead of adding another.\n'
    + '{"update":"<id of the lesson you rewrite, or null>","text":"the lesson"}\n'
    + jsonObjectOnlyInstruction();
}

export const StruggleLessonSchema = v.object({
  update: v.nullable(v.string()),
  text: v.pipe(v.string(), v.trim(), v.nonEmpty()),
});

/** Rewrites the named lesson as its next revision, whose evidence starts at none, or adds one keyed by the teaching
 *  turn so a replay writes the same row. */
export function applyStruggleLesson(sql: SqlExecutor, actor: ActorHandle, input: {
  readonly turnId: string;
  readonly tool: string;
  readonly answer: v.InferOutput<typeof StruggleLessonSchema>;
}): string {
  const now = nowMs();
  const text = input.answer.text.slice(0, LESSON_MAX_CHARS);

  const [row] = input.answer.update === null ? [] : sql<ToolLessonRow>`
    SELECT id, revision, tool, text, helpful, harmful, turn_ids FROM tool_lessons
    WHERE actor_id = ${actor.actorId} AND id = ${input.answer.update} AND tool = ${input.tool} AND status = 'active'`;

  const target = row === undefined ? undefined : lessonOf(row);

  // The same words are no rewrite: their evidence stands.
  if (target !== undefined && target.text === text) return target.id;

  if (target !== undefined) {
    const turnIds = target.turnIds.includes(input.turnId) ? target.turnIds : [...target.turnIds, input.turnId];

    void sql`UPDATE tool_lessons SET text = ${text}, revision = ${target.revision + 1}, helpful = 0, harmful = 0,
      turn_ids = ${JSON.stringify(turnIds)}, updated_at = ${now}
      WHERE actor_id = ${actor.actorId} AND id = ${target.id}`;

    return target.id;
  }

  const id = `tl-${input.turnId}`;

  void sql`INSERT INTO tool_lessons (actor_id, id, tool, text, revision, helpful, harmful, turn_ids, status, created_at, updated_at)
    VALUES (${actor.actorId}, ${id}, ${input.tool}, ${text}, 1, 0, 0, ${JSON.stringify([input.turnId])}, 'active', ${now}, ${now})
    ON CONFLICT(actor_id, id) DO NOTHING`;

  return id;
}
