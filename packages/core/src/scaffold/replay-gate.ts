/**
 * The pending scaffold's way to current without the owner (docs/EVOLUTION.md, "Scaffold replay"): replayed once, off
 * turn, against the agent's recorded turns; a pass is promoted at the next turn whose prompt cache is cold, through the
 * same decision that re-checks the misevolution criteria; a failure is rolled back with the replay's reason.
 */

import * as v from 'valibot';
import type { ScaffoldControl } from '../evolution/control';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { parseJsonValue } from '../utils/json';
import { WORKSPACE_RUN_ID } from '../events/model-call';
import { applyPromotionDecision, getPendingScaffold, scaffoldSource } from './versions';
import { replayScaffold, type RecordedTurn } from './replay';

const ReplayedSchema = v.object({ version: v.number(), turns: v.number() });

/** Whether `version` passed its replay. */
function replayed(sql: SqlExecutor, actor: ActorHandle, version: number): boolean {
  actor.assertCurrent();

  return sql<{ payload: string }>`SELECT payload FROM run_events WHERE actor_id = ${actor.actorId} AND type = 'scaffold_replayed'`
    .some((row) => v.parse(ReplayedSchema, parseJsonValue(row.payload)).version === version);
}

/**
 * The pending version, replayed once against the newest answered turns (`turns`). A pass is recorded for the next cold
 * turn; a failure rolls it back now, with the replay's reason on the rollback.
 */
export async function replayPendingScaffold(control: ScaffoldControl, turns: () => Promise<RecordedTurn[]>): Promise<void> {
  const { rt, sql, events } = control;
  const pending = getPendingScaffold(sql, rt.actor);

  if (pending === null || replayed(sql, rt.actor, pending.version)) return;
  const source = await scaffoldSource(rt, pending.version);
  const recorded = await turns();

  const verdict = source === null
    ? { turnId: null, failed: `no source is stored for v${String(pending.version)}` }
    : await replayScaffold(rt, source, recorded);

  if (verdict === null) {
    events.emit(WORKSPACE_RUN_ID, { type: 'scaffold_replayed', version: pending.version, turns: recorded.length });

    return;
  }

  const on = verdict.turnId === null ? '' : ` on turn ${verdict.turnId}`;
  await applyPromotionDecision(rt, pending, { rollback: `its replay failed${on}: ${verdict.failed}` }, events);
}

/** At a turn whose prompt cache is cold, before its program is chosen: a pending version that passed its replay becomes current. */
export async function activateReplayedScaffold(control: ScaffoldControl): Promise<void> {
  const { rt, sql, events } = control;
  const pending = getPendingScaffold(sql, rt.actor);

  if (pending !== null && replayed(sql, rt.actor, pending.version)) await applyPromotionDecision(rt, pending, 'promote', events);
}
