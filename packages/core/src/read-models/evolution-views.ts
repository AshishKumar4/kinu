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

import type { AgentConfigStore } from '../config/store.js';
import {
  buildChangelog, countUnseenChangelog, listUnseenChangelog, type ChangelogEntry,
} from '../evolution/changelog.js';
import type { EvolutionEngine } from '../evolution/engine.js';
import { proposeNextTasks, type ProposedTask } from '../curriculum/proposer.js';
import {
  buildTakeContinuationPrompt, recordTakePick, type TakePickOutcome,
} from '../mcts/takes.js';
import { getCurrentScaffoldVersion } from '../scaffold/shadow.js';
import type { SignalDeliverer } from '../types/signals.js';
import type { AgentRuntime } from '../types/agent-runtime.js';
import type { SqlExecutor } from '../types/primitives.js';
import { diagnostics, toProteusError } from '../obs/index.js';

export interface EvolutionChangelogView {
  entries: ChangelogEntry[];
  unseenCount: number;
  seenAt: number;
}

/** The "what I changed about myself" digest, assembled on demand from the
 *  durable ledgers — no second event system. */
export function getEvolutionChangelog(
  config: AgentConfigStore,
  sql: SqlExecutor,
  limit = 50,
): EvolutionChangelogView {
  const seenAt = config.getChangelogSeenAt();
  return {
    entries: buildChangelog(sql, { limit }),
    unseenCount: countUnseenChangelog(sql, seenAt),
    seenAt,
  };
}

/** The unseen window itself — the same digest the surface renders, cut to what
 *  the owner has not read yet. The needs-you queue's one row is built from it,
 *  so the queue and the journal below it can never disagree about what exists:
 *  they are the same entries, filtered by the same marker. */
export function getUnseenChangelog(config: AgentConfigStore, sql: SqlExecutor): ChangelogEntry[] {
  return listUnseenChangelog(sql, config.getChangelogSeenAt());
}

/** The operator viewed the changelog — zero the unseen badge. */
export function markChangelogSeen(config: AgentConfigStore) {
  const seenAt = Date.now();
  config.setChangelogSeenAt(seenAt);
  return { ok: true, seenAt };
}

export interface TakePickDeps {
  readonly sql: SqlExecutor;
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
  const record = recordTakePick(deps.sql, {
    takeId, nodeId,
    scaffoldVersion: getCurrentScaffoldVersion(deps.sql),
  });
  try {
    await deps.engine.applyTakePick(record.set.turnId, record.outcome);
  } catch (err) {
    diagnostics.failure(
      'evolution.take_pick_corroboration_failed',
      toProteusError({ doing: 'corroborate the lesson behind an alternate take', cause: err, otherwise: 'unavailable' }),
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
