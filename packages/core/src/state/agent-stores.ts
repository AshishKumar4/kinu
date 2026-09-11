/**
 * The SQL-derived stores every agent has, built once from the agent's one SQL
 * handle.
 *
 * Which stores an agent has was a fact stated twice: the CLI constructed all
 * seven eagerly in its constructor, CF lazily in seven separate getters over
 * `boundSql`. Nothing held the two lists together, so a store added on one side
 * simply did not exist for the other agent — the same drift class that
 * `agentDynamicContext` was introduced to close for the per-step context block.
 * Adding a store is now a one-place change that both backends inherit.
 *
 * Lazy and memoized, because the two backends genuinely differ on WHEN the SQL
 * handle may be touched: a Durable Object must not reach storage while field
 * initializers run, so CF resolves `boundSql` behind a memo and the stores must
 * not force it early. Resolving on first access satisfies that without
 * penalising the CLI, whose handle is ready before any store is read.
 *
 * `createCompactionStateStore` is deliberately NOT here: it lives in
 * `@kinu.run/compaction`, which depends on this package, so importing it would
 * invert the layering. Both backends keep constructing that one themselves.
 */

import type { SqlExecutor } from '../types/primitives';
import type { AgentConfigStore } from '../config/store';
import type { ActorHandle } from '../identity/actor-handle';
import { createFactsStore, type FactsStore } from '../memory/facts';
import { TaskListStore } from '../tasks/store';
import { HeadJournal } from '../heads/journal';
import { RunEventRecorder } from '../events/recorder';
import { BackgroundJobStore } from '../jobs/store';
import { MctsSearchStore } from '../mcts/search-store';
import { ActorClaimStore } from '../orchestrator/actor-claims';
import { PlanReviewStore } from '../plans/review';
import { WORKSPACE_RUN_ID } from '../events/model-call';
import { createAppDataStore, type AppDataStore } from '../tools/db-codemode';

/** Field names match what both backends already called these, so a backend
 *  reads its stores through one object without renaming any call site. */
export interface AgentStores {
  readonly config: AgentConfigStore;
  readonly facts: FactsStore;
  readonly taskList: TaskListStore;
  /** The head journal a session's controller writes to — also the live fork
   *  roster the per-step dynamic context reads. */
  readonly headJournal: HeadJournal;
  readonly eventRecorder: RunEventRecorder;
  /** The durable admission ledger: the claim a turn is issued under, and the
   *  context revisions its steps consume. */
  readonly claims: ActorClaimStore;
  readonly jobs: BackgroundJobStore;
  /**
   * This actor's own plan-review stream.
   *
   * Here because a plan is written by an actor working in plan mode and
   * approved for THAT actor to execute, so it is no more transferable between
   * actors than a claim is. The table has been per-workspace and actor-keyed
   * since `initActorStateSchema`; before this store existed the only reader
   * was built over the ROOT's handle, so a hosted actor had no plan plane at
   * all and the announce that told the workspace one had landed lost its
   * producer when the facet class it lived on was deleted.
   */
  readonly planReviews: PlanReviewStore;
  readonly mctsSearchStore: MctsSearchStore;
  /** The agent's own structured data: the tables it declares through `db.*`,
   *  in this workspace's one database, actor-scoped or shared by declaration. */
  readonly appData: AppDataStore;
}

/**
 * Build the agent's store set from a provider for its SQL handle.
 *
 * Takes a provider rather than the handle itself so a backend whose handle is
 * not yet resolvable at construction time can still build the bundle up front;
 * the provider is called at most once per store, on first access.
 */
export function createAgentStores(sql: () => SqlExecutor, actor: () => ActorHandle, transactionSync: <T>(write: () => T) => T): AgentStores {
  // One memo per store: the provider is only invoked when a store is first
  // reached, and each store is constructed exactly once thereafter.
  let facts: FactsStore | undefined;
  let taskList: TaskListStore | undefined;
  let headJournal: HeadJournal | undefined;
  let eventRecorder: RunEventRecorder | undefined;
  let jobs: BackgroundJobStore | undefined;
  let claims: ActorClaimStore | undefined;
  let planReviews: PlanReviewStore | undefined;
  let mctsSearchStore: MctsSearchStore | undefined;
  let appData: AppDataStore | undefined;

  // Named, because two members reach the others: `appData` writes its evidence
  // through this bundle's own recorder and files it under the run of this
  // actor's admitted turn. Reaching them through the bundle keeps ONE memo per
  // store — a second construction would be a second `nextIndex` cache over the
  // same rows, which is how two events come to share an index.
  const bundle: AgentStores = {
    get config(): AgentConfigStore {
      return actor().config;
    },
    get facts(): FactsStore {
      return (facts ??= createFactsStore(sql(), actor()));
    },
    get taskList(): TaskListStore {
      return (taskList ??= new TaskListStore(sql(), actor(), transactionSync));
    },
    get headJournal(): HeadJournal {
      return (headJournal ??= new HeadJournal(sql(), actor()));
    },
    get eventRecorder(): RunEventRecorder {
      return (eventRecorder ??= new RunEventRecorder(sql(), actor()));
    },
    get claims(): ActorClaimStore {
      return (claims ??= new ActorClaimStore(sql(), actor(), transactionSync));
    },
    get jobs(): BackgroundJobStore {
      return (jobs ??= new BackgroundJobStore(sql(), actor()));
    },
    get planReviews(): PlanReviewStore {
      return (planReviews ??= new PlanReviewStore(sql(), actor()));
    },
    get mctsSearchStore(): MctsSearchStore {
      return (mctsSearchStore ??= new MctsSearchStore(sql(), actor()));
    },
    get appData(): AppDataStore {
      return (appData ??= createAppDataStore({
        sql: sql(),
        actor: actor(),
        transactionSync,
        events: () => bundle.eventRecorder,
        // The run a data operation belongs to is the run of the turn it
        // happened under, which the actor's own admitted claim already names —
        // so nothing has to thread a run id through the sandbox. Between turns
        // there is no run, and `WORKSPACE_RUN_ID` is where a call made between
        // runs is filed (events/model-call.ts).
        runId: () => bundle.claims.unsettled(1)[0]?.runId ?? WORKSPACE_RUN_ID,
      }));
    },
  };

  return bundle;
}
