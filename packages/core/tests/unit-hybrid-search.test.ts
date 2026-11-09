/** hybridSearch: FTS5 and the note vectors merged via RRF. */

import { describe, test, expect } from 'bun:test';
import { createTestFactsStore, present, createRecordingLogger } from '@kinu.run/test-utils';
import {
  hybridSearch,
  createNoopVectorStore,
  type LexicalHit,
  type LexicalSearchFn,
  type NearestChunk,
  type VectorStore,
} from '../src/index';
import { setDiagnosticsSink } from '../src/obs/index';

const lexicalCorpus: LexicalHit[] = [
  { id: 'l-1', path: 'a.md', startLine: 1, endLine: 5, score: 0.9, snippet: 'exact match line' },
  { id: 'l-2', path: 'b.md', startLine: 1, endLine: 5, score: 0.6, snippet: 'partial match' },
  { id: 'shared', path: 'c.md', startLine: 1, endLine: 5, score: 0.5, snippet: 'shared snippet' },
];

const semanticCorpus: NearestChunk[] = [
  { id: 's-1', path: 'x.md', startLine: 1, endLine: 5, score: 0.85, text: 'x text', hash: 'x' },
  { id: 'shared', path: 'c.md', startLine: 1, endLine: 5, score: 0.7, text: 'c text', hash: 'c' },
  { id: 's-2', path: 'y.md', startLine: 1, endLine: 5, score: 0.5, text: 'y text', hash: 'y' },
];

const lexicalFn = async (_q: string, limit: number) => lexicalCorpus.slice(0, limit);

const vectorStore = (semantic: NearestChunk[]): VectorStore => ({
  available: true,
  async fill() {},
  async search(_q, limit = 10) { return semantic.slice(0, limit); },
});

const failingStore: VectorStore = {
  available: true,
  async fill() {},
  async search() { throw new Error('embedding refused'); },
};

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
    const out = await hybridSearch('q', lexicalFn, failingStore);
    expect(out.length).toBeGreaterThan(0);

    for (const h of out) expect(h.sources).toEqual(['lexical']);
  });

  test('a failed semantic arm does not read as "no matches" when FTS is down too', async () => {
    const failing: LexicalSearchFn = async () => { throw new Error('FTS down'); };

    await expect(hybridSearch('q', failing, failingStore)).rejects.toThrow(AggregateError);
  });

  test('enriches with snippet from lexical when available', async () => {
    const out = await hybridSearch('q', lexicalFn, vectorStore(semanticCorpus));
    const shared = present(out.find((h) => h.id === 'shared'), "the 'shared' hit");
    expect(shared.snippet).toBe('shared snippet');
  });

  test('fuses lexical + semantic hits keyed on the canonical chunk id', async () => {
    // The production id both sources emit for a chunk: `path:start-end`.
    const chunkId = 'memory/MEMORY.md:1-5';

    const lex: LexicalHit[] = [
      { id: chunkId, path: 'memory/MEMORY.md', startLine: 1, endLine: 5, score: 0.4, snippet: 'the actual chunk text' },
    ];

    const sem: NearestChunk[] = [
      { id: chunkId, path: 'memory/MEMORY.md', startLine: 1, endLine: 5, score: 0.9, text: 'the actual chunk text', hash: 'h' },
    ];

    const out = await hybridSearch('q', async () => lex, vectorStore(sem));
    // One fused hit, not two — the matching ids merge.
    expect(out.length).toBe(1);
    expect([...out[0].sources].sort()).toEqual(['lexical', 'semantic']);
    expect(out[0].snippet).toBe('the actual chunk text');
    expect(out[0].lexicalScore).toBe(0.4);
    expect(out[0].semanticScore).toBe(0.9);
  });

  test('a remembered fact surfaces as a fact-source hit, labelled by its key', async () => {
    const { facts } = createTestFactsStore();
    facts.upsert('deploy.target', 'staging');

    const out = await hybridSearch('deploy target', lexicalFn, vectorStore(semanticCorpus), { facts: () => facts.all() });

    const hit = present(out.find((h) => h.id === 'fact:deploy.target'), 'the deploy.target fact hit');

    expect(hit.sources).toEqual(['fact']);
    expect(hit.label).toContain('deploy.target');
    expect(hit.snippet).toBe('staging');
  });

  test('the fact arm degrades like the lexical one when the store throws', async () => {
    const log = createRecordingLogger();
    const restore = setDiagnosticsSink(log);

    try {
      const brokenFacts = (): never => { throw new Error('facts table gone'); };

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
