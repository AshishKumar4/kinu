import { describe, expect, test } from 'bun:test';
import { clientEntries, findViolations } from './client-graph';
import { isClientDocument, readMatching, readSources } from './sources';

const ENTRY = 'packages/cf-backend/src/index.tsx';

describe('client-graph — the entry set is derived from the html documents', () => {
  test('each module script becomes an entry beside its document', async () => {
    expect(await clientEntries(new Map([
      ['packages/cf-backend/index.html', '<!doctype html><body><script type="module" src="/src/index.tsx"></script></body>'],
      ['packages/cf-backend/landing.html', '<body><link rel="stylesheet" href="/src/styles.css"><script type="module" src="/src/landing.tsx"></script></body>'],
    ]))).toEqual(['packages/cf-backend/src/index.tsx', 'packages/cf-backend/src/landing.tsx']);
  });

  test('a document with no module script is fatal, never an empty walk', async () => {
    await expect(clientEntries(new Map([['packages/cf-backend/blank.html', '<html></html>']]))).rejects
      .toThrow('declares no <script type="module">');
  });

  test('a new document joins the walk regardless of attribute order or quotes', async () => {
    expect(await clientEntries(new Map([
      ['packages/cf-backend/new.html', "<!-- <script type='module' src='/ignored.ts'></script> --><script src='./src/new.tsx' type='module'></script>"],
    ]))).toEqual(['packages/cf-backend/src/new.tsx']);
  });
});

describe('client-graph — red in every direction it claims', () => {
  test('a worker-only runtime two edges deep is reported with its chain', () => {
    const sources = new Map([
      [ENTRY, "import { store } from './store';\nexport const app = store;"],
      ['packages/cf-backend/src/store.ts', "import { Database } from 'bun:sqlite';\nexport const store = new Database(':memory:');"],
    ]);

    const violations = findViolations(sources, [ENTRY]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.specifier).toBe('bun:sqlite');
    expect(violations[0]?.chain).toEqual([`${ENTRY}:1`, 'packages/cf-backend/src/store.ts:1']);
  });

  test('a value re-export and a literal dynamic import are edges too', () => {
    const sources = new Map([
      [ENTRY, "export { fromCore } from './barrel';\nexport const lazy = () => import('./late');"],
      ['packages/cf-backend/src/barrel.ts', "export { fromCore } from '@agent-core/core';"],
      ['packages/cf-backend/src/late.ts', "import '@agent-core/core/runtime';\nexport const late = 1;"],
    ]);

    expect(findViolations(sources, [ENTRY]).map((violation) => violation.specifier))
      .toEqual(['@agent-core/core', '@agent-core/core/runtime']);
  });

  test('a type-only import carries no runtime edge', () => {
    const sources = new Map([
      [ENTRY, "import type { Core } from '@agent-core/core';\nexport const app: Core | undefined = undefined;"],
    ]);

    expect(findViolations(sources, [ENTRY])).toEqual([]);
  });

  test('a local edge that resolves to nothing is fatal rather than a shorter walk', () => {
    const sources = new Map([[ENTRY, "import { gone } from './gone';\nexport const app = gone;"]]);

    expect(() => findViolations(sources, [ENTRY])).toThrow('resolves to no parsed source');
  });

  test('an entry outside the corpus is fatal, and so is an empty entry set', () => {
    expect(() => findViolations(new Map(), [ENTRY])).toThrow('is not in the corpus');
    expect(() => findViolations(new Map([[ENTRY, 'export const app = 1;']]), [])).toThrow('no client entry');
  });

  test('the live tree walks clean from every derived entry', async () => {
    expect(findViolations(readSources(), await clientEntries(readMatching(isClientDocument)))).toEqual([]);
  });
});
