/**
 * Unit tests for hybridSearch — FTS5 + Vectorize merge via RRF.
 */

import { describe, test, expect } from 'bun:test';
import {
  hybridSearch,
  createNoopVectorStore,
  type LexicalHit,
  type VectorStore,
  type VectorSearchHit,
} from '../src/index.js';

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
    expect(out[0].sources.sort()).toEqual(['lexical', 'semantic']);
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
    const failing = async () => { throw new Error('FTS down'); };
    const out = await hybridSearch('q', failing as never, vectorStore(semanticCorpus));
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
});
