// Publish bars per kind: only artifacts with local evidence cross into the owner's other workspaces.

import * as v from 'valibot';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { CraftStore } from '../types/agent-runtime';
import type { FactsStore } from '../memory/facts';
import { diagnostics, toKinuError, tolerate } from '../obs/index';
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

const EXPERIENCE_MIN_FACT_CONFIDENCE = 0.8;

/** Live graded turns required after promotion: the same evidence count the shadow gate demands offline. */
const EXPERIENCE_SCAFFOLD_SURVIVAL_TURNS = DEFAULT_SHADOW_CONFIG.minTrials;

export interface PublishSources {
  sql: SqlExecutor;
  actor: ActorHandle;
  craftStore: CraftStore;
  facts: FactsStore;
  readScaffoldVersion(version: number): Promise<string | null>;
}

export type PublishRefusal = { refused: string };

function titleOf(text: string, maxChars = 90): string {
  const line = text.trim().split('\n', 1)[0] ?? '';

  return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line || 'untitled';
}

interface CraftScoreRow { name: string; score: number; uses: number; last_used_at: number }

function craftScores(sql: SqlExecutor): Map<string, CraftScoreRow> {
  return new Map(
    sql<CraftScoreRow>`SELECT name, score, uses, last_used_at FROM crafted_tools`
      .map((r) => [r.name, r]),
  );
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
  const lesson = getLesson(src.sql, src.actor, id);

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

/** Vetoes in `[from, to]` on this workspace's own writes; `import`-surface vetoes are excluded. */
function ownMisevolutionFlags(
  sql: SqlExecutor, actor: ActorHandle, from: number, to: number,
): number {
  actor.assertCurrent();

  const rows = sql<{ data: string | null }>`
    SELECT data FROM evolution_events
    WHERE actor_id = ${actor.actorId} AND type = 'misevolution_veto'
      AND created_at BETWEEN ${from} AND ${to}`;

  return rows.filter((row) => {
    // An unparsable row is our own corruption: count it as a flag (fail closed) and report it.
    const decoded = tolerate(() => parseJsonValue(row.data ?? '{}'), 'malformed-input');
    const parsed = v.safeParse(VetoSurfaceSchema, decoded);

    if (!parsed.success) {
      diagnostics.failure(
        'experience.publishable_veto_unreadable',
        toKinuError({
          doing: 'decode a misevolution veto row',
          cause: parsed.issues.map((issue) => issue.message).join('; '),
          otherwise: 'bad_input',
        }),
      );

      return true;
    }

    return (parsed.output.surface ?? 'scaffold') !== 'import';
  }).length;
}

async function scaffoldCandidate(
  src: PublishSources,
  key: string,
  now = nowMs(),
): Promise<PublishableCandidate | PublishRefusal> {
  const version = Number(key);

  if (key.trim() === '' || !Number.isInteger(version) || version < 0) {
    return { refused: `"${key}" is not a scaffold version — a scaffold is published by its version number` };
  }

  src.actor.assertCurrent();

  const row = src.sql<ScaffoldVersionRow>`
    SELECT version, status, rationale, written_at FROM scaffold_versions
    WHERE actor_id = ${src.actor.actorId} AND version = ${version} LIMIT 1`[0];

  if (!row) return { refused: `no scaffold version v${version} in this workspace` };

  if (row.status !== 'current') {
    return {
      refused: `scaffold v${version} is ${row.status}, not the version this workspace runs — `
        + 'only a loop the local shadow gate promoted has been proven here',
    };
  }

  // status='current' is not enough: the v0 bootstrap and forced promotes never earned it.
  const record = readShadowVerdict(src.sql, src.actor, version).summary;

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

  // Rows stamped with this version are exactly the turns since promotion; the veto window runs to now.
  const turns = src.sql<{ created_at: number }>`
    SELECT created_at FROM turn_outcomes
    WHERE actor_id = ${src.actor.actorId} AND scaffold_version = ${version}
    ORDER BY created_at ASC LIMIT ${EXPERIENCE_SCAFFOLD_SURVIVAL_TURNS}`;

  if (turns.length < EXPERIENCE_SCAFFOLD_SURVIVAL_TURNS) {
    return {
      refused: `scaffold v${version} has served ${turns.length} graded turn`
        + `${turns.length === 1 ? '' : 's'} since promotion, below the `
        + `${EXPERIENCE_SCAFFOLD_SURVIVAL_TURNS}-turn probation this workspace's own promotion gate `
        + 'demands as evidence (DEFAULT_SHADOW_CONFIG.minTrials)',
    };
  }

  const flags = ownMisevolutionFlags(src.sql, src.actor, turns[0]?.created_at ?? now, now);

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
    case 'scaffold': return await scaffoldCandidate(src, key, now);
  }
}

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

  const lessons = listLessons(src.sql, src.actor, { status: 'corroborated', limit })
    .map((lesson) => lessonCandidate(src, lesson.id))
    .filter((c): c is PublishableCandidate => !isRefusal(c));

  const facts = src.facts.recentTopK(limit)
    .filter((f) => f.confidence >= EXPERIENCE_MIN_FACT_CONFIDENCE)
    .map((f) => factCandidate(src, f.key))
    .filter((c): c is PublishableCandidate => !isRefusal(c));

  // The single live scaffold goes first so crafts cannot crowd it out of the limit.
  const live = getCurrentScaffoldVersion(src.sql, src.actor);
  const scaffold = live === null ? null : await scaffoldCandidate(src, String(live), now);
  const scaffolds = scaffold !== null && !isRefusal(scaffold) ? [scaffold] : [];

  return [...scaffolds, ...crafts, ...lessons, ...facts].slice(0, limit);
}
