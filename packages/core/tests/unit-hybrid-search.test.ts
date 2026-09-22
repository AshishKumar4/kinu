/**
 * Unit tests for hybridSearch — FTS5 + Vectorize merge via RRF.
 */

import { describe, test, expect } from 'bun:test';
import { createTestFactsStore, present } from '@kinu.run/test-utils';
import {
  hybridSearch,
  memorySnippetRehydrator,
  createNoopVectorStore,
  type LexicalHit,
  type LexicalSearchFn,
  type VectorStore,
  type VectorSearchHit,
} from '../src/index';
import { createRecordingLogger, setDiagnosticsSink } from '../src/obs/index';

const lexicalCorpus: LexicalHit[] = [
  { id: 'l-1', path: 'a.md', startLine: 1, endLine: 5, score: 0.9, snippet: 'exact match line' },
  { id: 'l-2', path: 'b.md', startLine: 1, endLine: 5, score: 0.6, snippet: 'partial match' },
  { id: 'shared', path: 'c.md', startLine: 1, endLine: 5, score: 0.5, snippet: 'shared snippet' },
];

const semanticCorpus: VectorSearchHit[] = [
  { id: 's-1', path: 'x.md', startLine: 1, endLine: 5, score: 0.85 },
  { id: 'shared', path: 'c.md', startLine: 1, endLine: 5, score: 0.7 },
  { id: 's-2', path: 'y.md', startLine: 1, endLine: 5, score: 0.5 },
];

const lexicalFn = async (_q: string, limit: number) => lexicalCorpus.slice(0, limit);

const vectorStore = (semantic: VectorSearchHit[]): VectorStore => ({
  available: true,
  async upsertChunk() {},
  async upsertChunks() {},
  async deleteChunks() {},
  async search(_q, limit = 10) { return semantic.slice(0, limit); },
});

describe('hybridSearch', () => {
  test('merges lexical + semantic; shared item ranks first', async () => {
    const out = await hybridSearch('whatever', lexicalFn, vectorStore(semanticCorpus));
    expect(out[0].id).toBe('shared');
    expect([...out[0].sources].sort()).toEqual(['lexical', 'semantic']);
    // The fused hit keeps both sides' own numbers, read off the corpora above.
    expect(out[0].lexicalScore).toBe(0.5);
    expect(out[0].semanticScore).toBe(0.7);
  });

  test('lexical-only when vector store unavailable', async () => {
    const out = await hybridSearch('q', lexicalFn, createNoopVectorStore());
    expect(out.length).toBe(lexicalCorpus.length);
    expect(out[0].sources).toEqual(['lexical']);
    expect(out[0].semanticScore).toBeUndefined();
  });

  test('respects finalK cap', async () => {
    const out = await hybridSearch('q', lexicalFn, vectorStore(semanticCorpus), { finalK: 2 });
    expect(out.length).toBe(2);
  });

  test('handles lexical failure gracefully', async () => {
    const failing: LexicalSearchFn = async () => { throw new Error('FTS down'); };

    const out = await hybridSearch('q', failing, vectorStore(semanticCorpus));
    // semantic-only
    expect(out.length).toBeGreaterThan(0);

    for (const h of out) {
      expect(h.sources).toEqual(['semantic']);
    }
  });

  test('handles semantic failure gracefully (vectorStore.search throws)', async () => {
    const failingStore: VectorStore = {
      available: true,
      async upsertChunk() {},
      async upsertChunks() {},
      async deleteChunks() {},
      async search() { throw new Error('vectorize down'); },
    };

    const out = await hybridSearch('q', lexicalFn, failingStore);
    expect(out.length).toBeGreaterThan(0);

    for (const h of out) expect(h.sources).toEqual(['lexical']);
  });

  test('enriches with snippet from lexical when available', async () => {
    const out = await hybridSearch('q', lexicalFn, vectorStore(semanticCorpus));
    const shared = present(out.find((h) => h.id === 'shared'), "the 'shared' hit");
    expect(shared.snippet).toBe('shared snippet');
  });

  test('a semantic-only hit carries its text, rehydrated from the chunk it points at', async () => {
    // What semantic search exists for: the lexical index missed it entirely, so
    // there is no snippet to borrow — and a blank one is useless to the reader.
    const lines = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n');
    const reads: string[] = [];

    const memory = {
      read: async (path: string) => {
        reads.push(path);

        return path === 'x.md' ? lines : null;
      },
    };

    const sem: VectorSearchHit[] = [
      { id: 'x.md:3-5', path: 'x.md', startLine: 3, endLine: 5, score: 0.9 },
      { id: 'x.md:7-8', path: 'x.md', startLine: 7, endLine: 8, score: 0.8 },
      { id: 'gone.md:1-2', path: 'gone.md', startLine: 1, endLine: 2, score: 0.7 },
    ];

    const out = await hybridSearch('q', async () => [], vectorStore(sem), {
      rehydrate: memorySnippetRehydrator(memory),
    });

    expect(out.map((h) => h.snippet)).toEqual([
      'line 3\nline 4\nline 5',
      'line 7\nline 8',
      '',                                  // unreadable source → no invented text
    ]);
    expect(out.map((h) => h.sources)).toEqual([['semantic'], ['semantic'], ['semantic']]);
    // One read per file, not per hit.
    expect(reads).toEqual(['x.md', 'gone.md']);
  });

  test('a lexical snippet is never replaced by a rehydrated one', async () => {
    const memory = { read: async () => 'rehydrated text' };

    const out = await hybridSearch('q', lexicalFn, vectorStore(semanticCorpus), {
      rehydrate: memorySnippetRehydrator(memory),
    });

    expect(present(out.find((h) => h.id === 'shared'), "the 'shared' hit").snippet).toBe('shared snippet');
  });

  test('fuses lexical + semantic hits keyed on the canonical chunk id', async () => {
    // The production id both sources emit for a chunk: `path:start-end`.
    const chunkId = 'memory/MEMORY.md:1-5';

    const lex: LexicalHit[] = [
      { id: chunkId, path: 'memory/MEMORY.md', startLine: 1, endLine: 5, score: 0.4, snippet: 'the actual chunk text' },
    ];

    const sem: VectorSearchHit[] = [
      { id: chunkId, path: 'memory/MEMORY.md', startLine: 1, endLine: 5, score: 0.9 },
    ];

    const out = await hybridSearch('q', async () => lex, vectorStore(sem));
    // One fused hit, not two — the matching ids merge.
    expect(out.length).toBe(1);
    expect([...out[0].sources].sort()).toEqual(['lexical', 'semantic']);
    expect(out[0].snippet).toBe('the actual chunk text');
    expect(out[0].lexicalScore).toBe(0.4);
    expect(out[0].semanticScore).toBe(0.9);
  });

  test('a throwing rehydrator degrades that hit to an empty snippet', async () => {
    const log = createRecordingLogger();
    const restore = setDiagnosticsSink(log);

    try {
      const sem: VectorSearchHit[] = [
        { id: 'x.md:1-2', path: 'x.md', startLine: 1, endLine: 2, score: 0.9 },
      ];

      const out = await hybridSearch('q', async () => [], vectorStore(sem), {
        rehydrate: async () => { throw new Error('rehydrate boom'); },
      });

      expect(out.length).toBe(1);
      expect(out[0].snippet).toBe('');
      expect(out[0].sources).toEqual(['semantic']);
      expect(log.emitted.some((line) => line.event === 'memory.snippet_rehydrate_failed')).toBe(true);
    } finally {
      restore();
    }
  });

  test('a rejected memo entry is evicted so the next hit retries the read', async () => {
    let calls = 0;

    const memory = {
      read: async (_path: string): Promise<string | null> => {
        calls++;

        if (calls === 1) throw new Error('transient read');

        return 'line1\nline2';
      },
    };

    const rehydrate = memorySnippetRehydrator(memory);
    const hit: VectorSearchHit = { id: 'x.md:1-1', path: 'x.md', startLine: 1, endLine: 1, score: 1 };
    await expect(rehydrate(hit)).rejects.toThrow('transient read');
    await expect(rehydrate(hit)).resolves.toBe('line1');
    expect(calls).toBe(2);
  });

  test('a remembered fact surfaces as a fact-source hit, labelled by its key', async () => {
    const { facts } = createTestFactsStore();
    facts.upsert('deploy.target', 'staging');

    const out = await hybridSearch('deploy target', lexicalFn, vectorStore(semanticCorpus), { facts });

    const hit = present(out.find((h) => h.id === 'fact:deploy.target'), 'the deploy.target fact hit');

    expect(hit.sources).toEqual(['fact']);
    expect(hit.label).toBe('fact: deploy.target');
    expect(hit.snippet).toBe('staging');
  });

  test('a fact hit never reaches the rehydrator — it carries its own text', async () => {
    const { facts } = createTestFactsStore();
    facts.upsert('user.tz', 'UTC');

    let reads = 0;

    const rehydrate = async () => {
      reads++;

      return 'should not run';
    };

    const out = await hybridSearch('user tz', async () => [], createNoopVectorStore(), { facts, rehydrate });

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('fact:user.tz');
    expect(out[0].snippet).toBe('UTC');
    expect(reads).toBe(0);
  });

  test('the fact arm degrades like the lexical one when the store throws', async () => {
    const log = createRecordingLogger();
    const restore = setDiagnosticsSink(log);

    try {
      const brokenFacts = {
        upsert: () => 'created' as const,
        recall: () => null,
        forget: () => {},
        recentTopK: () => [],
        all: () => { throw new Error('facts table gone'); },
      };

      const out = await hybridSearch('q', lexicalFn, createNoopVectorStore(), { facts: brokenFacts });

      expect(out.length).toBe(lexicalCorpus.length);
      expect(out.every((h) => h.sources.includes('lexical'))).toBe(true);
      expect(log.emitted.some((line) => line.event === 'memory.fact_search_failed')).toBe(true);
    } finally {
      restore();
    }
  });

  test('with no FactsStore wired nothing about the merge changes', async () => {
    const out = await hybridSearch('whatever', lexicalFn, vectorStore(semanticCorpus));
    expect(out[0].id).toBe('shared');
    expect(out.every((h) => !h.sources.includes('fact'))).toBe(true);
    expect(out.every((h) => h.label === undefined)).toBe(true);
  });
});
