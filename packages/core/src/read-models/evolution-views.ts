/**
 * The self-evolution surfaces: what the agent changed about itself, the
 * near-tied answers it kept, and the tasks it proposes for itself next.
 *
 * Each is a read plus the one action the surface offers beside it (mark seen,
 * pick a take, propose). The reads fold ledgers core already owns; the actions
 * are policy — which is why they had drifted: the take pick reported a
 * continuation as queued on one backend without checking that it was, and the
 * curriculum proposer let the CHAT model grade its own next tasks on one
 * backend and used the cross-family judge on the other.
 */

import type { AgentConfigStore } from '../config/store';
import type { ActorHandle } from '../state/actor-handle';
import {
  buildChangelog, countUnseenChangelog, listUnseenChangelog, type ChangelogEntry,
} from '../evolution/changelog';
import { boundedInt } from '../utils/bounds';
import type { EvolutionEngine } from '../evolution/engine';
import { proposeNextTasks, type ProposedTask } from '../curriculum/proposer';
import {
  buildTakeContinuationPrompt, recordTakePick, type TakePickOutcome,
} from '../mcts/takes';
import { getCurrentScaffoldVersion } from '../scaffold/shadow';
import type { SignalDeliverer } from '../types/signals';
import type { AgentRuntime } from '../types/agent-runtime';
import type { SqlExecutor } from '../types/primitives';
import { diagnostics, toKinuError } from '../obs/index';

export interface EvolutionChangelogView {
  entries: ChangelogEntry[];
  unseenCount: number;
  seenAt: number;
}

/** Entries in one changelog digest. Fifty is what the bare read already took. */
const DEFAULT_CHANGELOG_LIMIT = 50;

/**
 * The ceiling on one changelog digest. The run list's own ceiling: this digest
 * is RPC-reachable, and a negative limit reaches its slices unclosed.
 */
const MAX_CHANGELOG_LIMIT = 200;

/** The "what I changed about myself" digest, assembled on demand from the
 *  durable ledgers — no second event system. */
export function getEvolutionChangelog(
  sql: SqlExecutor,
  actor: ActorHandle,
  limit = DEFAULT_CHANGELOG_LIMIT,
): EvolutionChangelogView {
  // The seen marker is a key on this actor's own config store, so the handle is
  // the only thing either read needs. Taking a separate `AgentConfigStore`
  // beside the scoped `sql` let a caller pair one actor's marker with another
  // actor's ledgers, and nothing in the types could catch it.
  const seenAt = actor.config.getChangelogSeenAt();
  const page = boundedInt(limit, DEFAULT_CHANGELOG_LIMIT, 1, MAX_CHANGELOG_LIMIT);
  return {
    entries: buildChangelog(sql, actor, { limit: page }),
    unseenCount: countUnseenChangelog(sql, actor, seenAt),
    seenAt,
  };
}

/** The unseen window itself — the same digest the surface renders, cut to what
 *  the owner has not read yet. The needs-you queue's one row is built from it,
 *  so the queue and the journal below it can never disagree about what exists:
 *  they are the same entries, filtered by the same marker. */
export function getUnseenChangelog(sql: SqlExecutor, actor: ActorHandle): ChangelogEntry[] {
  return listUnseenChangelog(sql, actor, actor.config.getChangelogSeenAt());
}

/** The operator viewed the changelog — zero the unseen badge. */
export function markChangelogSeen(config: AgentConfigStore) {
  const seenAt = Date.now();
  config.setChangelogSeenAt(seenAt);
  return { ok: true, seenAt };
}

export interface TakePickDeps {
  readonly sql: SqlExecutor;
  /** The actor whose scaffold lineage and take ledger this pick answers for. */
  readonly actor: ActorHandle;
  readonly engine: EvolutionEngine;
  readonly signals: SignalDeliverer;
}

/**
 * Record the user's pick between explored takes — the explicit preference
 * signal (a `turn_outcomes` row with source 'take_pick', plus the convergence
 * repoint). A pick that differs from the answered take queues a gentle
 * programmatic continuation; riding the live turn's next step counts as
 * delivered, an undeliverable signal does not.
 */
export async function pickAlternateTake(
  deps: TakePickDeps,
  takeId: string,
  nodeId: string,
): Promise<TakePickOutcome> {
  if (!takeId || !nodeId) {
    throw new Error('pickAlternateTake requires takeId and nodeId');
  }
  const record = recordTakePick(deps.sql, deps.actor, {
    takeId, nodeId,
    scaffoldVersion: getCurrentScaffoldVersion(deps.sql, deps.actor),
  });
  try {
    await deps.engine.applyTakePick(record.set.turnId, record.outcome);
  } catch (err) {
    diagnostics.failure(
      'evolution.take_pick_corroboration_failed',
      toKinuError({ doing: 'corroborate the lesson behind an alternate take', cause: err, otherwise: 'unavailable' }),
      { takeId, nodeId },
    );
  }
  let continuationQueued = false;
  if (record.changedAnswer) {
    const outcome = await deps.signals.deliver({
      kind: 'take_pick',
      text: buildTakeContinuationPrompt(record.set, record.chosen),
    });
    continuationQueued = outcome !== 'undelivered';
  }
  return { ...record, continuationQueued };
}

/**
 * Propose the agent's next curriculum tasks. The proposer grades its own
 * candidates for learnability, so it runs on the cross-family judge where one
 * is wired — the chat model scoring the tasks it will then be given is the
 * self-enhancement bias every other scorer here routes around.
 */
export function proposeCurriculumTasks(rt: AgentRuntime, count?: number): Promise<ProposedTask[]> {
  return proposeNextTasks({ rt, judge: rt.judgeModel ?? rt.llm, count });
}
