import { createFactsStore, initFactsTable, type ActorHandle, type FactsStore } from '@kinu.run/core';
import { createTestSql, type TestSql } from './sql';
import { createTestActors, type TestActors } from './actors';

export interface TestFacts {
  facts: FactsStore;
  testSql: TestSql;
  /** `agent_facts` is actor-private, so the store needs a real actor. */
  actors: TestActors;
  actor: ActorHandle;
}

export function createTestFactsStore(): TestFacts {
  const testSql = createTestSql();
  const actors = createTestActors(testSql.sql, testSql.execRaw);
  initFactsTable(testSql.execRaw);

  return { facts: createFactsStore(testSql.sql, actors.main), testSql, actors, actor: actors.main };
}
