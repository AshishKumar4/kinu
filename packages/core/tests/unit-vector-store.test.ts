import { describe, test, expect } from 'bun:test';
import {
  reciprocalRankFusion,
  createNoopVectorStore,
  createWorkersAIEmbedder,
} from '../src/index';
import { present, unobservedSpend } from '@kinu.run/test-utils';

describe('reciprocalRankFusion', () => {
  test('returns empty for empty inputs', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[]])).toEqual([]);
  });

  test('single list is preserved in rank order', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const out = reciprocalRankFusion([list]);
    expect(out.map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });

  test('agreement boosts shared items above singletons', () => {
    const lex = [{ id: 'shared' }, { id: 'only-lex' }];
    const sem = [{ id: 'shared' }, { id: 'only-sem' }];
    const out = reciprocalRankFusion([lex, sem]);
    expect(out[0].id).toBe('shared');
    expect(out[0].rrfScore).toBeGreaterThan(out[1].rrfScore);
    expect(out[0].sources.length).toBe(2);
  });

  test('honors custom k constant', () => {
    const list = [{ id: 'a' }, { id: 'b' }];
    const k1 = reciprocalRankFusion([list], 10);
    const k2 = reciprocalRankFusion([list], 1000);
    expect(k1[0].rrfScore).toBeGreaterThan(k2[0].rrfScore);
  });

  test('attaches source items for each hit', () => {
    const lex: ReadonlyArray<{ id: string; kind: string }> = [{ id: 'x', kind: 'lex' }];
    const sem: ReadonlyArray<{ id: string; kind: string }> = [{ id: 'x', kind: 'sem' }, { id: 'y', kind: 'sem' }];
    const out = reciprocalRankFusion([lex, sem]);
    const x = present(out.find((o) => o.id === 'x'), 'the fused entry for x');
    expect(x.sources.length).toBe(2);
    expect(x.sources.map((s: { kind: string }) => s.kind).sort()).toEqual(['lex', 'sem']);
  });
});

describe('createNoopVectorStore', () => {
  test('reports unavailable, fills nothing and finds nothing', async () => {
    const store = createNoopVectorStore();
    expect(store.available).toBe(false);
    await store.fill();
    expect(await store.search('anything')).toEqual([]);
  });
});

describe('createWorkersAIEmbedder', () => {
  test('forwards single embed to ai.run with model + text', async () => {
    const calls: Array<{ model: string; input: { text: string | string[] } }> = [];

    const ai = {
      async run(model: string, input: { text: string | string[] }) {
        calls.push({ model, input });

        return { data: [[0.1, 0.2, 0.3, 0.4]] };
      },
    };

    const embedder = present(createWorkersAIEmbedder({ env: { AI: ai }, report: unobservedSpend }), 'an embedder over a bound AI');
    const vec = await embedder.embed('hello');
    expect(vec).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(calls[0].model).toBe('@cf/baai/bge-small-en-v1.5');
    expect(calls[0].input).toEqual({ text: 'hello' });
  });

  test('embedBatch sends array text + maps response', async () => {
    const ai = {
      async run(_model: string, _input: { text: string | string[] }) {
        return { data: [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]] };
      },
    };

    const embedder = present(createWorkersAIEmbedder({ env: { AI: ai }, report: unobservedSpend }), 'an embedder over a bound AI');
    const embedBatch = embedder.embedBatch?.bind(embedder);

    if (!embedBatch) throw new Error('expected batch embed support');
    const out = await embedBatch(['a', 'b', 'c']);
    expect(out).toEqual([[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]]);
  });

  test('embedBatch falls back to single-embed if response is wrong length', async () => {
    let callCount = 0;

    const ai = {
      async run(_model: string, input: { text: string | string[] }) {
        callCount++;

        // Wrong-length batch result forces the per-text fallback.
        if (Array.isArray(input.text)) return { data: [[0.1, 0.2]] };

        return { data: [[Number(callCount), 0]] };
      },
    };

    const embedder = present(createWorkersAIEmbedder({ env: { AI: ai }, report: unobservedSpend }), 'an embedder over a bound AI');
    const embedBatch = present(embedder.embedBatch?.bind(embedder), 'batch embed support');
    const out = await embedBatch(['a', 'b']);
    expect(out.length).toBe(2);
  });

  test('throws when ai.run returns empty data', async () => {
    const ai = { async run() { return { data: [] }; } };
    const embedder = present(createWorkersAIEmbedder({ env: { AI: ai }, report: unobservedSpend }), 'an embedder over a bound AI');
    await expect(embedder.embed('hello')).rejects.toThrow(/no vector/);
  });
});
