/**
 * The judge-only comparison a dream's drafted section or tool text takes (docs/EVOLUTION-REDESIGN.md §4): the decision
 * model reads a recorded turn and the old and new text, and answers whether the new text `fixes` its failure and
 * whether it `harms` a good turn. Nothing runs the agent, so nothing touches the workspace.
 */
import type { DecisionPort, DecisionQuestion } from '../providers/decision-model';
import type { AgentRuntime } from '../types/agent-runtime';
import { isLowRating, listTurnRatings, renderRating } from './ratings';
import { artifactBody, artifactEditRefusal, type ArtifactEvidence } from './artifacts';

const REGRESSION_TURNS = 30;

/** A bad turn the edit must fix, a good one it must not harm (hypotheses until the §8 eval tunes them). */
const FIXES_SHARE = 0.6;

const MAX_HARMED = 1;

interface JudgedTurn {
  readonly id: string;
  readonly side: 'bad' | 'regression';
  /** The recorded turn as the decision model reads it. */
  readonly state: string;
}

/** The regression set: recent turns rated 4 or 5 that used the artifact, thumbs first. */
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
 * A bad turn scores `fixes`, a regression turn 1 - `harms`. A turn the decision model did not judge (an owner-fixable
 * refusal it already said, or no decision model trusted for these questions) is null, and scores 0 on either side, so
 * no edit passes on it.
 */
async function judgeTurn(decide: DecisionPort, input: { readonly artifactId: string; readonly before: string; readonly after: string; readonly turn: JudgedTurn }): Promise<number | null> {
  const result = await decide({
    state: `ARTIFACT ${input.artifactId}\n\nOLD TEXT:\n${input.before}\n\nNEW TEXT:\n${input.after}\n\nTURN:\n${input.turn.state}`,
    questions: JUDGE_QUESTIONS,
  });

  const fixes = result?.answers.fixes;
  const harms = result?.answers.harms;

  if (fixes?.type !== 'noul' || harms?.type !== 'noul') return null;

  return Math.min(1, Math.max(0, input.turn.side === 'bad' ? fixes.noul : 1 - harms.noul));
}

/** The pass rule of §4 over the scores. */
function judgeOnlyVerdict(scores: ReadonlyMap<string, number>, set: readonly JudgedTurn[]): ArtifactEvidence & { readonly passes: boolean } {
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

/**
 * A dream's drafted edit takes the static checks, then the judge-only comparison over the low-rated turns it answers
 * and the regression set, whose bar it must clear. Nothing is written: the dream's reviewer reads the numbers of an edit
 * that passed, and only an edit it accepts is staged (`stageArtifact`).
 */
export async function scoreAuthoredEdit(deps: { readonly rt: AgentRuntime; readonly decide: DecisionPort }, input: {
  readonly artifactId: string;
  readonly body: string;
  readonly turns: readonly string[];
}): Promise<{ readonly evidence: ArtifactEvidence; readonly detail: string } | { readonly refused: string }> {
  const { rt } = deps;
  const before = artifactBody(rt.storage.sql, rt.actor, input.artifactId);

  if (before === null) return { refused: `${input.artifactId} is no evolvable artifact` };
  const vetoed = artifactEditRefusal(rt.storage.sql, rt.actor, { artifactId: input.artifactId, before, after: input.body, record: true });

  if (vetoed !== null) return { refused: vetoed };

  const bad = listTurnRatings(rt.storage.sql, rt.actor, { turnIds: input.turns }).filter((rating) => isLowRating(rating.score))
    .map((rating): JudgedTurn => ({ id: rating.turnId, side: 'bad', state: `${renderRating(rating)}\n\nWHAT WENT WRONG: ${rating.wrong ?? 'the user was dissatisfied'}` }));

  const set = [...bad, ...regressionSet(rt, input.artifactId)];
  const scores = new Map<string, number>();
  let judged = 0;

  for (const turn of set) {
    const score = await judgeTurn(deps.decide, { artifactId: input.artifactId, before, after: input.body, turn });

    if (score !== null) judged += 1;
    scores.set(turn.id, score ?? 0);
  }

  // Nothing judged it: a measured zero would misstate why it is refused.
  if (judged === 0) return { refused: 'no decision model is trusted to judge this edit, so it was not measured' };

  const { passes, ...verdict } = judgeOnlyVerdict(scores, set);
  const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

  const detail = `the decision model judged it to fix ${(verdict.fixes ?? 0).toFixed(2)} of ${String(verdict.bad)} low-rated turns and `
    + `harm ${String(verdict.harms)} of ${String(verdict.regression)} well-rated ones, against a bar of fixing ${String(FIXES_SHARE)} and `
    + `harming at most ${String(MAX_HARMED)}; ${String(bytes(before))} bytes before and ${String(bytes(input.body))} after`;

  return passes ? { evidence: { ...verdict, reason: 'dream' }, detail } : { refused: `the judge-only comparison refused it: ${detail}` };
}
