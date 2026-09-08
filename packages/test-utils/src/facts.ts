// FactsStore fixture — uses the in-memory SQL backing, bound to a real actor.
import { createFactsStore, initFactsTable, type ActorHandle, type FactsStore } from '@kinu.run/core';
import { createTestSql, type TestSql } from './sql';
import { createTestActors, type TestActors } from './actors';

export interface TestFacts {
  facts: FactsStore;
  testSql: TestSql;
  /** The actor the store is bound to, and its siblings — `agent_facts` is
   *  actor-private, so a fixture without one could not build the store at all. */
  actors: TestActors;
  actor: ActorHandle;
}

export function createTestFactsStore(): TestFacts {
  const testSql = createTestSql();
  const actors = createTestActors(testSql.sql, testSql.execRaw);
  initFactsTable(testSql.execRaw);
  return { facts: createFactsStore(testSql.sql, actors.main), testSql, actors, actor: actors.main };
}
