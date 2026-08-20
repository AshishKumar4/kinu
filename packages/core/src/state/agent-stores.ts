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
 * `@kinu/compaction`, which depends on this package, so importing it would
 * invert the layering. Both backends keep constructing that one themselves.
 */

import type { SqlExecutor } from '../types/primitives';
import { createAgentConfigStore, type AgentConfigStore } from '../config/store';
import { createFactsStore, type FactsStore } from '../memory/facts';
import { TaskListStore } from '../tasks/store';
import { HeadJournal } from '../heads/journal';
import { RunEventRecorder } from '../events/recorder';
import { BackgroundJobStore } from '../jobs/store';
import { MctsSearchStore } from '../mcts/search-store';

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
  readonly jobs: BackgroundJobStore;
  readonly mctsSearchStore: MctsSearchStore;
}

/**
 * Build the agent's store set from a provider for its SQL handle.
 *
 * Takes a provider rather than the handle itself so a backend whose handle is
 * not yet resolvable at construction time can still build the bundle up front;
 * the provider is called at most once per store, on first access.
 */
export function createAgentStores(sql: () => SqlExecutor): AgentStores {
  // One memo per store: the provider is only invoked when a store is first
  // reached, and each store is constructed exactly once thereafter.
  let config: AgentConfigStore | undefined;
  let facts: FactsStore | undefined;
  let taskList: TaskListStore | undefined;
  let headJournal: HeadJournal | undefined;
  let eventRecorder: RunEventRecorder | undefined;
  let jobs: BackgroundJobStore | undefined;
  let mctsSearchStore: MctsSearchStore | undefined;

  return {
    get config(): AgentConfigStore {
      return (config ??= createAgentConfigStore(sql()));
    },
    get facts(): FactsStore {
      return (facts ??= createFactsStore(sql()));
    },
    get taskList(): TaskListStore {
      return (taskList ??= new TaskListStore(sql()));
    },
    get headJournal(): HeadJournal {
      return (headJournal ??= new HeadJournal(sql()));
    },
    get eventRecorder(): RunEventRecorder {
      return (eventRecorder ??= new RunEventRecorder(sql()));
    },
    get jobs(): BackgroundJobStore {
      return (jobs ??= new BackgroundJobStore(sql()));
    },
    get mctsSearchStore(): MctsSearchStore {
      return (mctsSearchStore ??= new MctsSearchStore(sql()));
    },
  };
}
