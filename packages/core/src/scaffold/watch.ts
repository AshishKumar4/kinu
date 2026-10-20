/**
 * The scaffold watch (docs/EVOLUTION.md, "Scaffold replay"): a version made current is watched until 10 of its turns
 * are rated. It goes back to the version it replaced when one of its turns throws, or when its share of low-rated
 * turns is above the replaced version's last 30 by more than chance allows, by a one-sided binomial bound.
 */

import * as v from 'valibot';
import { Result } from 'effect';
import type { ScaffoldControl } from '../evolution/control';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { parseJsonValue } from '../utils/json';
import { WORKSPACE_RUN_ID } from '../events/model-call';
import { isLowRating, listTurnRatings, type TurnRating } from '../evolution/ratings';
import { CompletedTurnSchema } from '../evolution/session-window';
import { getCurrentScaffoldVersion } from './versions';
import { rollbackScaffold } from './rollback';

/** Rated turns a version is watched for. */
const WATCHED_TURNS = 10;

/** The replaced version's rated turns its share is read from. */
const BASELINE_TURNS = 30;

/** 5% across the watch's ten looks (Bonferroni): one look's bound. */
const REGRESSION_BOUND = 0.05 / WATCHED_TURNS;

const PromotionSchema = v.object({ fromVersion: v.number(), toVersion: v.number() });

/** The version `version` replaced, and when, from its latest promotion; null for one no promotion made current. */
export function replacedBy(sql: SqlExecutor, actor: ActorHandle, version: number): { readonly replaced: number; readonly at: number } | null {
  actor.assertCurrent();

  const promotions = sql<{ payload: string; ts: string }>`SELECT payload, ts FROM run_events
    WHERE actor_id = ${actor.actorId} AND type = 'scaffold_promotion' ORDER BY ts DESC`
    .map((row) => ({ ...v.parse(PromotionSchema, parseJsonValue(row.payload)), at: Date.parse(row.ts) }))
    .filter((promotion) => promotion.toVersion === version);

  const latest = promotions[0];

  return latest === undefined ? null : { replaced: latest.fromVersion, at: latest.at };
}

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

/** The current version under watch: made current by a promotion `since`, replacing `replaced`. */
interface Watching {
  readonly version: number;
  readonly replaced: number;
  readonly since: number;
}

/** Why the current version goes back, or null while it holds. */
function verdict(sql: SqlExecutor, actor: ActorHandle, { version, since, replaced }: Watching): string | null {
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

/** Whether the current version is still watched: made current by a promotion, with fewer than 10 of its turns rated. */
function watched(sql: SqlExecutor, actor: ActorHandle): Watching | null {
  const version = getCurrentScaffoldVersion(sql, actor);
  const promotion = version === null ? null : replacedBy(sql, actor, version);

  if (version === null || promotion === null) return null;
  const rated = listTurnRatings(sql, actor, { since: promotion.at }).filter((rating) => rating.scaffoldVersion === version).length;

  return rated > WATCHED_TURNS ? null : { version, replaced: promotion.replaced, since: promotion.at };
}

/** The watch's one look, on the dream lane's pass: a version that threw or regressed goes back to the one it replaced. */
export async function watchScaffold(control: ScaffoldControl): Promise<void> {
  const { rt, sql, events } = control;
  const watching = watched(sql, rt.actor);
  const reason = watching === null ? null : verdict(sql, rt.actor, watching);

  if (watching === null || reason === null) return;
  const restored = await rollbackScaffold(rt, watching.replaced);

  if (Result.isFailure(restored)) return;
  events.emit(WORKSPACE_RUN_ID, { type: 'scaffold_rollback', fromVersion: watching.version, toVersion: watching.replaced, reason });
}
