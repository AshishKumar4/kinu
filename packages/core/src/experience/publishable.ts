/**
 * What a workspace has EARNED the right to share.
 *
 * Publishing is not "copy my state somewhere else" — an unproven artifact
 * crossing into the owner's other workspaces is pollution, and Agent-KB's own
 * caveat (EvoAgentBench finds no automatic method sustains positive gain) is a
 * reason to move only what already carries local evidence. So each kind has one
 * bar, stated here and nowhere else, and every candidate carries the evidence
 * that cleared it:
 *
 *   craft  — a crafted tool with real usage and a time-decayed effective score
 *            at or above the injection threshold. Same number the injection
 *            filter uses, so "good enough to keep offering the model here" and
 *            "good enough to offer another workspace" are one judgement.
 *   lesson — a CORROBORATED lesson. Provisional lessons are self-scored prose
 *            with no user signal behind them; they are already kept out of this
 *            workspace's own MEMORY.md, and they stay out of the library.
 *   fact   — confidence at or above the publish bar. A fact carries no outcome
 *            grading (nothing marks a keyed value right or wrong), so its own
 *            confidence is the only honest local signal. The real protection
 *            for the receiver is on the import side: the misevolution gate and
 *            provisional-until-corroborated.
 */

import type { SqlExecutor } from '../types/primitives.js';
import type { CraftStore } from '../types/agent-runtime.js';
import type { FactsStore } from '../memory/facts.js';
import { effectiveScore } from '../craft/ema.js';
import { DEFAULT_CONFIG } from '../config.js';
import { isoDate, nowMs } from '../utils/date.js';
import { getLesson, listLessons } from '../evolution/outcomes.js';
import type { ExperienceKind, PublishableCandidate } from './types.js';

/** A fact below this confidence has not settled enough to be worth another
 *  agent's context. */
export const EXPERIENCE_MIN_FACT_CONFIDENCE = 0.8;

/** The stores a workspace publishes from. */
export interface PublishSources {
  sql: SqlExecutor;
  craftStore: CraftStore;
  facts: FactsStore;
}

/** Why a named artifact may not be published. Phrased for the agent reading a
 *  tool error, since that is the only place it surfaces. */
export type PublishRefusal = { refused: string };

function titleOf(text: string, maxChars = 90): string {
  const line = text.trim().split('\n', 1)[0] ?? '';
  return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line || 'untitled';
}

interface CraftScoreRow { tool_name: string; score: number; uses: number; last_used_at: number }

function craftScores(sql: SqlExecutor): Map<string, CraftScoreRow> {
  try {
    return new Map(
      sql<CraftScoreRow>`SELECT tool_name, score, uses, last_used_at FROM craft_scores`
        .map((r) => [r.tool_name, r]),
    );
  } catch {
    return new Map();
  }
}

function craftCandidate(
  src: PublishSources,
  name: string,
  scores: Map<string, CraftScoreRow>,
  now: number,
): PublishableCandidate | PublishRefusal {
  const tool = src.craftStore.get(name);
  if (!tool) return { refused: `no crafted tool named "${name}" in this workspace` };
  const score = scores.get(name);
  if (!score || score.uses < 1) {
    return { refused: `crafted tool "${name}" has never been used here, so nothing has proven it yet` };
  }
  const effective = effectiveScore(score.score, score.last_used_at, now);
  const bar = DEFAULT_CONFIG.craftStore.minEffectiveScoreForInjection;
  if (effective < bar) {
    return {
      refused: `crafted tool "${name}" scores ${effective.toFixed(2)} here, below the ${bar} bar `
        + 'this workspace itself uses to keep offering a tool',
    };
  }
  return {
    kind: 'craft',
    key: name,
    title: titleOf(tool.description || name),
    payload: {
      kind: 'craft',
      name: tool.name,
      description: tool.description,
      params: tool.params,
      code: tool.code,
      score: effective,
    },
    evidence: `effective score ${effective.toFixed(2)} after ${score.uses} real use${score.uses === 1 ? '' : 's'}`,
  };
}

function lessonCandidate(src: PublishSources, id: string): PublishableCandidate | PublishRefusal {
  const lesson = getLesson(src.sql, id);
  if (!lesson) return { refused: `no lesson with id "${id}" in this workspace` };
  if (lesson.status !== 'corroborated') {
    return {
      refused: `lesson "${id}" is still provisional — it is kept out of this workspace's own `
        + 'MEMORY.md until a real outcome corroborates it, so it is not shareable either',
    };
  }
  return {
    kind: 'lesson',
    key: lesson.id,
    title: titleOf(lesson.text),
    payload: { kind: 'lesson', text: lesson.text },
    evidence: `${lesson.source.replace('_', ' ')} corroborated ${isoDate(lesson.corroboratedAt ?? lesson.createdAt)}`,
  };
}

function factCandidate(src: PublishSources, key: string): PublishableCandidate | PublishRefusal {
  const fact = src.facts.recall(key);
  if (!fact) return { refused: `no fact named "${key}" in this workspace` };
  if (fact.confidence < EXPERIENCE_MIN_FACT_CONFIDENCE) {
    return {
      refused: `fact "${key}" is held at confidence ${fact.confidence.toFixed(2)}, `
        + `below the ${EXPERIENCE_MIN_FACT_CONFIDENCE} publish bar`,
    };
  }
  return {
    kind: 'fact',
    key: fact.key,
    title: titleOf(fact.key),
    payload: { kind: 'fact', key: fact.key, value: fact.value, confidence: fact.confidence },
    evidence: `held at confidence ${fact.confidence.toFixed(2)}, last observed ${isoDate(fact.lastObservedAt)}`,
  };
}

function isRefusal(value: PublishableCandidate | PublishRefusal): value is PublishRefusal {
  return 'refused' in value;
}

/** Resolve one named artifact into a publishable candidate, or say why not. */
export function findPublishable(
  src: PublishSources,
  kind: ExperienceKind,
  key: string,
  now = nowMs(),
): PublishableCandidate | PublishRefusal {
  switch (kind) {
    case 'craft': return craftCandidate(src, key, craftScores(src.sql), now);
    case 'lesson': return lessonCandidate(src, key);
    case 'fact': return factCandidate(src, key);
  }
}

/** Everything this workspace could share right now, newest evidence first
 *  within each kind. The agent's "what do I have to offer" view. */
export function listPublishable(
  src: PublishSources,
  options: { limit?: number; now?: number } = {},
): PublishableCandidate[] {
  const limit = Math.max(1, options.limit ?? 20);
  const now = options.now ?? nowMs();
  const scores = craftScores(src.sql);

  const crafts = src.craftStore.list()
    .map((tool) => craftCandidate(src, tool.name, scores, now))
    .filter((c): c is PublishableCandidate => !isRefusal(c));

  const lessons = listLessons(src.sql, { status: 'corroborated', limit })
    .map((lesson) => lessonCandidate(src, lesson.id))
    .filter((c): c is PublishableCandidate => !isRefusal(c));

  let facts: PublishableCandidate[] = [];
  try {
    facts = src.facts.recentTopK(limit)
      .filter((f) => f.confidence >= EXPERIENCE_MIN_FACT_CONFIDENCE)
      .map((f) => factCandidate(src, f.key))
      .filter((c): c is PublishableCandidate => !isRefusal(c));
  } catch { /* agent_facts not initialized in this runtime */ }

  return [...crafts, ...lessons, ...facts].slice(0, limit);
}
