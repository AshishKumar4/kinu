/**
 * The watch (docs/EVOLUTION.md, "The watch"): what the dreams changed, held to the turns that ran with it. A rated
 * turn's rater is asked whether the reply rejects one of the dream changes the turn ran with, and an explicit stop
 * reverts that change at the dream lane's next pass.
 */

import { Result } from 'effect';
import type { ActorHandle } from '../identity/actor-handle';
import type { SqlExecutor } from '../types/primitives';
import { createFactsStore, type FactsStore } from '../memory/facts';
import { parseSkillFile } from '../skills/parse';
import { evidenceWindow } from '../utils/evidence-window';
import { diagnostics } from '../obs/index';
import { RunEventRecorder } from '../events/recorder';
import { artifactLabel, artifactVersion, type ArtifactStatus } from './artifacts';
import { executeChangelogRevert, type ChangelogRevertAction } from './changelog';
import { listRejections, listTurnRatings, type TurnRating } from './ratings';
import {
  createRefinementStore, type RefinementDeps, type RefinementDisposition, type RefinementEdit, type RefinementRequest, type RefinementRoute,
} from './refinement';

/** A rejection read as a correction at least this surely is an explicit stop: the change is reverted. */
const EXPLICIT_STOP = 0.8;

/** The rater reads at most this many changes, newest first. */
const LISTED_CHANGES = 6;

/** The dreams read for changes still in effect, newest first. */
const DREAMS_READ = 20;

/** Characters of a change's own text the rater reads. */
const DESCRIBED_CHARS = 400;

/** The dreams whose changes a dream's brief reports on. */
const WATCHED_DREAMS = 5;

/** The newest ratings a brief reads its numbers from. */
const RATINGS_READ = 500;

export interface DreamChange {
  /** `<artifactId>@<version>`, `fact:<key>` or `skill:<path>`. */
  readonly id: string;
  /** What the change is, as the rater reads it. */
  readonly describe: string;
  /** When it took effect. */
  readonly since: number;
  /** How the owner would revert it. */
  readonly revert: ChangelogRevertAction;
}

interface Routed {
  readonly request: RefinementRequest;
  readonly route: RefinementRoute;
  readonly edit: RefinementEdit;
  readonly index: number;
}

function textChange(sql: SqlExecutor, actor: ActorHandle, { route }: Routed, ran: ReadonlySet<string>): DreamChange | null {
  const at = route.target.lastIndexOf('@');
  const row = at <= 0 || !ran.has(route.target) ? null : artifactVersion(sql, actor, route.target.slice(0, at), Number(route.target.slice(at + 1)));

  if (row === null) return null;

  return {
    id: route.target,
    describe: `${artifactLabel(row.artifactId)} was reworded; it now reads: "${evidenceWindow(row.body, DESCRIBED_CHARS)}"`,
    since: row.decidedAt ?? row.writtenAt,
    revert: { type: 'artifact_revert', target: route.target },
  };
}

function factChange(facts: FactsStore, { request, route }: Routed): DreamChange | null {
  const fact = facts.recall(route.target);

  // A later write by anyone else makes the fact theirs.
  if (route.disposition !== 'applied' || fact?.source !== `refinement:${request.id}`) return null;

  return {
    id: `fact:${route.target}`,
    describe: `the agent remembers ${route.target}: ${evidenceWindow(JSON.stringify(fact.value), DESCRIBED_CHARS)}`,
    since: fact.lastObservedAt,
    revert: { type: 'fact_forget', target: route.target },
  };
}

function skillChange({ request, route, edit, index }: Routed): DreamChange | null {
  if (route.disposition !== 'applied' || edit.kind !== 'skill') return null;
  const parsed = parseSkillFile(edit.source, 'agent');

  if (Result.isFailure(parsed)) return null;

  return {
    id: `skill:${route.target}`,
    describe: `the agent follows a skill it wrote, ${parsed.success.name}: ${evidenceWindow(parsed.success.description, DESCRIBED_CHARS)}`,
    since: request.updatedAt,
    revert: { type: 'skill_revert', target: `${request.id}#${String(index)}` },
  };
}

/**
 * The dream changes in effect for a turn, newest first, at most `limit`: each text version it ran with (`ranWith`),
 * each fact a dream still holds, and each skill a dream wrote that is trusted.
 */
export function dreamChangesFor(sql: SqlExecutor, actor: ActorHandle, ranWith: readonly string[] | null, limit = LISTED_CHANGES): DreamChange[] {
  const ran = new Set(ranWith ?? []);
  const facts = createFactsStore(sql, actor);

  return dreamRoutes(sql, actor, DREAMS_READ)
    .flatMap((routed) => {
      const change = changeOf(routed);

      return change === null ? [] : [change];
    })
    .sort((a, b) => b.since - a.since).slice(0, limit);

  function changeOf(routed: Routed): DreamChange | null {
    switch (routed.route.kind) {
      case 'prompt_section':
      case 'tool_description': return textChange(sql, actor, routed, ran);
      case 'fact': return factChange(facts, routed);
      case 'skill': return skillChange(routed);
      case 'subagent_spec': return null;
    }
  }
}

/** Each edit the last `dreams` dreams routed, with the drafted edit it came from. */
function dreamRoutes(sql: SqlExecutor, actor: ActorHandle, dreams: number): Routed[] {
  return createRefinementStore(sql, actor).list(dreams).flatMap((request) => request.routes.flatMap((route, index) => {
    const edit = request.proposal?.edits[index];

    return edit === undefined ? [] : [{ request, route, edit, index }];
  }));
}

const TEXT_STATUS = {
  current: 'in effect',
  staged: 'waiting for a cold turn',
  rolled_back: 'reverted',
  historical: 'replaced by a later version',
} as const satisfies Record<ArtifactStatus, string>;

const SKILL_STATUS = {
  applied: 'in effect',
  staged: 'waiting for a cold turn',
  rejected: 'reverted',
  refused: 'refused',
} as const satisfies Record<RefinementDisposition, string>;

interface Watched {
  readonly what: string;
  readonly status: string;
  readonly since: number;
  /** Whether a rated turn ran with it. */
  readonly carried: (rating: TurnRating) => boolean;
  readonly id: string;
}

function watched(sql: SqlExecutor, actor: ActorHandle, facts: FactsStore, { request, route, edit }: Routed): Watched | null {
  if (route.disposition === 'refused') return null;

  switch (edit.kind) {
    case 'prompt_section':
    case 'tool_description': {
      const at = route.target.lastIndexOf('@');
      const row = at <= 0 ? null : artifactVersion(sql, actor, route.target.slice(0, at), Number(route.target.slice(at + 1)));

      if (row === null) return null;

      return {
        id: route.target, what: `${artifactLabel(row.artifactId)}, reworded`, status: TEXT_STATUS[row.status],
        since: row.decidedAt ?? row.writtenAt, carried: (rating) => rating.artifacts?.includes(route.target) === true,
      };
    }

    case 'fact': {
      const held = facts.recall(route.target)?.source === `refinement:${request.id}`;

      return {
        id: `fact:${route.target}`, what: `remembering ${route.target}`, status: held ? 'in effect' : 'forgotten or replaced',
        since: request.updatedAt, carried: (rating) => held && rating.createdAt > request.updatedAt,
      };
    }

    case 'skill':
      return {
        id: `skill:${route.target}`, what: `the skill at ${route.target}`, status: SKILL_STATUS[route.disposition],
        since: request.updatedAt, carried: (rating) => route.disposition === 'applied' && rating.createdAt > request.updatedAt,
      };

    case 'subagent_spec':
      return null;
  }
}

function turnsSummary(ratings: readonly TurnRating[]): string {
  const mean = ratings.reduce((total, rating) => total + rating.score, 0) / ratings.length;
  const corrected = ratings.filter((rating) => rating.corrected >= 0.5).length;

  return `mean ${mean.toFixed(1)} with ${String(corrected)} corrected`;
}

/**
 * What earlier dreams changed and how the turns went with it, one line per change: its status, the rated turns that
 * ran with it against as many rated just before it, and the replies that rejected it. Both of a dream's agents read it.
 */
export function renderWatch(sql: SqlExecutor, actor: ActorHandle): string {
  const facts = createFactsStore(sql, actor);
  const ratings = listTurnRatings(sql, actor, { limit: RATINGS_READ });
  const rejections = listRejections(sql, actor, 0);

  return dreamRoutes(sql, actor, WATCHED_DREAMS).flatMap((routed) => {
    const change = watched(sql, actor, facts, routed);

    if (change === null) return [];
    const after = ratings.filter(change.carried);
    const before = ratings.filter((rating) => rating.createdAt < change.since).slice(0, Math.max(after.length, 1));
    const rejected = rejections.filter((rejection) => rejection.rejects === change.id).length;

    const turns = after.length === 0
      ? 'no rated turn has run with it yet'
      : `${String(after.length)} rated turns ran with it, ${turnsSummary(after)}`
        + (before.length === 0 ? '' : `; the ${String(before.length)} rated before it, ${turnsSummary(before)}`);

    return [`  - ${change.what} (${change.id}), ${change.status}: ${turns}; ${String(rejected)} replies rejected it`];
  }).join('\n');
}

/** A text version is in effect while it is current; a fact or skill change is listed only while it is. */
function stillInEffect(sql: SqlExecutor, actor: ActorHandle, change: DreamChange): boolean {
  if (change.revert.type !== 'artifact_revert') return true;
  const at = change.id.lastIndexOf('@');

  return artifactVersion(sql, actor, change.id.slice(0, at), Number(change.id.slice(at + 1)))?.status === 'current';
}

/**
 * The owner's explicit stops, kept: each change a rated reply rejected, sure it corrected the turn, that is still in
 * effect and took effect before that reply, is reverted as the owner's own revert would. Runs before a dream, so the
 * dream reads the agent as the owner left it.
 */
export async function revertRejectedChanges(deps: RefinementDeps): Promise<void> {
  const { sql, rt } = deps.control;
  const events = new RunEventRecorder(sql, rt.actor);

  for (const rejection of listRejections(sql, rt.actor, EXPLICIT_STOP)) {
    const change = dreamChangesFor(sql, rt.actor, rejection.artifacts, Infinity).find((listed) => listed.id === rejection.rejects);

    if (change === undefined || change.since >= rejection.at || !stillInEffect(sql, rt.actor, change)) continue;
    const reverted = await executeChangelogRevert({ rt, facts: deps.facts, events, skills: deps }, change.revert);

    if (reverted.ok) diagnostics.event('dream.change_rejected', { change: change.id, turn: rejection.turnId });
  }
}
