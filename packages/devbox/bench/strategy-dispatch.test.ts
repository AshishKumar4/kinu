import { describe, expect, test } from 'bun:test';

import { storePrefixOf, strategyIsDeployed, type NamedNamespace } from './strategy-dispatch';

const namespace = (label: string): NamedNamespace => ({
  idFromName: (name) => ({ toString: () => `${label}:${name}` }),
});

const candidateBindings = {
  BENCH_SELECTED_ARMS: 'bounded-layers,merkle-pack',
  BoundedLayersBox: namespace('bounded'),
  MerklePackBox: namespace('merkle'),
};

describe('candidate store prefixes', () => {
  test('uses the bounded-layers Durable Object namespace and bounded subtree', () => {
    expect(storePrefixOf(candidateBindings, 'bounded-layers', 'subject'))
      .toBe('boxes/bounded:bounded-layers:subject/candidate/bounded-layers/');
  });

  test('uses the merkle-pack Durable Object namespace and merkle subtree', () => {
    expect(storePrefixOf(candidateBindings, 'merkle-pack', 'subject'))
      .toBe('boxes/merkle:merkle-pack:subject/candidate/merkle-pack/');
  });

  test('does not dispatch snapshot-chain from a candidates-only fixture', () => {
    expect(strategyIsDeployed(candidateBindings, 'snapshot-chain')).toBe(false);
  });
});
