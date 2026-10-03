/**
 * The one proposer (docs/EVOLUTION-REDESIGN.md §3-4). It runs on the cadence lane when no trial is running and a
 * trigger holds: three low-rated turns sharing a `wrong` reason, or three struggles with one tool over two turns, in
 * the last 14 days. It edits one artifact with GEPA as its search, scored by the judge-only comparison: the decision
 * model reads a recorded turn and the old and new text, and answers whether the new text `fixes` its failure and
 * whether it `harms` a good turn. Nothing runs the agent, so nothing touches the workspace. A passing edit waits as a
 * candidate; a search is recorded and never repeated for the same turns.
 */
import { Effect, Result } from 'effect';
import * as v from 'valibot';
import type { DecisionPort, DecisionQuestion } from '../providers/decision-model';
import type { AgentRuntime } from '../types/agent-runtime';
import type { LLM } from '../types/primitives';
import { attempt, settle } from '../obs/index';
import { parseJsonValue } from '../utils/json';
import { PROMPT_SECTIONS } from '../prompting/section-templates';
import { BUILTIN_TOOL_NAMES } from '../tools/registry';
import { modifyScaffold } from '../scaffold/modify';
import { checkMisevolution } from '../safety/misevolution';
import { scaffoldRefusal } from '../scaffold/safety-patterns';
import { isLowRating, listTurnRatings, type TurnRating, type WrongReason } from './ratings';
import { StruggleSchema, type Struggle } from './struggles';
import { runGepa } from './gepa/engine';
import { finishGepaRun, makePersistingHooks, startGepaRun } from './gepa/persistence';
import { SCAFFOLD_HOST_TYPES } from '../scaffold/executor';
import type { EvalInstance, GepaResult } from './gepa/types';
import {
  ArtifactEvidenceSchema, artifactBody, artifactEditRefusal, sectionArtifact, toolArtifact, writeCandidate, type ArtifactEvidence,
} from './artifacts';

const DAY_MS = 86_400_000;

const WINDOW_MS = 14 * DAY_MS;

const MIN_REASON_TURNS = 3;

const MIN_STRUGGLES = 3;

const MIN_STRUGGLE_TURNS = 2;

const MAX_OTHER_BAD = 10;

const REGRESSION_TURNS = 30;

/** A bad turn the edit must fix, a good one it must not harm (hypotheses until the §8 eval tunes them). */
const FIXES_SHARE = 0.6;

const MAX_HARMED = 1;

const MAX_SCAFFOLD_LINES = 40;

/** The scaffold is the one artifact not in `artifact_versions`. */
export const SCAFFOLD_ARTIFACT = 'scaffold';

export type ProposerTrigger =
  | { readonly kind: 'reason'; readonly reason: WrongReason; readonly turns: readonly string[] }
  | { readonly kind: 'tool'; readonly tool: string; readonly schema: boolean; readonly turns: readonly string[] };

const StrugglesSchema = v.array(StruggleSchema);

interface StruggleRow { turn_id: string; struggles: string; created_at: number }

function struggleRows(rt: AgentRuntime, since: number): { readonly turnId: string; readonly struggles: Struggle[] }[] {
  return rt.storage.sql<StruggleRow>`SELECT turn_id, struggles, created_at FROM turn_struggles
    WHERE actor_id = ${rt.actor.actorId} AND created_at >= ${since} ORDER BY created_at DESC`
    .map((row) => ({ turnId: row.turn_id, struggles: v.parse(StrugglesSchema, parseJsonValue(row.struggles)) }));
}

const triggerKey = (trigger: ProposerTrigger): string =>
  `${trigger.kind === 'reason' ? `reason:${trigger.reason}` : `tool:${trigger.tool}`}:${[...trigger.turns].sort().join(',')}`;

function searched(rt: AgentRuntime, key: string): boolean {
  return rt.storage.sql<{ n: number }>`SELECT count(*) AS n FROM gepa_runs
    WHERE actor_id = ${rt.actor.actorId} AND target_ref = ${key}`[0]?.n !== 0;
}

/** The trigger that holds now, the larger first, skipping any whose turns were already searched. */
export function proposerTrigger(rt: AgentRuntime, now: number): ProposerTrigger | null {
  const since = now - WINDOW_MS;
  const byReason = new Map<WrongReason, string[]>();

  for (const rating of listTurnRatings(rt.storage.sql, rt.actor, { since, low: true })) {
    if (rating.wrong === null || rating.wrong === 'nothing') continue;
    byReason.set(rating.wrong, [...(byReason.get(rating.wrong) ?? []), rating.turnId]);
  }

  const byTool = new Map<string, { turns: Set<string>; count: number; schema: boolean }>();

  for (const row of struggleRows(rt, since)) {
    for (const struggle of row.struggles) {
      if (struggle.tool === null || !BUILTIN_TOOL_NAMES.has(struggle.tool)) continue;
      const seen = byTool.get(struggle.tool) ?? { turns: new Set<string>(), count: 0, schema: false };

      seen.turns.add(row.turnId);
      seen.count++;
      seen.schema ||= struggle.kind === 'schema_refusal';
      byTool.set(struggle.tool, seen);
    }
  }

  const triggers: ProposerTrigger[] = [
    ...[...byReason].filter(([, turns]) => turns.length >= MIN_REASON_TURNS)
      .map(([reason, turns]): ProposerTrigger => ({ kind: 'reason', reason, turns })),
    ...[...byTool].filter(([, seen]) => seen.count >= MIN_STRUGGLES && seen.turns.size >= MIN_STRUGGLE_TURNS)
      .map(([tool, seen]): ProposerTrigger => ({ kind: 'tool', tool, schema: seen.schema, turns: [...seen.turns] })),
  ].sort((a, b) => b.turns.length - a.turns.length);

  return triggers.find((trigger) => !searched(rt, triggerKey(trigger))) ?? null;
}

interface JudgedTurn {
  readonly id: string;
  readonly side: 'bad' | 'regression';
  /** The recorded turn as the decision model reads it. */
  readonly state: string;
}

const renderRating = (rating: TurnRating): string => [
  `USER REQUEST:\n${rating.request}`,
  `AGENT ACTIONS:\n${rating.actions || '(none)'}`,
  `AGENT FINAL ANSWER:\n${rating.answer}`,
  ...(rating.followup === null ? [] : [`USER'S NEXT MESSAGE:\n${rating.followup}`]),
].join('\n\n');

const renderStruggles = (struggles: readonly Struggle[]): string => struggles
  .map((struggle) => `${struggle.kind} on ${struggle.tool ?? '(no tool)'} x${String(struggle.count)}: ${struggle.sample}`)
  .join('\n');

/** The bad set: the motivating turns, plus up to ten other recent turns with the same reason or tool struggles. */
function badSet(rt: AgentRuntime, trigger: ProposerTrigger, now: number): JudgedTurn[] {
  const since = now - WINDOW_MS;

  if (trigger.kind === 'reason') {
    const low = listTurnRatings(rt.storage.sql, rt.actor, { since, low: true }).filter((rating) => rating.wrong === trigger.reason);
    const motivating = new Set(trigger.turns);
    const chosen = [...low.filter((r) => motivating.has(r.turnId)), ...low.filter((r) => !motivating.has(r.turnId)).slice(0, MAX_OTHER_BAD)];

    return chosen.map((rating) => ({ id: rating.turnId, side: 'bad', state: `${renderRating(rating)}\n\nWHAT WENT WRONG: ${trigger.reason}` }));
  }

  const rows = struggleRows(rt, since).filter((row) => row.struggles.some((struggle) => struggle.tool === trigger.tool));
  const rated = new Map(listTurnRatings(rt.storage.sql, rt.actor, { turnIds: rows.map((row) => row.turnId) }).map((r) => [r.turnId, r]));

  return rows.slice(0, trigger.turns.length + MAX_OTHER_BAD).map((row) => {
    const rating = rated.get(row.turnId);

    return {
      id: row.turnId,
      side: 'bad',
      state: `${rating === undefined ? '' : `${renderRating(rating)}\n\n`}WHERE THE AGENT FOUGHT THE TOOL:\n${renderStruggles(row.struggles)}`,
    };
  });
}

/** The regression set, frozen when the search starts: recent turns rated 4 or 5 that used the artifact, thumbs first. */
function regressionSet(rt: AgentRuntime, artifactId: string): JudgedTurn[] {
  const tool = /^tool:([a-z_]+)\./.exec(artifactId)?.[1];

  return listTurnRatings(rt.storage.sql, rt.actor, { high: true, limit: REGRESSION_TURNS * 4 })
    .filter((rating) => tool === undefined || rating.actions.includes(tool))
    .sort((a, b) => Number(b.source === 'thumbs') - Number(a.source === 'thumbs'))
    .slice(0, REGRESSION_TURNS)
    .map((rating) => ({ id: rating.turnId, side: 'regression', state: `${renderRating(rating)}\n\nThe user was satisfied with this turn.` }));
}

const JUDGE_QUESTIONS = {
  fixes: { type: 'noul', instructions: 'Had the agent run with the NEW text instead of the OLD, would this turn\'s failure have been prevented?' },
  harms: { type: 'noul', instructions: 'Had the agent run with the NEW text instead of the OLD, would this turn have gone worse?' },
} as const satisfies Record<string, DecisionQuestion>;

/**
 * GEPA's metric: a bad turn scores `fixes`, a regression turn 1 - `harms`. A turn the decision model did not judge (an
 * owner-fixable refusal it already said) scores 0 on either side, so no edit passes on it.
 */
function judgeMetric(decide: DecisionPort, artifactId: string, before: string) {
  return async (candidate: string, instance: EvalInstance<JudgedTurn>) => {
    const result = await decide({
      state: `ARTIFACT ${artifactId}\n\nOLD TEXT:\n${before}\n\nNEW TEXT:\n${candidate}\n\nTURN:\n${instance.input.state}`,
      questions: JUDGE_QUESTIONS,
    });

    const fixes = result?.answers.fixes;
    const harms = result?.answers.harms;

    if (fixes?.type !== 'noul' || harms?.type !== 'noul') return { score: 0, feedback: `turn ${instance.id}: the decision model did not judge it` };

    const score = instance.input.side === 'bad' ? fixes.noul : 1 - harms.noul;

    return {
      score: Math.min(1, Math.max(0, score)),
      feedback: instance.input.side === 'bad'
        ? `bad turn ${instance.id}: the new text would have prevented its failure with p=${fixes.noul.toFixed(2)}`
        : `good turn ${instance.id}: the new text would have made it worse with p=${harms.noul.toFixed(2)}`,
    };
  };
}

/** The pass rule of §4 over the winner's scores. */
export function judgeOnlyVerdict(scores: ReadonlyMap<string, number>, set: readonly JudgedTurn[]): ArtifactEvidence & { readonly passes: boolean } {
  const bad = set.filter((turn) => turn.side === 'bad');
  const regression = set.filter((turn) => turn.side === 'regression');
  const fixed = bad.filter((turn) => (scores.get(turn.id) ?? 0) > 0.5).length;
  const harmed = regression.filter((turn) => (scores.get(turn.id) ?? 1) < 0.5).length;
  const fixes = bad.length === 0 ? 0 : fixed / bad.length;

  return {
    turns: bad.map((turn) => turn.id), reason: '', fixes, harms: harmed, bad: bad.length, regression: regression.length,
    passes: bad.length > 0 && fixes >= FIXES_SHARE && harmed <= MAX_HARMED,
  };
}

const changedLines = (before: string, after: string): number => {
  const was = new Set(before.split('\n'));
  const now = after.split('\n');

  return Math.max(now.filter((line) => !was.has(line)).length, before.split('\n').length - now.length);
};

function scaffoldEditRefusal(before: string, after: string): string | null {
  if (after === before) return 'the edit changes nothing';
  const lines = changedLines(before, after);

  if (lines > MAX_SCAFFOLD_LINES) return `the edit changes ${String(lines)} lines of scaffold; at most ${String(MAX_SCAFFOLD_LINES)}`;
  const unsafe = scaffoldRefusal(after);

  if (unsafe !== null) return unsafe;
  const misevolution = checkMisevolution(after);

  return Result.isSuccess(misevolution) ? null : `misevolution veto (${misevolution.failure.criterionId}): ${misevolution.failure.reason}`;
}

const SECTION_CHOICE = {
  section: {
    type: 'choice',
    instructions: 'Which part of the agent\'s system prompt, reworded, would most likely have prevented these failures?',
    criteria: Object.fromEntries(PROMPT_SECTIONS.map((section) => [section.id, section.source.split('\n').find((line) => line.trim() !== '') ?? section.id])),
  },
} as const satisfies Record<string, DecisionQuestion>;

/** A struggle cluster targets its tool's text; a shared reason, the prompt section the decision model names. */
async function targetOf(decide: DecisionPort, trigger: ProposerTrigger, bad: readonly JudgedTurn[]): Promise<string | null> {
  if (trigger.kind === 'tool') return toolArtifact(trigger.tool, trigger.schema ? 'schema' : 'description');
  const result = await decide({ state: bad.map((turn) => turn.state).join('\n\n---\n\n'), questions: SECTION_CHOICE });
  const choice = result?.answers.section;

  return choice?.type === 'choice' ? sectionArtifact(choice.choice) : null;
}

export interface ProposerDeps {
  readonly rt: AgentRuntime;
  readonly decide: DecisionPort;
  /** The deep tier: it reads the turns and writes the mutation. */
  readonly reflect: LLM;
  readonly now: number;
}

export type ProposerOutcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'searched'; readonly artifactId: string; readonly version: number | null; readonly detail: string };

/**
 * One search. `target` is the manual start (the optimisation RPCs): it names the artifact and takes the recent
 * low-rated turns as its bad set; otherwise the trigger picks both.
 */
export async function runProposer(deps: ProposerDeps, target?: string): Promise<ProposerOutcome> {
  const { rt, now } = deps;
  const lowTurns = listTurnRatings(rt.storage.sql, rt.actor, { since: now - WINDOW_MS, low: true }).map((rating) => rating.turnId);

  const trigger: ProposerTrigger | null = target === undefined
    ? proposerTrigger(rt, now)
    : { kind: 'reason', reason: 'incorrect', turns: lowTurns };

  if (trigger === null || (target !== undefined && lowTurns.length === 0)) return { kind: 'idle' };

  const bad = target === undefined
    ? badSet(rt, trigger, now)
    : listTurnRatings(rt.storage.sql, rt.actor, { since: now - WINDOW_MS, low: true }).slice(0, MAX_OTHER_BAD + MIN_REASON_TURNS)
      .map((rating): JudgedTurn => ({ id: rating.turnId, side: 'bad', state: `${renderRating(rating)}\n\nWHAT WENT WRONG: ${rating.wrong ?? 'the user was dissatisfied'}` }));

  const artifactId = target ?? await targetOf(deps.decide, trigger, bad);
  const key = target === undefined ? triggerKey(trigger) : `manual:${String(now)}`;

  if (artifactId === null) return { kind: 'idle' };
  const scaffold = artifactId === SCAFFOLD_ARTIFACT;
  const before = scaffold ? await rt.identity.scaffold.read() : artifactBody(rt.storage.sql, rt.actor, artifactId);

  if (before === null) return { kind: 'idle' };
  const set = [...bad, ...regressionSet(rt, artifactId)];
  const runId = startGepaRun(rt.storage.sql, rt.actor, { target: artifactId, targetRef: key });

  const refusal = (after: string): string | null => (scaffold
    ? scaffoldEditRefusal(before, after)
    : artifactEditRefusal(rt.storage.sql, rt.actor, { artifactId, before, after, record: false }));

  const finish = (result: GepaResult): Promise<ProposerOutcome> => {
    const verdict = judgeOnlyVerdict(result.winner.scores, set);
    const evidence = { ...verdict, reason: trigger.kind === 'reason' ? trigger.reason : `struggles with ${trigger.tool}` };

    finishGepaRun(rt.storage.sql, rt.actor, {
      runId, status: 'completed', stopReason: result.stopReason, winnerId: result.winner.id,
      metricCalls: result.metricCallsUsed, iterations: result.iterationsRun,
    });

    return writeEdit({ rt, artifactId, before, after: result.winner.source, evidence, now, judged: set.length });
  };

  return settle(attempt({ doing: 'searching for an edit', otherwise: 'unavailable' }, () => runGepa<JudgedTurn, never>({
    seed: before,
    evalSet: set.map((turn) => ({ id: turn.id, input: turn })),
    trainSet: bad.map((turn) => ({ id: turn.id, input: turn })),
    metric: judgeMetric(deps.decide, artifactId, before),
    reflectionLm: (prompt) => deps.reflect.complete(prompt),
    artifactDescription: scaffold ? `scaffold source, run against this host contract:\n${SCAFFOLD_HOST_TYPES}` : `agent text (${artifactId})`,
    ...makePersistingHooks({ sql: rt.storage.sql, actor: rt.actor, runId }),
    budget: { maxIterations: 4, maxMetricCalls: Math.min(400, set.length * 6), minibatchSize: 3, useMerge: false },
    constraints: { customCheck: (source) => (source === before ? null : refusal(source)) },
  })).pipe(
    Effect.tapError(() => Effect.sync(() => finishGepaRun(rt.storage.sql, rt.actor, {
      runId, status: 'aborted', stopReason: 'aborted', winnerId: null, metricCalls: 0, iterations: 0,
    }))),
    Effect.flatMap((result) => attempt({ doing: 'writing the searched edit', otherwise: 'io' }, () => finish(result))),
  ));
}

/** The pre-live verdict's consequence: a passing edit waits as a candidate, or as the owner's pending scaffold. */
async function writeEdit(input: {
  readonly rt: AgentRuntime;
  readonly artifactId: string;
  readonly before: string;
  readonly after: string;
  readonly evidence: ArtifactEvidence & { readonly passes: boolean };
  readonly now: number;
  readonly judged: number;
}): Promise<ProposerOutcome> {
  const { rt, artifactId, before, after, evidence, now } = input;
  const detail = `fixes ${(evidence.fixes ?? 0).toFixed(2)} of ${String(evidence.bad)} bad turns, harms ${String(evidence.harms)} of ${String(evidence.regression)}`;

  if (after === before || !evidence.passes) return { kind: 'searched', artifactId, version: null, detail: `no edit passed: ${detail}` };
  const rationale = `GEPA over ${String(input.judged)} recorded turns (${evidence.reason}): ${detail}`;

  if (artifactId === SCAFFOLD_ARTIFACT) {
    const written = await modifyScaffold(rt, rationale, after);

    return { kind: 'searched', artifactId, version: written.ok ? written.version ?? null : null, detail: written.ok ? detail : written.error ?? 'the scaffold gates refused it' };
  }

  const vetoed = artifactEditRefusal(rt.storage.sql, rt.actor, { artifactId, before, after, record: true });

  if (vetoed !== null) return { kind: 'searched', artifactId, version: null, detail: vetoed };
  // The record keeps the numbers, not the verdict they made.
  const stored = v.parse(ArtifactEvidenceSchema, evidence);

  return { kind: 'searched', artifactId, version: writeCandidate(rt.storage.sql, rt.actor, { artifactId, body: after, rationale, evidence: stored, now }), detail };
}

/**
 * An edit authored elsewhere (the continual-refinement lane) takes the same pre-live tests: the static checks, then
 * the judge-only comparison over the low-rated turns it answers and the regression set. It waits like the proposer's.
 */
export async function judgeAuthoredEdit(deps: Omit<ProposerDeps, 'reflect' | 'now'>, input: {
  readonly artifactId: string;
  readonly body: string;
  readonly rationale: string;
  readonly turns: readonly string[];
}): Promise<{ readonly version: number } | { readonly refused: string }> {
  const { rt } = deps;
  const before = artifactBody(rt.storage.sql, rt.actor, input.artifactId);

  if (before === null) return { refused: `${input.artifactId} is no evolvable artifact` };
  const vetoed = artifactEditRefusal(rt.storage.sql, rt.actor, { artifactId: input.artifactId, before, after: input.body, record: true });

  if (vetoed !== null) return { refused: vetoed };

  const bad = listTurnRatings(rt.storage.sql, rt.actor, { turnIds: input.turns }).filter((rating) => isLowRating(rating.score))
    .map((rating): JudgedTurn => ({ id: rating.turnId, side: 'bad', state: `${renderRating(rating)}\n\nWHAT WENT WRONG: ${rating.wrong ?? 'the user was dissatisfied'}` }));

  const set = [...bad, ...regressionSet(rt, input.artifactId)];
  const metric = judgeMetric(deps.decide, input.artifactId, before);
  const scores = new Map<string, number>();

  for (const turn of set) scores.set(turn.id, (await metric(input.body, { id: turn.id, input: turn })).score);
  const verdict = judgeOnlyVerdict(scores, set);
  const detail = `fixes ${(verdict.fixes ?? 0).toFixed(2)} of ${String(verdict.bad)} bad turns, harms ${String(verdict.harms)} of ${String(verdict.regression)}`;

  if (!verdict.passes) return { refused: `the judge-only comparison refused it: ${detail}` };

  return {
    version: writeCandidate(rt.storage.sql, rt.actor, {
      artifactId: input.artifactId, body: input.body, rationale: input.rationale, evidence: { ...verdict, reason: 'continual refinement' },
    }),
  };
}
