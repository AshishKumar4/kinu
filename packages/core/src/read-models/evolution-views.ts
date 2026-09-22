/** Self-evolution surfaces: changelog, near-tied takes, curriculum proposals, each with its one action. */

import type { AgentConfigStore } from '../config/store';
import type { ActorHandle } from '../identity/actor-handle';
import {
  buildChangelog, countUnseenChangelog, listUnseenChangelog, type ChangelogEntry,
} from '../evolution/changelog';
import { boundedInt } from '../utils/bounds';
import type { EvolutionEngine } from '../evolution/engine';
import { proposeNextTasks, type ProposedTask } from '../curriculum/proposer';
import {
  buildTakeContinuationPrompt, recordTakePick, type TakePickOutcome,
} from '../mcts/takes';
import { CHAT_SESSION_ID } from '../session/transcript-schema';
import type { SessionHistory } from '../session/history';
import { getCurrentScaffoldVersion } from '../scaffold/shadow';
import type { AgentInbox } from '../types/signals';
import type { AgentRuntime } from '../types/agent-runtime';
import type { SqlExecutor } from '../types/primitives';
import { diagnostics, toKinuError } from '../obs/index';

export interface EvolutionChangelogView {
  entries: ChangelogEntry[];
  unseenCount: number;
  seenAt: number;
}

const DEFAULT_CHANGELOG_LIMIT = 50;

/** The run list's ceiling: this digest is RPC-reachable. */
const MAX_CHANGELOG_LIMIT = 200;

/** Assembled on demand from the durable ledgers; no second event system. */
export function getEvolutionChangelog(
  sql: SqlExecutor,
  actor: ActorHandle,
  limit = DEFAULT_CHANGELOG_LIMIT,
  changesOnly = false,
): EvolutionChangelogView {
  // The seen marker lives on this actor's own config, so the handle alone pairs marker and ledgers.
  const seenAt = actor.config.getChangelogSeenAt();
  const page = boundedInt(limit, DEFAULT_CHANGELOG_LIMIT, 1, MAX_CHANGELOG_LIMIT);

  return {
    entries: buildChangelog(sql, actor, { limit: page, changesOnly }),
    unseenCount: countUnseenChangelog(sql, actor, seenAt),
    seenAt,
  };
}

/** The needs-you queue row is built from this, so queue and journal filter the same entries by one marker. */
export function getUnseenChangelog(sql: SqlExecutor, actor: ActorHandle): ChangelogEntry[] {
  return listUnseenChangelog(sql, actor, actor.config.getChangelogSeenAt());
}

/** Zeroes the unseen badge. */
export function markChangelogSeen(config: AgentConfigStore) {
  const seenAt = Date.now();
  config.setChangelogSeenAt(seenAt);

  return { ok: true, seenAt };
}

export interface TakePickDeps {
  readonly sql: SqlExecutor;
  readonly actor: ActorHandle;
  /** Where the ledger row's request and response text is read from. */
  readonly history: SessionHistory;
  readonly engine: EvolutionEngine;
  readonly inbox: AgentInbox;
}

/** A `turn_outcomes` row (source 'take_pick') plus convergence repoint. A differing pick queues a
 * continuation; riding the live turn's next step counts as delivered. */
export async function pickAlternateTake(
  deps: TakePickDeps,
  takeId: string,
  nodeId: string,
): Promise<TakePickOutcome> {
  if (!takeId || !nodeId) {
    throw new Error('pickAlternateTake requires takeId and nodeId');
  }

  const record = await recordTakePick(deps.sql, deps.actor, deps.history.transcript(CHAT_SESSION_ID), {
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
    const outcome = await deps.inbox.send({
      kind: 'take_pick',
      text: buildTakeContinuationPrompt(record.set, record.chosen),
    });

    continuationQueued = outcome !== 'undelivered';
  }

  return { ...record, continuationQueued };
}

/** Runs on the cross-family judge where wired: the chat model grading its own tasks is self-enhancement bias. */
export function proposeCurriculumTasks(rt: AgentRuntime, count?: number): Promise<ProposedTask[]> {
  return proposeNextTasks({ rt, judge: rt.judgeModel ?? rt.llm, count });
}
