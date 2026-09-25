/**
 * The publication-egress gate, driven over fixture modules: what it counts as the settle path's
 * egress, and what it refuses in a classification.
 */
import { describe, expect, test } from 'bun:test';

import { auditEgress, egressNames, egressOf, type EgressVerdict } from './publication-egress';

const egressIn = (text: string): string[] => egressNames(egressOf('fixture.ts', text));

describe('what counts as egress', () => {
  test('a value import is egress; a type import, whole or per name, is not', () => {
    expect(egressIn(`
      import { publish, type Draft } from './publish';
      import type { Row } from './rows';
      export function converge(): void { publish(); }
    `)).toEqual(['publish']);
  });

  test('a local helper that writes is named, and so is each table its SQL writes', () => {
    expect(egressIn(`
      async function settle(rt: Rt): Promise<void> {
        void rt.storage.sql\`INSERT OR REPLACE INTO results (id) VALUES (\${1})\`;
        void rt.storage.sql\`DELETE FROM drafts WHERE id = \${2}; UPDATE tallies SET n = n + 1\`;
      }
    `)).toEqual(['DELETE FROM drafts', 'INSERT OR REPLACE INTO results', 'UPDATE tallies', 'settle']);
  });

  test('a memory write through any receiver is egress; the settle entry itself is not named', () => {
    expect(egressIn(`
      export async function converge(rt: Rt, memory: Memory): Promise<void> {
        await rt.memory.append('memory/MEMORY.md', 'a result');
        await memory.index('memory/MEMORY.md');
      }
    `)).toEqual(['memory.append', 'memory.index']);
  });

  test('SQL in a comment or an untagged string, and a read, are not writes', () => {
    expect(egressIn(`
      // UPDATE search_nodes SET status = 'pruned'
      export function describe(rt: Rt): string {
        void rt.storage.sql\`SELECT * FROM search_nodes\`;
        void rt.memory.read('memory/MEMORY.md');

        return 'INSERT INTO task_history is what the ledger does';
      }
    `)).toEqual([]);
  });

  test('an arrow helper bound at the top level is named like a function', () => {
    expect(egressIn(`
      export const retire = (sql: Sql): void => { void sql\`UPDATE search_nodes SET status = 'failed'\`; };
    `)).toEqual(['UPDATE search_nodes', 'retire']);
  });
});

describe('what the classification must hold', () => {
  const declared = {
    publish: 'records',
    'UPDATE search_nodes': 'disclosure: run-keyed tree status, the re-evaluation input',
  } satisfies Record<string, EgressVerdict>;

  test('the classification and the module agree in both directions', () => {
    expect(auditEgress(['UPDATE search_nodes', 'publish'], declared)).toEqual([]);
  });

  test('a new egress is unclassified, and a classified one that is gone is stale', () => {
    expect(auditEgress(['UPDATE search_nodes', 'publish', 'INSERT INTO results'], declared))
      .toEqual([{ egress: 'INSERT INTO results', kind: 'unclassified' }]);
    expect(auditEgress(['publish'], declared)).toEqual([{ egress: 'UPDATE search_nodes', kind: 'stale' }]);
  });

  test('a disclosure gives a reason a reviewer could check', () => {
    expect(auditEgress(['publish', 'retire'], { publish: 'records', retire: 'disclosure: status' }))
      .toEqual([{ egress: 'retire', kind: 'unreasoned disclosure' }]);
  });
});
