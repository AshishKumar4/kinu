/**
 * `parse` runs once per file in gates that read the whole corpus, and once per
 * visited module in every closure the ladder derives, so a tree it returned must
 * die with its caller's last reference: kept, 77 closures held 7.4 GB live.
 */
import { expect, test } from 'bun:test';
import { parse } from './syntax';

function parsedAndDropped(): WeakRef<object> {
  return new WeakRef(parse('dropped.ts', 'export const doubled = [1, 2, 3].map((n) => n * 2);\n').root);
}

test('a tree its caller drops is collected', async () => {
  const trees = Array.from({ length: 20 }, parsedAndDropped);

  // A WeakRef keeps its target until the job that made it ends.
  await new Promise((resolve) => setImmediate(resolve));
  Bun.gc(true);

  expect(trees.filter((tree) => tree.deref() !== undefined)).toHaveLength(0);
});
