// FactsStore fixture — uses the in-memory SQL backing.
import { createFactsStore, initFactsTable, type FactsStore } from '@kinu.run/core';
import { createTestSql, type TestSql } from './sql';

export interface TestFacts {
  facts: FactsStore;
  testSql: TestSql;
}

export function createTestFactsStore(): TestFacts {
  const testSql = createTestSql();
  initFactsTable(testSql.execRaw);
  return { facts: createFactsStore(testSql.sql), testSql };
}
