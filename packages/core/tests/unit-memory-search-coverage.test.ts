import { describe, expect, test } from 'bun:test';
import { createTestRuntime, toolExecute } from '@kinu.run/test-utils';
import {
  buildBuiltinTools, createFactsStore, createMemoryCodemodeProvider, initAllTables,
  initFactsTable,
  type MemoryToolInput, type VectorStore,
} from '../src/index';
import { storesFor } from './helpers';
import type { AgentRuntime } from '../src/types/agent-runtime';

const unavailableIndex: VectorStore = {
  available: false,
  upsertChunk: async () => { throw new Error('unavailable index must not be used'); },
  upsertChunks: async () => { throw new Error('unavailable index must not be used'); },
  deleteChunks: async () => { throw new Error('unavailable index must not be used'); },
  search: async () => { throw new Error('unavailable index must not be used'); },
};

const emptyIndex: VectorStore = {
  available: true,
  upsertChunk: async () => {},
  upsertChunks: async () => {},
  deleteChunks: async () => {},
  search: async () => [],
};

/** The semantic-index postures the tool ships under: none (CLI), noop, wired-but-down, and live-empty (forces RRF). */
const BACKENDS: ReadonlyArray<readonly [string, VectorStore | null]> = [
  ['cli', null],
  ['cf unavailable', unavailableIndex],
  ['cf live empty', emptyIndex],
];

/** A note index where the query `needle` answers one chunk carrying `snippet`; other queries answer nothing. */
function needleIndex(snippet: string): AgentRuntime['memory']['search'] {
  return async (query) => query === 'needle'
    ? [{ path: 'memory.md', startLine: 1, endLine: 1, score: 1, snippet }]
    : [];
}

describe('memory search coverage across backend capabilities', () => {
  for (const [backend, vectorStore] of BACKENDS) {
    test(`${backend}: native and codemode report hits and misses`, async () => {
      const { rt, testSql } = createTestRuntime();
      initAllTables(testSql.execRaw, testSql.sql);
      rt.memory.search = needleIndex('needle');
      const { history } = storesFor(rt);
      const native = toolExecute<MemoryToolInput, string>(buildBuiltinTools({ rt, vectorStore, history }).memory);

      const provider = createMemoryCodemodeProvider(() => ({
        memory: rt.memory, sql: rt.storage.sql, actor: rt.actor, vectorStore,
        transcriptFor: (sessionId) => history.transcript(sessionId),
      }));

      const search = provider.tools.search;

      if (!search) throw new Error('memory.search is missing');

      for (const query of ['needle', 'absent']) {
        const result = await native({ action: 'search', query });
        const hit = query === 'needle' ? '[memory.md:1-1]' : 'No results found.';

        if (vectorStore?.available) {
          expect(result).toContain(hit);
          expect(result).not.toContain('Lexical search only');
        } else {
          expect(result).toContain('Lexical search only; semantic recall is unavailable.');
          expect(result).toContain(
            query === 'needle' ? '[memory.md:1-1] (score 1.00)\nneedle' : 'No results found.');
        }

        expect(await search.execute(query)).toBe(result);
      }
    });

    test(`${backend}: a remembered fact is found by its key`, async () => {
      const { rt, testSql } = createTestRuntime();
      initAllTables(testSql.execRaw, testSql.sql);
      initFactsTable(testSql.execRaw);
      rt.memory.search = async () => [];
      const facts = createFactsStore(testSql.sql, rt.actor);
      const { history } = storesFor(rt);

      const native = toolExecute<MemoryToolInput, string>(
        buildBuiltinTools({ rt, vectorStore, facts, history }).memory);

      // remember landed but search never saw it: the failure this guards.
      await native({ action: 'remember', key: 'every-tool probe', value: 'ok' });

      const result = await native({ action: 'search', query: 'every-tool probe' });

      expect(result).toContain('[fact: every-tool_probe]');
      expect(result).toContain('ok');
      expect(result).not.toContain('No results found.');

      const provider = createMemoryCodemodeProvider(() => ({
        memory: rt.memory, sql: rt.storage.sql, actor: rt.actor, vectorStore, facts,
        transcriptFor: (sessionId) => history.transcript(sessionId),
      }));

      const search = provider.tools.search;

      if (!search) throw new Error('memory.search is missing');

      expect(await search.execute('every-tool probe')).toBe(result);
    });

    test(`${backend}: a term that only lives in a fact's value still finds it`, async () => {
      const { rt, testSql } = createTestRuntime();
      initAllTables(testSql.execRaw, testSql.sql);
      initFactsTable(testSql.execRaw);
      const facts = createFactsStore(testSql.sql, rt.actor);

      const native = toolExecute<MemoryToolInput, string>(
        buildBuiltinTools({ rt, vectorStore, facts, history: storesFor(rt).history }).memory);

      await native({ action: 'remember', key: 'deploy.target', value: 'staging' });

      const result = await native({ action: 'search', query: 'staging' });

      expect(result).toContain('[fact: deploy.target]');
      expect(result).toContain('staging');
    });

    test(`${backend}: notes and remembered facts fuse into one ranked list`, async () => {
      const { rt, testSql } = createTestRuntime();
      initAllTables(testSql.execRaw, testSql.sql);
      initFactsTable(testSql.execRaw);
      rt.memory.search = needleIndex('the needle note');
      const facts = createFactsStore(testSql.sql, rt.actor);

      const native = toolExecute<MemoryToolInput, string>(
        buildBuiltinTools({ rt, vectorStore, facts, history: storesFor(rt).history }).memory);

      await native({ action: 'remember', key: 'needle policy', value: 'keep it sharp' });

      const result = await native({ action: 'search', query: 'needle' });

      expect(result).toContain('[memory.md:1-1]');
      expect(result).toContain('the needle note');
      expect(result).toContain('[fact: needle_policy]');
      expect(result).toContain('keep it sharp');
    });

    test(`${backend}: a wired-but-unmatched facts store changes nothing`, async () => {
      const { rt, testSql } = createTestRuntime();
      initAllTables(testSql.execRaw, testSql.sql);
      initFactsTable(testSql.execRaw);
      rt.memory.search = needleIndex('needle');
      const facts = createFactsStore(testSql.sql, rt.actor);

      const native = toolExecute<MemoryToolInput, string>(
        buildBuiltinTools({ rt, vectorStore, facts, history: storesFor(rt).history }).memory);

      await native({ action: 'remember', key: 'deploy.target', value: 'staging' });

      for (const query of ['needle', 'absent']) {
        const result = await native({ action: 'search', query });

        if (query === 'needle') {
          expect(result).toContain('[memory.md:1-1]');
          expect(result).not.toContain('fact:');
        } else {
          expect(result).toContain('No results found.');
        }
      }
    });
  }

  test('no FactsStore: the lexical-only render is byte-identical to before', async () => {
    // No facts wired: search answers from the note index alone, same header and row shape.
    const { rt, testSql } = createTestRuntime();
    initAllTables(testSql.execRaw, testSql.sql);
    rt.memory.search = needleIndex('needle');
    const native = toolExecute<MemoryToolInput, string>(buildBuiltinTools({ rt, vectorStore: null, history: storesFor(rt).history }).memory);

    expect(await native({ action: 'search', query: 'needle' })).toBe(
      'Lexical search only; semantic recall is unavailable.\n[memory.md:1-1] (score 1.00)\nneedle');
    expect(await native({ action: 'search', query: 'absent' })).toBe(
      'Lexical search only; semantic recall is unavailable.\nNo results found.');
  });
});
