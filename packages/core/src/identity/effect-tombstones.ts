// Durable record that keyed work already ran, kept after its row is retired; a replay
// would otherwise redo append-only effects. Unlike tools/effect-claim.ts it is written after and never swept.

import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from './actor-handle';
import { diagnostics } from '../obs/index';
import { nowMs } from '../utils/date';

export function initEffectTombstoneTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS effect_tombstones (
    actor_id    TEXT NOT NULL,
    scope       TEXT NOT NULL,
    key         TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, scope, key)
  )`);
}

/** True when this actor has recorded this scope+key. Keys are minted per actor, so the owner is part of the identity. */
export function effectAlreadyDone(
  sql: SqlExecutor, actor: ActorHandle, scope: string, key: string,
): boolean {
  actor.assertCurrent();

  return sql<{ n: number }>`
    SELECT 1 AS n FROM effect_tombstones
    WHERE actor_id = ${actor.actorId} AND scope = ${scope} AND key = ${key} LIMIT 1`.length > 0;
}

export interface EffectKey {
  readonly scope: string;
  readonly key: string;
}

/** Idempotent; a second call keeps the first timestamp. */
export function recordEffectDone(
  sql: SqlExecutor, actor: ActorHandle, effect: EffectKey, now?: number,
): void {
  actor.assertCurrent();
  void sql`INSERT INTO effect_tombstones (actor_id, scope, key, recorded_at)
      VALUES (${actor.actorId}, ${effect.scope}, ${effect.key}, ${now ?? nowMs()})
      ON CONFLICT(actor_id, scope, key) DO NOTHING`;
}

export interface TickedPass {
  readonly scope: string;
  /** Absent: the pass runs and nothing is keyed. */
  readonly tick: string | undefined;
  readonly workspace: string;
}

/** At most once per tick: a replay finding entry without completion abandons the pass. Entry commits with its first writes. */
export async function oncePerTick(
  sql: SqlExecutor, actor: ActorHandle, at: TickedPass, pass: () => Promise<void>,
): Promise<void> {
  const { scope, tick } = at;

  if (tick === undefined) {
    await pass();

    return;
  }

  if (effectAlreadyDone(sql, actor, scope, `${tick}:done`)) return;

  if (effectAlreadyDone(sql, actor, scope, `${tick}:entered`)) {
    diagnostics.event('evolution.interrupted_pass_abandoned', { workspace: at.workspace, lane: scope, tick });
    recordEffectDone(sql, actor, { scope, key: `${tick}:done` });

    return;
  }

  const running = pass();
  recordEffectDone(sql, actor, { scope, key: `${tick}:entered` });
  await running;
  recordEffectDone(sql, actor, { scope, key: `${tick}:done` });
}
