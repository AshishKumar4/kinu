// CODE-8 #29: a slate's compiled server names its runtime modules by import; the rewrite reads them as a module does.
import { expect, test } from 'bun:test';
import { moduleSpecifiers } from '../src/utils/module-specifiers';

test('imports, re-exports and literal import() are found; a string that only reads like one is not', () => {
  const code = [
    "import { Slate } from 'kinu:slate';",
    'export * from "capnweb";',
    "const help = `import x from 'kinu:slate'`;",
    'const late = import(`react`);',
    "const named = await import('react-dom/client');",
    "const computed = import(`./${help}`);",
  ].join('\n');

  expect(moduleSpecifiers(code)?.map(({ specifier, start, end }) => [specifier, code.slice(start, end)])).toEqual([
    ['kinu:slate', "'kinu:slate'"],
    ['capnweb', '"capnweb"'],
    ['react', '`react`'],
    ['react-dom/client', "'react-dom/client'"],
  ]);
});

test('code that does not parse as a module names nothing it could rewrite', () => {
  expect(moduleSpecifiers('import { from')).toBeNull();
});
