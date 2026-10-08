import { describe, expect, test } from 'bun:test';
import { createTestRuntime, toolExecute } from '@kinu.run/test-utils';
import {
  buildBuiltinTools, createFactsStore, createMemoryCodemodeProvider, initAllTables,
  initFactsTable,
  type VectorStore,
} from '../src/index';
import * as v from 'valibot';

const SearchSchema = v.object({ semantic: v.boolean(), hits: v.array(v.object({ ref: v.string(), text: v.string(), score: v.number() })) });

/** A memory search's hits, as `ref: text` lines, and whether it was semantic. */
async function searched(pending: Promise<unknown>): Promise<{ semantic: boolean; hits: string[] }> {
  const { semantic, hits } = v.parse(SearchSchema, await pending);

  return { semantic, hits: hits.map((hit) => `${hit.ref}: ${hit.text}`) };
}

type MemoryCall = JsonObject;

import { conversationsFor, storesFor } from './helpers';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { JsonObject } from '../src/utils/json';

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
      const native = toolExecute<MemoryCall, unknown>(buildBuiltinTools({ rt, vectorStore, conversations: conversationsFor(rt, history) }).memory);

      const provider = createMemoryCodemodeProvider(() => ({
        memory: rt.memory, actor: rt.actor, vectorStore,
        conversations: conversationsFor(rt, history),
      }));

      const search = provider.tools.search;

      if (!search) throw new Error('memory.search is missing');

      for (const query of ['needle', 'absent']) {
        const result = await searched(native({ op: 'search', query }));

        expect(result).toEqual({ semantic: vectorStore?.available === true, hits: query === 'needle' ? ['memory.md:1-1: needle'] : [] });
        expect(await searched(search.execute(query))).toEqual(result);
      }
    });

    test(`${backend}: a remembered fact is found by its key`, async () => {
      const { rt, testSql } = createTestRuntime();
      initAllTables(testSql.execRaw, testSql.sql);
      initFactsTable(testSql.execRaw);
      rt.memory.search = async () => [];
      const facts = createFactsStore(testSql.sql, rt.actor);
      const { history } = storesFor(rt);

      const native = toolExecute<MemoryCall, unknown>(
        buildBuiltinTools({ rt, vectorStore, facts, conversations: conversationsFor(rt, history) }).memory);

      // remember landed but search never saw it: the failure this guards.
      await native({ op: 'remember', key: 'every-tool probe', value: 'ok' });

      const result = await searched(native({ op: 'search', query: 'every-tool probe' }));

      expect(result.hits).toEqual([expect.stringMatching(/^fact: every-tool_probe: .*ok/u)]);

      const provider = createMemoryCodemodeProvider(() => ({
        memory: rt.memory, actor: rt.actor, vectorStore, facts,
        conversations: conversationsFor(rt, history),
      }));

      const search = provider.tools.search;

      if (!search) throw new Error('memory.search is missing');

      expect(await searched(search.execute('every-tool probe'))).toEqual(result);
    });

    test(`${backend}: a term that only lives in a fact's value still finds it`, async () => {
      const { rt, testSql } = createTestRuntime();
      initAllTables(testSql.execRaw, testSql.sql);
      initFactsTable(testSql.execRaw);
      const facts = createFactsStore(testSql.sql, rt.actor);

      const native = toolExecute<MemoryCall, unknown>(
        buildBuiltinTools({ rt, vectorStore, facts, conversations: conversationsFor(rt) }).memory);

      await native({ op: 'remember', key: 'deploy.target', value: 'staging' });

      const result = await searched(native({ op: 'search', query: 'staging' }));

      expect(result.hits).toEqual([expect.stringMatching(/^fact: deploy\.target: .*staging/u)]);
    });

    test(`${backend}: notes and remembered facts fuse into one ranked list`, async () => {
      const { rt, testSql } = createTestRuntime();
      initAllTables(testSql.execRaw, testSql.sql);
      initFactsTable(testSql.execRaw);
      rt.memory.search = needleIndex('the needle note');
      const facts = createFactsStore(testSql.sql, rt.actor);

      const native = toolExecute<MemoryCall, unknown>(
        buildBuiltinTools({ rt, vectorStore, facts, conversations: conversationsFor(rt) }).memory);

      await native({ op: 'remember', key: 'needle policy', value: 'keep it sharp' });

      const result = await searched(native({ op: 'search', query: 'needle' }));

      expect(result.hits).toEqual(expect.arrayContaining(['memory.md:1-1: the needle note', expect.stringMatching(/^fact: needle_policy: .*keep it sharp/u)]));
    });

    test(`${backend}: a wired-but-unmatched facts store changes nothing`, async () => {
      const { rt, testSql } = createTestRuntime();
      initAllTables(testSql.execRaw, testSql.sql);
      initFactsTable(testSql.execRaw);
      rt.memory.search = needleIndex('needle');
      const facts = createFactsStore(testSql.sql, rt.actor);

      const native = toolExecute<MemoryCall, unknown>(
        buildBuiltinTools({ rt, vectorStore, facts, conversations: conversationsFor(rt) }).memory);

      await native({ op: 'remember', key: 'deploy.target', value: 'staging' });

      for (const query of ['needle', 'absent']) {
        expect((await searched(native({ op: 'search', query }))).hits).toEqual(query === 'needle' ? ['memory.md:1-1: needle'] : []);
      }
    });
  }
});
