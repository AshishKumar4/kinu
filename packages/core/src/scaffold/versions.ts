/**
 * The scaffold's versions: the one reader of the version an actor runs (every status read uses it), the source of any
 * version, the waiting proposal, and the owner's promote or roll back of it.
 */
import { exists, readText } from '@nimbus-sh/core/vfs/vfs.js';
import { markStoreChanged } from '@kinu.run/agent-utils';
import { Effect } from 'effect';
import * as v from 'valibot';
import type { AgentRuntime } from '../types/agent-runtime';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { diagnostics, KinuError, settle, toKinuError } from '../obs/index';
import { checkMisevolution, recordMisevolutionVeto } from '../safety/misevolution';
import type { RunEventRecorder } from '../events/recorder';
import { WORKSPACE_RUN_ID } from '../events/model-call';

export type ScaffoldDecisionEvents = Pick<RunEventRecorder, 'actorId' | 'emit'>;

/** The proposal waiting for the owner's decision. */
export interface PendingScaffold {
  readonly version: number;
  readonly writtenAt: number;
  readonly rationale: string;
}

/** The single status='pending' version, or null. */
export function getPendingScaffold(sql: SqlExecutor, actor: ActorHandle): PendingScaffold | null {
  actor.assertCurrent();

  const [row] = sql<{ version: number; written_at: number; rationale: string }>`
    SELECT version, written_at, rationale FROM scaffold_versions
    WHERE actor_id = ${actor.actorId} AND status = 'pending'
    ORDER BY version DESC LIMIT 1`;

  return row === undefined ? null : { version: row.version, writtenAt: row.written_at, rationale: row.rationale };
}

/** Highest status='current' version. Never `pending - 1` or MAX: numbering is non-contiguous after rollbacks, and MAX counts a pending proposal. */
export function getCurrentScaffoldVersion(sql: SqlExecutor, actor: Pick<ActorHandle, 'actorId' | 'assertCurrent'>): number | null {
  actor.assertCurrent();

  const rows = sql<{ version: number }>`
    SELECT version FROM scaffold_versions
    WHERE actor_id = ${actor.actorId} AND status = 'current'
    ORDER BY version DESC LIMIT 1`;

  return rows[0]?.version ?? null;
}

export async function readVersionedScaffoldSource(rt: AgentRuntime, version: number): Promise<string | null> {
  const versioned = `${rt.identity.scaffold.path}.v${version}`;
  const scaffoldVfs = rt.agentStateVfs ?? rt.storage.vfs;

  if (!await exists(scaffoldVfs, versioned)) return null;

  return v.parse(v.string(), await readText(scaffoldVfs, versioned));
}

/** Prefers the canonical `agent.js.v{N}` file; the live file holds the current version, not a pending one. */
export async function readScaffoldVersion(rt: AgentRuntime, version: number): Promise<string | null> {
  const versioned = await readVersionedScaffoldSource(rt, version);

  if (versioned !== null) return versioned;

  // No version file (v0): the live file holds only the status='current' version, so a missing pending file is not it.
  if (version !== getCurrentScaffoldVersion(rt.storage.sql, rt.actor)) return null;

  return await rt.identity.scaffold.read();
}

/**
 * Apply a promotion decision. 'promote' moves the pointer atomically and then
 * refreshes the view; 'rollback' marks the pending rolled_back. A promote becomes
 * a rollback (with `vetoReason`) when the on-disk pending fails misevolution
 * criteria. Callers must report `action`, not their request.
 */
export function applyPromotionDecision(
  rt: AgentRuntime,
  pending: PendingScaffold,
  decision: 'promote' | 'rollback',
  events: ScaffoldDecisionEvents,
): Promise<{ newCurrentVersion: number; action: 'promote' | 'rollback'; vetoReason?: string }> {
  return settle(Effect.gen(function* () {
    rt.actor.assertCurrent();

    if (events.actorId !== rt.actor.actorId) return yield* new KinuError('denied', 'a scaffold decision requires its actor event recorder');
    const sql = rt.storage.sql;

    if (decision === 'promote') {
      // Re-check misevolution against the version file bytes that will actually run.
      const pendingCode = yield* Effect.promise(() => readScaffoldVersion(rt, pending.version));

      if (pendingCode == null) {
        return yield* Effect.die(new Error(`promote failed: no scaffold code found for v${pending.version}`));
      }

      const misevolution = checkMisevolution(pendingCode);

      if (!misevolution.ok) {
        recordMisevolutionVeto(sql, rt.actor, {
          surface: 'scaffold', violation: misevolution,
          detail: `promotion of v${pending.version} vetoed; rolled back instead`,
        });
        const result = yield* Effect.promise(() => applyPromotionDecision(rt, pending, 'rollback', events));

        return { ...result, vetoReason: `Misevolution veto (${misevolution.criterionId}): ${misevolution.reason}` };
      }

      // One actor-scoped statement retires the old current and promotes the pending, so no crash leaves zero or two current rows.
      void sql`UPDATE scaffold_versions
          SET status = CASE WHEN version = ${pending.version} THEN 'current' ELSE 'historical' END
          WHERE actor_id = ${rt.actor.actorId}
            AND (version = ${pending.version}
                 OR (status = 'current' AND version != ${pending.version}))`;
      markStoreChanged(sql);
      yield* Effect.promise(() => rt.identity.scaffold.write(pendingCode));
      yield* recordScaffoldDecision(events, { type: 'scaffold_promotion', fromVersion: pending.version - 1, toVersion: pending.version });

      return { newCurrentVersion: pending.version, action: 'promote' };
    }

    void sql`UPDATE scaffold_versions SET status = 'rolled_back'
        WHERE actor_id = ${rt.actor.actorId} AND version = ${pending.version}`;
    markStoreChanged(sql);
    const currentVersion = getCurrentScaffoldVersion(sql, rt.actor) ?? (pending.version - 1);
    const currentCode = yield* Effect.promise(() => readScaffoldVersion(rt, currentVersion));

    if (currentCode != null) {
      yield* Effect.promise(() => rt.identity.scaffold.write(currentCode));
    }

    yield* recordScaffoldDecision(events, { type: 'scaffold_rollback', fromVersion: pending.version, toVersion: currentVersion });

    return { newCurrentVersion: currentVersion, action: 'rollback' };
  }));
}

/**
 * Record the decision on the run-event log (the status flip leaves `written_at`
 * untouched), beside the pointer write so every path records it. Filed under the
 * reserved workspace run.
 */
function recordScaffoldDecision(
  events: ScaffoldDecisionEvents,
  event: { type: 'scaffold_promotion' | 'scaffold_rollback'; fromVersion: number; toVersion: number },
): Effect.Effect<void> {
  return Effect.try({
    try: () => events.emit(WORKSPACE_RUN_ID, event),
    catch: (cause) => toKinuError({ doing: 'recording a scaffold promotion/rollback run event', cause, otherwise: 'io' }),
  }).pipe(Effect.catch((failure) => Effect.sync(() => {
    diagnostics.failure('event.scaffold_decision_emit_failed', failure, { action: event.type });
  })));
}
