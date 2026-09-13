import { describe, expect, test } from 'bun:test';
import { createTestRuntime, toolExecute } from '@kinu.run/test-utils';
import {
  buildBuiltinTools, createMemoryCodemodeProvider, initAllTables,
  type MemoryToolInput, type VectorStore,
} from '../src/index';

const unavailableIndex: VectorStore = {
  available: false,
  upsertChunk: async () => { throw new Error('unavailable index must not be used'); },
  upsertChunks: async () => { throw new Error('unavailable index must not be used'); },
  deleteChunks: async () => { throw new Error('unavailable index must not be used'); },
  search: async () => { throw new Error('unavailable index must not be used'); },
};

describe('memory search coverage across backend capabilities', () => {
  for (const [backend, vectorStore] of [['cli', null], ['cf unavailable', unavailableIndex]] as const) {
    test(`${backend}: native and codemode report lexical-only hits and misses`, async () => {
      const { rt, testSql } = createTestRuntime();
      initAllTables(testSql.execRaw, testSql.sql);
      rt.memory.search = async (query) => query === 'needle'
        ? [{ path: 'memory.md', startLine: 1, endLine: 1, score: 1, snippet: 'needle' }]
        : [];
      const native = toolExecute<MemoryToolInput, string>(buildBuiltinTools({ rt, vectorStore }).memory);

      const provider = createMemoryCodemodeProvider(() => ({
        memory: rt.memory, sql: rt.storage.sql, actor: rt.actor, vectorStore,
      }));

      const search = provider.tools.search;

      if (!search) throw new Error('memory.search is missing');

      for (const query of ['needle', 'absent']) {
        const result = await native({ action: 'search', query });

        expect(result).toContain('Lexical search only; semantic recall is unavailable.');
        expect(result).toContain(query === 'needle' ? '[memory.md:1-1] (score 1.00)\nneedle' : 'No results found.');
        expect(await search.execute(query)).toBe(result);
      }
    });
  }
});
