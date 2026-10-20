/**
 * The watch (docs/EVOLUTION.md, "The watch"): every change in effect, held to the turns that ran with it, each read
 * through its owner (`change-standing.ts`). Two signals revert one at the dream lane's next pass: a rated reply that
 * explicitly rejects a dream's change, and, for the scaffold version made current, a turn it threw on or its low-rated
 * turns beyond chance against the version it replaced. Text is never reverted by a count: the next dream revises it.
 */

import * as v from 'valibot';
import { Result } from 'effect';
import { parseJsonValue } from '../utils/json';
import { WORKSPACE_RUN_ID } from '../events/model-call';
import { CompletedTurnSchema } from './session-window';
import { getCurrentScaffoldVersion, replacedBy } from '../scaffold/versions';
import { rollbackScaffold } from '../scaffold/rollback';
import { createFactsStore, type FactsStore } from '../memory/facts';
import { parseSkillFile } from '../skills/parse';
import { evidenceWindow } from '../utils/evidence-window';
import { diagnostics } from '../obs/index';
import { RunEventRecorder } from '../events/recorder';
import { artifactLabel, artifactVersion } from './artifacts';
import { changeOwners, changeStanding, scaffoldStanding, type ChangeOwners, type ChangeStanding, type Standing } from './change-standing';
import { executeChangelogRevert, type ChangelogRevertAction } from './changelog';
import { isCorrected, isLowRating, listRejections, listTurnRatings, type TurnRating } from './ratings';
import {
  createRefinementStore, type RefinementDeps, type RefinementEdit, type RefinementRequest, type RefinementRoute,
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
  /** Where it stands now: a turn may have run with a text version since replaced. */
  readonly standing: ChangeStanding;
}

interface Routed {
  readonly request: RefinementRequest;
  readonly route: RefinementRoute;
  readonly edit: RefinementEdit;
  readonly index: number;
}

function textChange(owners: ChangeOwners, standing: Standing, { route }: Routed, ran: ReadonlySet<string>): DreamChange | null {
  const at = route.target.lastIndexOf('@');
  const row = at <= 0 || !ran.has(route.target) ? null : artifactVersion(owners.sql, owners.actor, route.target.slice(0, at), Number(route.target.slice(at + 1)));

  if (row === null) return null;

  return {
    id: route.target,
    describe: `${artifactLabel(row.artifactId)} was reworded; it now reads: "${evidenceWindow(row.body, DESCRIBED_CHARS)}"`,
    since: standing.since,
    revert: { type: 'artifact_revert', target: route.target },
    standing: standing.standing,
  };
}

function factChange(facts: FactsStore, standing: Standing, { route }: Routed): DreamChange | null {
  const fact = facts.recall(route.target);

  if (standing.standing !== 'in_effect' || fact === null) return null;

  return {
    id: `fact:${route.target}`,
    describe: `the agent remembers ${route.target}: ${evidenceWindow(JSON.stringify(fact.value), DESCRIBED_CHARS)}`,
    since: standing.since,
    revert: { type: 'fact_forget', target: route.target },
    standing: standing.standing,
  };
}

function skillChange(standing: Standing, { request, route, edit, index }: Routed): DreamChange | null {
  if (standing.standing !== 'in_effect' || edit.kind !== 'skill') return null;
  const parsed = parseSkillFile(edit.source, 'agent');

  if (Result.isFailure(parsed)) return null;

  return {
    id: `skill:${route.target}`,
    describe: `the agent follows a skill it wrote, ${parsed.success.name}: ${evidenceWindow(parsed.success.description, DESCRIBED_CHARS)}`,
    since: standing.since,
    revert: { type: 'skill_revert', target: `${request.id}#${String(index)}` },
    standing: standing.standing,
  };
}

/**
 * The dream changes in effect for a turn, newest first, at most `limit`: each text version it ran with (`ranWith`),
 * each fact a dream still holds, and each skill a dream wrote that is trusted.
 */
export function dreamChangesFor(owners: ChangeOwners, ranWith: readonly string[] | null, limit = LISTED_CHANGES): DreamChange[] {
  const ran = new Set(ranWith ?? []);
  const facts = createFactsStore(owners.sql, owners.actor);

  return dreamRoutes(owners, DREAMS_READ)
    .flatMap((routed) => {
      const change = changeOf(routed);

      return change === null ? [] : [change];
    })
    .sort((a, b) => b.since - a.since).slice(0, limit);

  function changeOf(routed: Routed): DreamChange | null {
    const standing = changeStanding(owners, facts, routed);

    if (standing === null || standing.standing === 'refused') return null;

    switch (routed.route.kind) {
      case 'prompt_section':
      case 'tool_description': return textChange(owners, standing, routed, ran);
      case 'fact': return factChange(facts, standing, routed);
      case 'skill': return skillChange(standing, routed);
      case 'subagent_spec': return null;
    }
  }
}

/** Each edit the last `dreams` dreams routed, with the drafted edit it came from. */
function dreamRoutes({ sql, actor }: ChangeOwners, dreams: number): Routed[] {
  return createRefinementStore(sql, actor).list(dreams).flatMap((request) => request.routes.flatMap((route, index) => {
    const edit = request.proposal?.edits[index];

    return edit === undefined ? [] : [{ request, route, edit, index }];
  }));
}

const STANDING_TEXT = {
  refused: 'refused',
  waiting: 'waiting for a cold turn',
  in_effect: 'in effect',
  reverted: 'reverted',
  replaced: 'replaced by a later version',
} as const satisfies Record<ChangeStanding, string>;

interface Watched {
  readonly what: string;
  readonly status: string;
  readonly since: number;
  /** Whether a rated turn ran with it. */
  readonly carried: (rating: TurnRating) => boolean;
  readonly id: string;
}

function watched(owners: ChangeOwners, facts: FactsStore, routed: Routed): Watched | null {
  const standing = changeStanding(owners, facts, routed);

  if (standing === null || standing.standing === 'refused') return null;
  const { route } = routed;
  const status = STANDING_TEXT[standing.standing];
  const effective = standing.standing === 'in_effect';

  switch (route.kind) {
    case 'prompt_section':
    case 'tool_description': {
      const at = route.target.lastIndexOf('@');
      const row = artifactVersion(owners.sql, owners.actor, route.target.slice(0, at), Number(route.target.slice(at + 1)));

      return row === null ? null : {
        id: route.target, what: `${artifactLabel(row.artifactId)}, reworded`, status,
        since: standing.since, carried: (rating) => rating.artifacts?.includes(route.target) === true,
      };
    }

    case 'fact':
      return {
        id: `fact:${route.target}`, what: `remembering ${route.target}`, status: effective ? status : 'forgotten or replaced',
        since: standing.since, carried: (rating) => effective && rating.createdAt > standing.since,
      };

    case 'skill':
      return {
        id: `skill:${route.target}`, what: `the skill at ${route.target}`, status,
        since: standing.since, carried: (rating) => effective && rating.createdAt > standing.since,
      };

    case 'subagent_spec':
      return null;
  }
}

function turnsSummary(ratings: readonly TurnRating[]): string {
  const mean = ratings.reduce((total, rating) => total + rating.score, 0) / ratings.length;
  const corrected = ratings.filter(isCorrected).length;

  return `mean ${mean.toFixed(1)} with ${String(corrected)} corrected`;
}

/**
 * What earlier dreams changed and how the turns went with it, one line per change: its status, the rated turns that
 * ran with it against as many rated just before it, and the replies that rejected it. Both of a dream's agents read it.
 */
export function renderWatch(owners: ChangeOwners): string {
  const { sql, actor } = owners;
  const facts = createFactsStore(sql, actor);
  const ratings = listTurnRatings(sql, actor, { limit: RATINGS_READ });
  const rejections = listRejections(sql, actor, 0);

  return dreamRoutes(owners, WATCHED_DREAMS).flatMap((routed) => {
    const change = watched(owners, facts, routed);

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

/**
 * The owner's explicit stops, kept: each change a rated reply rejected, sure it corrected the turn, that is still in
 * effect and took effect before that reply, is reverted as the owner's own revert would. Runs before a dream, so the
 * dream reads the agent as the owner left it.
 */
async function revertRejectedChanges(deps: RefinementDeps, owners: ChangeOwners): Promise<void> {
  const { sql, rt } = deps.control;
  const events = new RunEventRecorder(sql, rt.actor);

  for (const rejection of listRejections(sql, rt.actor, EXPLICIT_STOP)) {
    const change = dreamChangesFor(owners, rejection.artifacts, Infinity).find((listed) => listed.id === rejection.rejects);

    if (change === undefined || change.since >= rejection.at || change.standing !== 'in_effect') continue;
    const reverted = await executeChangelogRevert({ rt, facts: deps.facts, events, skills: deps }, change.revert);

    if (reverted.ok) diagnostics.event('dream.change_rejected', { change: change.id, turn: rejection.turnId });
  }
}

/** Rated turns a scaffold version is watched for. */
const WATCHED_TURNS = 10;

/** The replaced version's rated turns its share is read from. */
const BASELINE_TURNS = 30;

/** 5% across the watch's ten looks (Bonferroni): one look's bound. */
const REGRESSION_BOUND = 0.05 / WATCHED_TURNS;

/** P(X >= k) for X ~ Binomial(n, p). */
function upperTail(k: number, n: number, p: number): number {
  let total = 0;
  let term = (1 - p) ** n;

  for (let i = 0; i <= n; i += 1) {
    if (i >= k) total += term;
    term = term * ((n - i) / (i + 1)) * (p / (1 - p));
  }

  return Math.min(1, total);
}

function lowShare(ratings: readonly TurnRating[]) {
  return { low: ratings.filter((rating) => isLowRating(rating.score)).length, of: ratings.length };
}

/** The scaffold version under watch: in effect since a promotion that replaced `replaced`. */
interface WatchedScaffold {
  readonly version: number;
  readonly replaced: number;
  readonly since: number;
}

/** Why the version goes back, or null while it holds. */
function scaffoldVerdict({ sql, actor }: ChangeOwners, { version, since, replaced }: WatchedScaffold): string | null {
  const threw = sql<{ turn: string }>`SELECT turn FROM completed_turns WHERE actor_id = ${actor.actorId} AND created_at >= ${since}`
    .map((row) => v.safeParse(CompletedTurnSchema, parseJsonValue(row.turn)))
    .flatMap((parsed) => (parsed.success && parsed.output.scaffold?.version === version && parsed.output.scaffold.threw !== undefined
      ? [{ turnId: parsed.output.turnId, threw: parsed.output.scaffold.threw }]
      : []))[0];

  if (threw !== undefined) return `it threw on turn ${threw.turnId}: ${threw.threw}`;

  const rated = listTurnRatings(sql, actor, { since }).filter((rating) => rating.scaffoldVersion === version);
  const baseline = listTurnRatings(sql, actor).filter((rating) => rating.scaffoldVersion === replaced).slice(0, BASELINE_TURNS);
  const now = lowShare(rated);
  const before = lowShare(baseline);
  // Smoothed, so a clean baseline is not certainty and an empty one is a coin.
  const expected = (before.low + 1) / (before.of + 2);

  if (now.of === 0 || upperTail(now.low, now.of, expected) >= REGRESSION_BOUND) return null;

  return `${String(now.low)} of its ${String(now.of)} rated turns were low, against ${String(before.low)} of `
    + `${String(before.of)} under v${String(replaced)}`;
}

/** The current scaffold version, while a promotion made it so and fewer than 10 of its turns are rated. */
function watchedScaffold(owners: ChangeOwners): WatchedScaffold | null {
  const version = getCurrentScaffoldVersion(owners.sql, owners.actor);
  const promotion = version === null ? null : replacedBy(owners.sql, owners.actor, version);

  if (version === null || promotion === null || scaffoldStanding(owners, version)?.standing !== 'in_effect') return null;
  const rated = listTurnRatings(owners.sql, owners.actor, { since: promotion.at }).filter((rating) => rating.scaffoldVersion === version).length;

  return rated > WATCHED_TURNS ? null : { version, replaced: promotion.replaced, since: promotion.at };
}

/** A scaffold version that threw or regressed goes back to the one it replaced, with why on its rollback event. */
async function revertRegressedScaffold(deps: RefinementDeps, owners: ChangeOwners): Promise<void> {
  const { rt, events } = deps.control;
  const watching = watchedScaffold(owners);
  const reason = watching === null ? null : scaffoldVerdict(owners, watching);

  if (watching === null || reason === null) return;
  const restored = await rollbackScaffold(rt, watching.replaced);

  if (Result.isFailure(restored)) return;
  events.emit(WORKSPACE_RUN_ID, { type: 'scaffold_rollback', fromVersion: watching.version, toVersion: watching.replaced, reason });
}

/** The watch's one look, on the dream lane's pass, before its replay and its dream. */
export async function watchChanges(deps: RefinementDeps): Promise<void> {
  const owners = changeOwners(deps);

  await revertRegressedScaffold(deps, owners);
  await revertRejectedChanges(deps, owners);
}
