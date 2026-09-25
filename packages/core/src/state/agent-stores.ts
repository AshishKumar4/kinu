// One store set for both backends. Lazy: a DO must not touch storage during field init.
// The compaction store lives in `@kinu.run/compaction`, which depends on this package.

import type { SqlExecutor } from '../types/primitives';
import type { AgentConfigStore } from '../config/store';
import type { ActorHandle } from '../identity/actor-handle';
import { createFactsStore, type FactsStore } from '../memory/facts';
import { TaskListStore } from '../tools/task-store';
import { HeadJournal } from '../heads/journal';
import { RunEventRecorder } from '../events/recorder';
import { BackgroundJobStore } from '../jobs/store';
import { MctsSearchStore } from '../mcts/search-store';
import { ActorClaimStore } from '../orchestrator/actor-claims';
import { PlanReviewStore } from '../plans/review';
import { WORKSPACE_RUN_ID } from '../events/model-call';
import { createAppDataStore, type AppDataStore } from '../tools/db-codemode';
import { SessionHistory } from '../session/history';
import type { SessionFilePlane } from '../session/payload';

export interface AgentStores {
  readonly config: AgentConfigStore;
  readonly history: SessionHistory;
  readonly facts: FactsStore;
  readonly taskList: TaskListStore;
  /** Also the live fork roster the dynamic context reads. */
  readonly headJournal: HeadJournal;
  readonly eventRecorder: RunEventRecorder;
  /** Durable admission ledger. */
  readonly claims: ActorClaimStore;
  readonly jobs: BackgroundJobStore;
  /** Actor-scoped: a plan is approved for the actor that wrote it. */
  readonly planReviews: PlanReviewStore;
  readonly mctsSearchStore: MctsSearchStore;
  /** Tables the agent declares through `db.*`. */
  readonly appData: AppDataStore;
}

export function createAgentStores(sql: () => SqlExecutor, actor: () => ActorHandle, transactionSync: <T>(write: () => T) => T, files: () => Promise<SessionFilePlane>): AgentStores {
  let facts: FactsStore | undefined;
  let taskList: TaskListStore | undefined;
  let headJournal: HeadJournal | undefined;
  let eventRecorder: RunEventRecorder | undefined;
  let jobs: BackgroundJobStore | undefined;
  let claims: ActorClaimStore | undefined;
  let planReviews: PlanReviewStore | undefined;
  let mctsSearchStore: MctsSearchStore | undefined;
  let appData: AppDataStore | undefined;
  let history: SessionHistory | undefined;

  // Members reach siblings through `bundle` to keep one memo per store; a second recorder
  // would be a second `nextIndex` cache and duplicate event indexes.
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
      return (claims ??= new ActorClaimStore(sql(), actor(), transactionSync, bundle.history));
    },
    get history(): SessionHistory {
      return history ??= new SessionHistory({ sql: sql(), actor: actor(), transactionSync, files });
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
        // The admitted claim names the run; between turns calls file under `WORKSPACE_RUN_ID`.
        runId: () => bundle.claims.unsettled(1)[0]?.runId ?? WORKSPACE_RUN_ID,
      }));
    },
  };

  return bundle;
}
