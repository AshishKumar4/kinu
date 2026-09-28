/**
 * A hybrid search whose only arm fails rejects with that arm's classified failure, and leaves no
 * rejection unhandled: workerd reports one that is handled a microtask late, which the vitest run
 * turns red. Bun does not, so this lives here.
 */
import { describe, expect, test } from 'vitest';
import { hybridSearch, createNoopVectorStore } from '@kinu.run/core';

describe('hybridSearch under workerd', () => {
  test('a lone failed arm rejects with its classified failure', async () => {
    const lexical = async (): Promise<never> => {
      throw new Error('lexical index unreadable');
    };

    await expect(hybridSearch('deploy target', lexical, createNoopVectorStore()))
      .rejects.toMatchObject({ code: 'io', message: 'run the lexical half of a hybrid search' });
  });
});
