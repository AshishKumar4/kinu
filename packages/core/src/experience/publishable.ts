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
 *   scaffold — the LIVE version, promoted by this workspace's own shadow gate
 *            on a record that still clears `decidePromotion`, which has then
 *            served {@link EXPERIENCE_SCAFFOLD_SURVIVAL_TURNS} graded turns
 *            with no misevolution flag against anything this workspace wrote in
 *            that window. Nothing else in the archive qualifies: a pending
 *            version is mid-trial, a rolled-back one lost, a historical one was
 *            superseded, and the v0 bootstrap was never judged at all.
 */

import * as v from 'valibot';
import type { SqlExecutor } from '../types/primitives';
import type { CraftStore } from '../types/agent-runtime';
import type { FactsStore } from '../memory/facts';
import { effectiveScore } from '../craft/ema';
import { DEFAULT_CONFIG } from '../config';
import { isoDate, nowMs } from '../utils/date';
import { parseJsonValue } from '../utils/json';
import { getLesson, listLessons } from '../evolution/outcomes';
import {
  DEFAULT_SHADOW_CONFIG, decidePromotion, getCurrentScaffoldVersion, readShadowVerdict,
  type ScaffoldStatus,
} from '../scaffold/shadow';
import type { ExperienceKind, PublishableCandidate } from './types';

/** A fact below this confidence has not settled enough to be worth another
 *  agent's context. */
export const EXPERIENCE_MIN_FACT_CONFIDENCE = 0.8;

/** Graded turns a promoted scaffold must serve here before it may cross into
 *  another workspace.
 *
 *  Not a new number: it is `DEFAULT_SHADOW_CONFIG.minTrials`, the count of
 *  turns the promotion gate already demands as evidence before it will decide
 *  anything at all (shadow.ts, Monte-Carlo calibrated). A promoted version has
 *  won that many trials against the incumbent OFFLINE; this asks for the same
 *  quantity of evidence again from turns the user actually lived through, which
 *  is the one signal a shadow judge cannot supply. Sharing a loop that has run
 *  in anger fewer times than its own gate required to accept it would be
 *  exporting the judge's opinion, not experience. */
const EXPERIENCE_SCAFFOLD_SURVIVAL_TURNS = DEFAULT_SHADOW_CONFIG.minTrials;

/** The stores a workspace publishes from. */
export interface PublishSources {
  sql: SqlExecutor;
  craftStore: CraftStore;
  facts: FactsStore;
  /** One scaffold version's source, as `scaffold/shadow.ts` reads it. A seam
   *  rather than the whole runtime: publishing needs exactly this one read out
   *  of the agent-writable VFS and nothing else from it. */
  readScaffoldVersion(version: number): Promise<string | null>;
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

interface ScaffoldVersionRow { version: number; status: ScaffoldStatus; rationale: string; written_at: number }

const VetoSurfaceSchema = v.object({ surface: v.optional(v.string()) });

/** Misevolution vetoes recorded in `[from, to]` against something this
 *  workspace WROTE — a scaffold proposal, an extracted craft, a tool the model
 *  persisted. Vetoes on the `import` surface are excluded: those are another
 *  workspace's text refused at this boundary, which says nothing about the loop
 *  that was running when it arrived. */
function ownMisevolutionFlags(sql: SqlExecutor, from: number, to: number): number {
  const rows = sql<{ data: string | null }>`
    SELECT data FROM evolution_events
    WHERE type = 'misevolution_veto' AND created_at BETWEEN ${from} AND ${to}`;
  return rows.filter((row) => {
    // `data` is recordMisevolutionVeto's own write, so a payload that will not
    // parse is corruption in our row rather than a foreign format to shrug at —
    // the same reading scaffold/archive.ts takes of these events.
    const parsed = v.parse(VetoSurfaceSchema, parseJsonValue(row.data ?? '{}'));
    return (parsed.surface ?? 'scaffold') !== 'import';
  }).length;
}

async function scaffoldCandidate(
  src: PublishSources,
  key: string,
): Promise<PublishableCandidate | PublishRefusal> {
  const version = Number(key);
  if (key.trim() === '' || !Number.isInteger(version) || version < 0) {
    return { refused: `"${key}" is not a scaffold version — a scaffold is published by its version number` };
  }
  const row = src.sql<ScaffoldVersionRow>`
    SELECT version, status, rationale, written_at FROM scaffold_versions
    WHERE version = ${version} LIMIT 1`[0];
  if (!row) return { refused: `no scaffold version v${version} in this workspace` };
  if (row.status !== 'current') {
    return {
      refused: `scaffold v${version} is ${row.status}, not the version this workspace runs — `
        + 'only a loop the local shadow gate promoted has been proven here',
    };
  }

  // Promoted, but promoted on WHAT? Re-read the version's own trial record
  // through the gate that decides promotions, rather than restating its rule:
  // the v0 bootstrap (never tried) and a hand-forced promote (thin record) both
  // carry status='current' and neither earned it.
  const record = readShadowVerdict(src.sql, version).summary;
  const gate = decidePromotion({
    trialsSoFar: record.trials,
    pendingWins: record.pendingWins,
    currentWins: record.currentWins,
  }, DEFAULT_SHADOW_CONFIG);
  if (gate.decision !== 'promote') {
    return {
      refused: `scaffold v${version} is live but its shadow record does not clear the promotion gate `
        + `(${record.pendingWins}W-${record.currentWins}L-${record.ties}T over ${record.trials} trial`
        + `${record.trials === 1 ? '' : 's'}), so nothing here has actually proven it`,
    };
  }

  // Probation: the graded turns this version SERVED. `turn_outcomes` stamps the
  // live version on every verdict, and a version is only live after promotion,
  // so these rows are exactly "turns since promotion" with no timestamp
  // bookkeeping of their own.
  const turns = src.sql<{ created_at: number }>`
    SELECT created_at FROM turn_outcomes WHERE scaffold_version = ${version}
    ORDER BY created_at ASC LIMIT ${EXPERIENCE_SCAFFOLD_SURVIVAL_TURNS}`;
  if (turns.length < EXPERIENCE_SCAFFOLD_SURVIVAL_TURNS) {
    return {
      refused: `scaffold v${version} has served ${turns.length} graded turn`
        + `${turns.length === 1 ? '' : 's'} since promotion, below the `
        + `${EXPERIENCE_SCAFFOLD_SURVIVAL_TURNS}-turn probation this workspace's own promotion gate `
        + 'demands as evidence (DEFAULT_SHADOW_CONFIG.minTrials)',
    };
  }
  const flags = ownMisevolutionFlags(src.sql, turns[0].created_at, turns[turns.length - 1].created_at);
  if (flags > 0) {
    return {
      refused: `scaffold v${version} drew ${flags} misevolution veto${flags === 1 ? '' : 'es'} during its `
        + `${EXPERIENCE_SCAFFOLD_SURVIVAL_TURNS}-turn probation here — a loop that evolves unsafe `
        + 'artifacts is not one to hand another workspace',
    };
  }

  const code = await src.readScaffoldVersion(version);
  if (code === null) {
    return { refused: `scaffold v${version} has no source in this workspace's version store, so there is nothing to share` };
  }
  const decisive = record.pendingWins + record.currentWins;
  return {
    kind: 'scaffold',
    key: String(version),
    title: titleOf(`Scaffold v${version} — ${row.rationale}`),
    payload: { kind: 'scaffold', version, rationale: row.rationale, code },
    evidence: `promoted here on ${record.pendingWins} of ${decisive} decisive shadow trials `
      + `(win-rate ${Math.round(gate.winRate * 100)}%), then ${EXPERIENCE_SCAFFOLD_SURVIVAL_TURNS} `
      + 'graded turns live with no misevolution veto',
  };
}

function isRefusal(value: PublishableCandidate | PublishRefusal): value is PublishRefusal {
  return 'refused' in value;
}

/** Resolve one named artifact into a publishable candidate, or say why not. */
export async function findPublishable(
  src: PublishSources,
  kind: ExperienceKind,
  key: string,
  now = nowMs(),
): Promise<PublishableCandidate | PublishRefusal> {
  switch (kind) {
    case 'craft': return craftCandidate(src, key, craftScores(src.sql), now);
    case 'lesson': return lessonCandidate(src, key);
    case 'fact': return factCandidate(src, key);
    case 'scaffold': return await scaffoldCandidate(src, key);
  }
}

/** Everything this workspace could share right now, newest evidence first
 *  within each kind. The agent's "what do I have to offer" view. */
export async function listPublishable(
  src: PublishSources,
  options: { limit?: number; now?: number } = {},
): Promise<PublishableCandidate[]> {
  const limit = Math.max(1, options.limit ?? 20);
  const now = options.now ?? nowMs();
  const scores = craftScores(src.sql);

  const crafts = src.craftStore.list()
    .map((tool) => craftCandidate(src, tool.name, scores, now))
    .filter((c): c is PublishableCandidate => !isRefusal(c));

  const lessons = listLessons(src.sql, { status: 'corroborated', limit })
    .map((lesson) => lessonCandidate(src, lesson.id))
    .filter((c): c is PublishableCandidate => !isRefusal(c));

  const facts = src.facts.recentTopK(limit)
    .filter((f) => f.confidence >= EXPERIENCE_MIN_FACT_CONFIDENCE)
    .map((f) => factCandidate(src, f.key))
    .filter((c): c is PublishableCandidate => !isRefusal(c));

  // At most one scaffold: the live version is the only publishable one and
  // there is exactly one of it. Listed first because it can never be crowded
  // out of a limit by a workspace with many crafts.
  const live = getCurrentScaffoldVersion(src.sql);
  const scaffold = live === null ? null : await scaffoldCandidate(src, String(live));
  const scaffolds = scaffold !== null && !isRefusal(scaffold) ? [scaffold] : [];

  return [...scaffolds, ...crafts, ...lessons, ...facts].slice(0, limit);
}
