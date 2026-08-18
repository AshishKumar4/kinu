/**
 * Unit tests for hybridSearch — FTS5 + Vectorize merge via RRF.
 */

import { describe, test, expect } from 'bun:test';
import {
  hybridSearch,
  memorySnippetRehydrator,
  createNoopVectorStore,
  type LexicalHit,
  type LexicalSearchFn,
  type VectorStore,
  type VectorSearchHit,
} from '../src/index';

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
    expect(out[0].lexicalScore).toBeDefined();
    expect(out[0].semanticScore).toBeDefined();
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
    const shared = out.find((h) => h.id === 'shared')!;
    expect(shared.snippet).toBe('shared snippet');
  });

  test('a semantic-only hit carries its text, rehydrated from the chunk it points at', async () => {
    // What semantic search exists for: the lexical index missed it entirely, so
    // there is no snippet to borrow — and a blank one is useless to the reader.
    const lines = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n');
    const reads: string[] = [];
    const memory = {
      read: async (path: string) => { reads.push(path); return path === 'x.md' ? lines : null; },
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
    expect(out.find((h) => h.id === 'shared')!.snippet).toBe('shared snippet');
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
});
